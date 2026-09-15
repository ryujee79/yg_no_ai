(() => {
  const DB_NAME = 'yg-no-ai-github-pages';
  const STORE_NAME = 'kv';
  const previousFetch = window.fetch.bind(window);

  const now = () => new Date().toISOString();
  const cleanStudentNo = (value) => String(value || '').replace(/\D/g, '').slice(-4).padStart(4, '0');
  const randomToken = () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');

  async function digest(value) {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function legacyHash(value) { return digest(`yg-no-ai-github-v1::${value}`); }
  async function passwordHash(role, id, password) {
    return digest(`yg-no-ai-account-v1::${role}::${id}::${String(password)}`);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('브라우저 저장소를 열 수 없습니다.'));
    });
  }
  async function dbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }
  async function dbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
  function fail(message, status = 400) { return json({ error: message }, status); }
  async function parseBody(init) {
    if (!init?.body) return {};
    if (typeof init.body === 'string') {
      try { return JSON.parse(init.body); } catch { return {}; }
    }
    return init.body || {};
  }

  async function issueAccountSession(account) {
    const t = randomToken();
    await dbSet(`account-session/student/${await legacyHash(t)}`, {
      studentNo: account.studentNo,
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    });
    return t;
  }

  async function requireStudentAccount(accountToken) {
    if (!accountToken) throw new Error('학생 로그인이 필요합니다.');
    const session = await dbGet(`account-session/student/${await legacyHash(accountToken)}`);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) throw new Error('학생 로그인 세션이 만료되었습니다. 다시 로그인해 주세요.');
    const account = await dbGet(`account/student/${session.studentNo}`);
    if (!account) throw new Error('학생 계정을 찾을 수 없습니다.');
    return account;
  }

  async function studentLogin(body) {
    const studentNo = cleanStudentNo(body.studentNo);
    const password = String(body.password || '');
    const account = await dbGet(`account/student/${studentNo}`);
    if (!account) return fail('관리자가 등록한 학생 계정이 없습니다.', 401);
    const candidate = account.mustChangePassword ? String(password).replace(/\D/g, '') : password;
    if (account.passwordHash !== await passwordHash('student', account.studentNo, candidate)) {
      return fail('학번 또는 비밀번호가 올바르지 않습니다.', 401);
    }
    if (account.mustChangePassword) {
      const response = await previousFetch('/api/student/enter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '__LOGIN_ONLY__', studentNo, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (data.mustChangePassword && data.changeToken) {
        return json({ mustChangePassword: true, changeToken: data.changeToken, studentNo, name: account.name });
      }
      // account-api normally returns the change token before checking a room code.
      return fail('최초 비밀번호 변경 인증을 만들 수 없습니다.', 500);
    }
    return json({ token: await issueAccountSession(account), studentNo, name: account.name });
  }

  async function studentMe(url) {
    const account = await requireStudentAccount(url.searchParams.get('token') || '');
    return json({ studentNo: account.studentNo, name: account.name });
  }

  async function findRoomAuthenticated(body) {
    const account = await requireStudentAccount(body.token);
    const code = String(body.code || '').trim().toUpperCase();
    const ref = await dbGet(`room-code/${code}`);
    if (!ref) return fail('접속 코드를 찾을 수 없습니다.', 404);
    const room = await dbGet(`room/${ref.roomId}`);
    if (!room) return fail('시험방 정보를 찾을 수 없습니다.', 404);
    if (room.status === 'ended') return fail('이미 종료된 시험입니다.');
    if (!room.entryOpen) return fail('현재 학생 입장이 차단되어 있습니다.');
    if (room.rosterId) {
      const roster = await dbGet(`roster/${room.rosterId}`);
      const exists = roster?.students?.some((s) => String(s.studentNo) === account.studentNo);
      if (!exists) return fail('이 시험방의 응시 대상 명단에 없는 학생입니다.', 403);
    }
    return json({ code: room.code, title: room.title, durationMin: room.durationMin, requireFullscreen: room.requireFullscreen });
  }

  async function enterAuthenticated(body) {
    const account = await requireStudentAccount(body.token);
    const code = String(body.code || '').trim().toUpperCase();
    const ref = await dbGet(`room-code/${code}`);
    if (!ref) return fail('접속 코드를 찾을 수 없습니다.', 404);
    const room = await dbGet(`room/${ref.roomId}`);
    if (!room) return fail('시험방 정보를 찾을 수 없습니다.', 404);
    if (room.status === 'ended') return fail('이미 종료된 시험입니다.');
    if (!room.entryOpen) return fail('현재 학생 입장이 차단되어 있습니다.');

    let rosterStudent = null;
    if (room.rosterId) {
      const roster = await dbGet(`roster/${room.rosterId}`);
      rosterStudent = roster?.students?.find((s) => String(s.studentNo) === account.studentNo) || null;
      if (!rosterStudent) return fail('이 시험방의 응시 대상 명단에 없는 학생입니다.', 403);
    }

    const attemptKey = `attempt/${room.id}/${account.studentNo}`;
    let attempt = await dbGet(attemptKey);
    if (attempt?.status === 'submitted') return fail('이미 제출이 완료된 시험입니다.');
    if (attempt) {
      attempt.studentName = account.name;
      attempt.lastSeenAt = now();
    } else {
      attempt = {
        id: crypto.randomUUID(), roomId: room.id, studentNo: account.studentNo,
        studentName: account.name, rosterStudent: Boolean(rosterStudent), status: 'entered',
        startedAt: null, submittedAt: null, deadlineAt: null, lastSeenAt: now(),
        violationCount: 0, answers: {}, createdAt: now(),
      };
    }
    await dbSet(attemptKey, attempt);

    const examToken = randomToken();
    await dbSet(`session/student/${await legacyHash(examToken)}`, { roomId: room.id, studentNo: account.studentNo });
    return json({ token: examToken, room: { title: room.title, durationMin: room.durationMin } });
  }

  window.fetch = async function studentPreLoginFetch(input, init = {}) {
    const target = typeof input === 'string' ? input : input?.url;
    let url;
    try { url = new URL(target, location.href); } catch { return previousFetch(input, init); }
    if (!url.pathname.includes('/api/')) return previousFetch(input, init);
    const path = url.pathname.slice(url.pathname.indexOf('/api/') + 4) || '/';
    const method = String(init.method || 'GET').toUpperCase();
    const body = await parseBody(init);
    try {
      if (method === 'POST' && path === '/student/login') return studentLogin(body);
      if (method === 'GET' && path === '/student/account-me') return studentMe(url);
      if (method === 'POST' && path === '/student/find-room-authenticated') return findRoomAuthenticated(body);
      if (method === 'POST' && path === '/student/enter-authenticated') return enterAuthenticated(body);
      return previousFetch(input, init);
    } catch (error) {
      return fail(error instanceof Error ? error.message : '학생 로그인 처리 중 오류가 발생했습니다.', 500);
    }
  };
})();