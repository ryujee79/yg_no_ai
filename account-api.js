(() => {
  const DB_NAME = 'yg-no-ai-github-pages';
  const STORE_NAME = 'kv';
  const baseFetch = window.fetch.bind(window);
  const ADMIN_ID = 'admin';
  const ADMIN_INITIAL_PASSWORD = '17752';

  function now() { return new Date().toISOString(); }
  function normalizeName(value) { return String(value || '').replace(/\s+/g, '').trim(); }
  function normalizeBirth(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 6) {
      const yy = Number(digits.slice(0, 2));
      return `${yy > 30 ? '19' : '20'}${digits}`;
    }
    return digits;
  }
  function cleanStudentNo(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.slice(-4).padStart(4, '0');
  }
  async function digest(value) {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function legacyHash(value) { return digest(`yg-no-ai-github-v1::${value}`); }
  async function passwordHash(role, id, password) {
    return digest(`yg-no-ai-account-v1::${role}::${id}::${String(password)}`);
  }
  function token() { return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, ''); }

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
  async function dbList(prefix) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        if (String(cur.key).startsWith(prefix)) out.push(cur.value);
        cur.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(out); };
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

  async function ensureAdmin() {
    let admin = await dbGet('account/admin');
    if (!admin) {
      admin = {
        id: ADMIN_ID,
        passwordHash: await passwordHash('admin', ADMIN_ID, ADMIN_INITIAL_PASSWORD),
        mustChangePassword: true,
        createdAt: now(),
        updatedAt: now(),
      };
      await dbSet('account/admin', admin);
    }
    return admin;
  }

  async function issueChangeSession(role, id) {
    const t = token();
    await dbSet(`account-change/${await legacyHash(t)}`, {
      role, id, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    return t;
  }
  async function changeSession(changeToken, role) {
    const s = await dbGet(`account-change/${await legacyHash(changeToken || '')}`);
    if (!s || s.role !== role || Date.parse(s.expiresAt) <= Date.now()) throw new Error('비밀번호 변경 인증이 만료되었습니다. 다시 로그인해 주세요.');
    return s;
  }
  async function issueAdminSession() {
    const t = token();
    await dbSet(`account-session/admin/${await legacyHash(t)}`, {
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    });
    return t;
  }
  async function requireAdmin(adminToken) {
    if (!adminToken) throw new Error('관리자 로그인이 필요합니다.');
    const s = await dbGet(`account-session/admin/${await legacyHash(adminToken)}`);
    if (!s || Date.parse(s.expiresAt) <= Date.now()) throw new Error('관리자 로그인 세션이 만료되었습니다.');
    return ensureAdmin();
  }
  async function issueTeacherSession(teacherId) {
    const t = token();
    await dbSet(`session/teacher/${await legacyHash(t)}`, {
      teacherId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    return t;
  }

  async function adminLogin(body) {
    const admin = await ensureAdmin();
    const id = String(body.id || '').trim();
    const password = String(body.password || '');
    if (id !== ADMIN_ID || admin.passwordHash !== await passwordHash('admin', ADMIN_ID, password)) {
      return fail('관리자 아이디 또는 비밀번호가 올바르지 않습니다.', 401);
    }
    if (admin.mustChangePassword) {
      return json({ mustChangePassword: true, changeToken: await issueChangeSession('admin', ADMIN_ID) });
    }
    return json({ token: await issueAdminSession(), id: ADMIN_ID });
  }

  async function changePassword(role, body) {
    const session = await changeSession(body.changeToken, role);
    const next = String(body.newPassword || '');
    if (next.length < 6) return fail('새 비밀번호는 6자 이상으로 설정해 주세요.');
    if (role === 'admin') {
      const admin = await ensureAdmin();
      admin.passwordHash = await passwordHash('admin', ADMIN_ID, next);
      admin.mustChangePassword = false;
      admin.updatedAt = now();
      await dbSet('account/admin', admin);
      return json({ ok: true, token: await issueAdminSession() });
    }
    if (role === 'teacher') {
      const account = await dbGet(`account/teacher/${session.id}`);
      if (!account) return fail('교사 계정을 찾을 수 없습니다.', 404);
      account.passwordHash = await passwordHash('teacher', account.id, next);
      account.mustChangePassword = false;
      account.updatedAt = now();
      await dbSet(`account/teacher/${account.id}`, account);
      return json({ ok: true, token: await issueTeacherSession(account.id), teacher: { id: account.id, name: account.name } });
    }
    const account = await dbGet(`account/student/${session.id}`);
    if (!account) return fail('학생 계정을 찾을 수 없습니다.', 404);
    account.passwordHash = await passwordHash('student', account.studentNo, next);
    account.mustChangePassword = false;
    account.updatedAt = now();
    await dbSet(`account/student/${account.studentNo}`, account);
    return json({ ok: true, studentNo: account.studentNo, name: account.name });
  }

  async function teacherLogin(body) {
    const name = normalizeName(body.name);
    const password = String(body.password ?? body.ext ?? '');
    const idx = await dbGet(`account/teacher-index/${await legacyHash(name)}`);
    if (!idx) return fail('관리자가 등록한 교사 계정이 없습니다.', 401);
    const account = await dbGet(`account/teacher/${idx.teacherId}`);
    if (!account || account.passwordHash !== await passwordHash('teacher', account.id, password)) {
      return fail('이름 또는 비밀번호가 올바르지 않습니다.', 401);
    }
    if (account.mustChangePassword) {
      return json({ mustChangePassword: true, changeToken: await issueChangeSession('teacher', account.id), teacher: { id: account.id, name: account.name } });
    }
    return json({ token: await issueTeacherSession(account.id), teacher: { id: account.id, name: account.name } });
  }

  async function importTeachers(body) {
    await requireAdmin(body.token);
    const raw = Array.isArray(body.teachers) ? body.teachers : [];
    let added = 0, updated = 0, skipped = 0;
    for (const row of raw) {
      const name = normalizeName(row.name);
      const ext = String(row.ext || '').replace(/\D/g, '').slice(-4);
      if (!name || !/^\d{4}$/.test(ext)) { skipped += 1; continue; }
      const idxKey = `account/teacher-index/${await legacyHash(name)}`;
      const existingIdx = await dbGet(idxKey);
      let id = existingIdx?.teacherId;
      let account = id ? await dbGet(`account/teacher/${id}`) : null;
      if (!account) {
        id = crypto.randomUUID();
        account = {
          id, name,
          passwordHash: await passwordHash('teacher', id, ext),
          mustChangePassword: true,
          createdAt: now(), updatedAt: now(),
        };
        added += 1;
      } else {
        account.name = name;
        if (account.mustChangePassword) account.passwordHash = await passwordHash('teacher', id, ext);
        account.updatedAt = now();
        updated += 1;
      }
      await dbSet(`account/teacher/${id}`, account);
      await dbSet(idxKey, { teacherId: id });
      await dbSet(`teacher/${id}`, { id, name, extHash: await legacyHash(ext), createdAt: account.createdAt });
      await dbSet(`teacher-index/${await legacyHash(name)}`, { teacherId: id });
    }
    return json({ ok: true, added, updated, skipped });
  }

  async function importStudents(body) {
    await requireAdmin(body.token);
    const raw = Array.isArray(body.students) ? body.students : [];
    let added = 0, updated = 0, skipped = 0;
    for (const row of raw) {
      const studentNo = cleanStudentNo(row.studentNo);
      const name = normalizeName(row.name);
      const birth = normalizeBirth(row.birth);
      if (!/^\d{4}$/.test(studentNo) || !name || birth.length !== 8) { skipped += 1; continue; }
      let account = await dbGet(`account/student/${studentNo}`);
      if (!account) {
        account = {
          studentNo, name, birth,
          passwordHash: await passwordHash('student', studentNo, birth),
          mustChangePassword: true,
          createdAt: now(), updatedAt: now(),
        };
        added += 1;
      } else {
        account.name = name;
        account.birth = birth;
        if (account.mustChangePassword) account.passwordHash = await passwordHash('student', studentNo, birth);
        account.updatedAt = now();
        updated += 1;
      }
      await dbSet(`account/student/${studentNo}`, account);
    }
    return json({ ok: true, added, updated, skipped });
  }

  async function adminTeachers(url) {
    await requireAdmin(url.searchParams.get('token') || '');
    const rows = await dbList('account/teacher/');
    rows.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return json(rows.map((a) => ({ id: a.id, name: a.name, mustChangePassword: a.mustChangePassword, updatedAt: a.updatedAt })));
  }
  async function adminStudents(url) {
    await requireAdmin(url.searchParams.get('token') || '');
    const rows = await dbList('account/student/');
    rows.sort((a, b) => a.studentNo.localeCompare(b.studentNo));
    return json(rows.map((a) => ({ studentNo: a.studentNo, name: a.name, mustChangePassword: a.mustChangePassword, updatedAt: a.updatedAt })));
  }
  async function adminSummary(url) {
    await requireAdmin(url.searchParams.get('token') || '');
    const teachers = await dbList('account/teacher/');
    const students = await dbList('account/student/');
    return json({
      teachers: teachers.length,
      students: students.length,
      teacherFirstLoginPending: teachers.filter((x) => x.mustChangePassword).length,
      studentFirstLoginPending: students.filter((x) => x.mustChangePassword).length,
    });
  }

  async function studentEnter(body) {
    const studentNo = cleanStudentNo(body.studentNo);
    const password = String(body.password ?? body.credential ?? '');
    const account = await dbGet(`account/student/${studentNo}`);
    if (!account) return fail('관리자가 등록한 학생 계정이 없습니다.', 401);
    if (account.passwordHash !== await passwordHash('student', account.studentNo, account.mustChangePassword ? normalizeBirth(password) : password)) {
      return fail('학번 또는 비밀번호가 올바르지 않습니다.', 401);
    }
    if (account.mustChangePassword) {
      return json({ mustChangePassword: true, changeToken: await issueChangeSession('student', account.studentNo), studentName: account.name });
    }
    const roomResp = await baseFetch('/api/student/find-room', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: body.code }),
    });
    const roomInfo = await roomResp.json().catch(() => ({}));
    if (!roomResp.ok) return json(roomInfo, roomResp.status);
    let credential = account.name;
    if (roomInfo.authMode === 'birth') credential = account.birth;
    const resp = await baseFetch('/api/student/enter', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: body.code, studentNo: account.studentNo, credential }),
    });
    const data = await resp.json().catch(() => ({}));
    return json(data, resp.status);
  }

  window.fetch = async function accountAwareFetch(input, init = {}) {
    const target = typeof input === 'string' ? input : input?.url;
    let url;
    try { url = new URL(target, location.href); } catch { return baseFetch(input, init); }
    if (!url.pathname.includes('/api/')) return baseFetch(input, init);
    const path = url.pathname.slice(url.pathname.indexOf('/api/') + 4) || '/';
    const method = String(init.method || 'GET').toUpperCase();
    const body = await parseBody(init);
    try {
      if (method === 'POST' && path === '/admin/login') return adminLogin(body);
      if (method === 'POST' && path === '/admin/change-password') return changePassword('admin', body);
      if (method === 'POST' && path === '/admin/import-teachers') return importTeachers(body);
      if (method === 'POST' && path === '/admin/import-students') return importStudents(body);
      if (method === 'GET' && path === '/admin/teachers') return adminTeachers(url);
      if (method === 'GET' && path === '/admin/students') return adminStudents(url);
      if (method === 'GET' && path === '/admin/summary') return adminSummary(url);
      if (method === 'POST' && path === '/teacher/login') return teacherLogin(body);
      if (method === 'POST' && path === '/teacher/register') return fail('교사 계정은 관리자가 등록합니다.', 403);
      if (method === 'POST' && path === '/teacher/change-password') return changePassword('teacher', body);
      if (method === 'POST' && path === '/student/enter') return studentEnter(body);
      if (method === 'POST' && path === '/student/change-password') return changePassword('student', body);
      return baseFetch(input, init);
    } catch (error) {
      return fail(error instanceof Error ? error.message : '계정 처리 중 오류가 발생했습니다.', 500);
    }
  };

  ensureAdmin().catch(console.error);
})();
