(() => {
  const DB_NAME = 'yg-no-ai-github-pages';
  const STORE_NAME = 'kv';
  const realFetch = window.fetch.bind(window);

  function now() {
    return new Date().toISOString();
  }

  function normalizeName(value) {
    return String(value || '').replace(/\s+/g, '').trim();
  }

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

  async function sha256(value) {
    const bytes = new TextEncoder().encode(`yg-no-ai-github-v1::${value}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function randomToken() {
    return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
  }

  function randomRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => chars[byte % chars.length]).join('');
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
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  async function dbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  async function dbList(prefix) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const values = [];
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith(prefix)) values.push(cursor.value);
        cursor.continue();
      };
      tx.oncomplete = () => {
        db.close();
        resolve(values);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  async function dbDeletePrefix(prefix, predicate = null) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const key = String(cursor.key);
        if (key.startsWith(prefix) && (!predicate || predicate(cursor.value))) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  function response(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  function fail(message, status = 400) {
    return response({ error: message }, status);
  }

  async function parseBody(init) {
    if (!init?.body) return {};
    if (typeof init.body === 'string') {
      try {
        return JSON.parse(init.body);
      } catch {
        return {};
      }
    }
    return init.body;
  }

  async function teacherFromToken(token) {
    if (!token) throw new Error('교사 로그인이 필요합니다.');
    const session = await dbGet(`session/teacher/${await sha256(token)}`);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      throw new Error('교사 로그인 세션이 만료되었습니다.');
    }
    const teacher = await dbGet(`teacher/${session.teacherId}`);
    if (!teacher) throw new Error('교사 정보를 찾을 수 없습니다.');
    return teacher;
  }

  async function attemptFromToken(token) {
    if (!token) throw new Error('학생 응시 세션이 없습니다.');
    const session = await dbGet(`session/student/${await sha256(token)}`);
    if (!session) throw new Error('학생 응시 세션이 만료되었습니다.');
    const attemptKey = `attempt/${session.roomId}/${session.studentNo}`;
    const attempt = await dbGet(attemptKey);
    const room = await dbGet(`room/${session.roomId}`);
    if (!attempt || !room) throw new Error('응시 정보를 찾을 수 없습니다.');
    return { attempt, room, attemptKey };
  }

  async function issueTeacherSession(teacherId) {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await dbSet(`session/teacher/${await sha256(token)}`, { teacherId, expiresAt });
    return token;
  }

  async function issueStudentSession(roomId, studentNo) {
    const token = randomToken();
    await dbSet(`session/student/${await sha256(token)}`, { roomId, studentNo });
    return token;
  }

  async function uniqueRoomCode() {
    for (let i = 0; i < 20; i += 1) {
      const code = randomRoomCode();
      if (!(await dbGet(`room-code/${code}`))) return code;
    }
    throw new Error('접속 코드 생성에 실패했습니다. 다시 시도해 주세요.');
  }

  async function getRoomByCode(code) {
    const normalized = String(code || '').trim().toUpperCase();
    const ref = await dbGet(`room-code/${normalized}`);
    return ref ? dbGet(`room/${ref.roomId}`) : null;
  }

  async function getTeacherOwnedRoom(token, roomId) {
    const teacher = await teacherFromToken(token);
    const room = await dbGet(`room/${roomId}`);
    if (!room || room.teacherId !== teacher.id) throw new Error('시험방을 찾을 수 없습니다.');
    return { teacher, room };
  }

  async function logEvent(attempt, room, type, detail = '', gapSeconds = null) {
    const event = {
      id: crypto.randomUUID(),
      roomId: room.id,
      attemptId: attempt.id,
      studentNo: attempt.studentNo,
      studentName: attempt.studentName,
      type,
      detail,
      gapSeconds,
      createdAt: now(),
    };
    await dbSet(`event/${room.id}/${Date.now()}-${event.id}`, event);
  }

  async function route(path, method, body, url) {
    if (method === 'GET' && path === '/health') return response({ ok: true, time: now(), mode: 'github-pages-local' });

    if (method === 'POST' && path === '/teacher/register') {
      const name = normalizeName(body.name);
      const ext = String(body.ext || '');
      if (!name) return fail('이름을 입력해 주세요.');
      if (!/^\d{4}$/.test(ext)) return fail('내선번호는 숫자 4자리로 입력해 주세요.');
      const nameHash = await sha256(name);
      if (await dbGet(`teacher-index/${nameHash}`)) return fail('이미 등록된 교사입니다. 로그인해 주세요.');
      const teacher = { id: crypto.randomUUID(), name, extHash: await sha256(ext), createdAt: now() };
      await dbSet(`teacher/${teacher.id}`, teacher);
      await dbSet(`teacher-index/${nameHash}`, { teacherId: teacher.id });
      const token = await issueTeacherSession(teacher.id);
      return response({ token, teacher: { id: teacher.id, name: teacher.name } });
    }

    if (method === 'POST' && path === '/teacher/login') {
      const name = normalizeName(body.name);
      const ext = String(body.ext || '');
      const index = await dbGet(`teacher-index/${await sha256(name)}`);
      if (!index) return fail('이름 또는 내선번호가 올바르지 않습니다.', 401);
      const teacher = await dbGet(`teacher/${index.teacherId}`);
      if (!teacher || teacher.extHash !== (await sha256(ext))) return fail('이름 또는 내선번호가 올바르지 않습니다.', 401);
      const token = await issueTeacherSession(teacher.id);
      return response({ token, teacher: { id: teacher.id, name: teacher.name } });
    }

    if (method === 'POST' && path === '/teacher/me') {
      const teacher = await teacherFromToken(body.token);
      return response({ id: teacher.id, name: teacher.name });
    }

    if (method === 'GET' && path === '/teacher/rosters') {
      const teacher = await teacherFromToken(url.searchParams.get('token') || '');
      const rosters = (await dbList('roster/')).filter((r) => r.teacherId === teacher.id);
      rosters.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return response(rosters.map((r) => ({ ...r, studentCount: r.students.length })));
    }

    if (method === 'POST' && path === '/teacher/rosters') {
      const teacher = await teacherFromToken(body.token);
      const raw = Array.isArray(body.students) ? body.students : [];
      if (!raw.length) return fail('학생 명단에서 학생을 찾지 못했습니다.');
      const students = [];
      for (const student of raw) {
        const studentNo = cleanStudentNo(student.studentNo);
        const name = normalizeName(student.name);
        if (!studentNo || !name) continue;
        const birth = normalizeBirth(student.birth || '');
        students.push({ studentNo, name, birthHash: birth ? await sha256(birth) : null });
      }
      const roster = {
        id: crypto.randomUUID(), teacherId: teacher.id,
        year: Number(body.year) || new Date().getFullYear(),
        grade: Number(body.grade) || 1,
        classNo: Number(body.classNo) || 1,
        label: `${Number(body.year) || new Date().getFullYear()}학년도 ${Number(body.grade) || 1}학년 ${Number(body.classNo) || 1}반`,
        students, createdAt: now(),
      };
      await dbSet(`roster/${roster.id}`, roster);
      return response(roster);
    }

    if (method === 'DELETE' && path === '/teacher/rosters') {
      const teacher = await teacherFromToken(url.searchParams.get('token') || '');
      const id = url.searchParams.get('id') || '';
      const roster = await dbGet(`roster/${id}`);
      if (roster?.teacherId === teacher.id) await dbDelete(`roster/${id}`);
      return response({ ok: true });
    }

    if (method === 'GET' && path === '/teacher/papers') {
      const teacher = await teacherFromToken(url.searchParams.get('token') || '');
      const papers = (await dbList('paper/')).filter((p) => p.teacherId === teacher.id);
      papers.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return response(papers);
    }

    if (method === 'POST' && path === '/teacher/papers') {
      const teacher = await teacherFromToken(body.token);
      const previous = body.id ? await dbGet(`paper/${body.id}`) : null;
      if (previous && previous.teacherId !== teacher.id) return fail('시험지를 찾을 수 없습니다.', 404);
      const id = previous?.id || crypto.randomUUID();
      const questions = (Array.isArray(body.questions) ? body.questions : []).map((q, index) => ({
        id: q.id || crypto.randomUUID(), order: index + 1,
        type: ['essay', 'short', 'long', 'choice5', 'ox'].includes(q.type) ? q.type : 'short',
        prompt: String(q.prompt || ''), choices: Array.isArray(q.choices) ? q.choices.slice(0, 5).map(String) : [],
        points: Number(q.points) || 0,
      }));
      const paper = {
        id, teacherId: teacher.id, year: Number(body.year) || new Date().getFullYear(),
        title: String(body.title || '제목 없는 시험지').trim(), subject: String(body.subject || '').trim(),
        sourceName: body.sourceName || previous?.sourceName || null,
        sourceKey: body.sourceKey || previous?.sourceKey || null,
        questions, createdAt: previous?.createdAt || now(), updatedAt: now(),
      };
      await dbSet(`paper/${id}`, paper);
      return response(paper);
    }

    if (method === 'POST' && path === '/teacher/papers/copy') {
      const teacher = await teacherFromToken(body.token);
      const paper = await dbGet(`paper/${body.id}`);
      if (!paper || paper.teacherId !== teacher.id) return fail('시험지를 찾을 수 없습니다.', 404);
      const copy = {
        ...paper, id: crypto.randomUUID(), title: `${paper.title} (사본)`, createdAt: now(), updatedAt: now(),
        questions: paper.questions.map((q) => ({ ...q, id: crypto.randomUUID() })),
      };
      await dbSet(`paper/${copy.id}`, copy);
      return response(copy);
    }

    if (method === 'DELETE' && path === '/teacher/papers') {
      const teacher = await teacherFromToken(url.searchParams.get('token') || '');
      const id = url.searchParams.get('id') || '';
      const rooms = (await dbList('room/')).filter((room) => room.teacherId === teacher.id);
      if (rooms.some((room) => room.paperId === id)) return fail('이 시험지를 사용하는 시험방이 있어 삭제할 수 없습니다.');
      const paper = await dbGet(`paper/${id}`);
      if (paper?.teacherId === teacher.id) await dbDelete(`paper/${id}`);
      return response({ ok: true });
    }

    if (method === 'POST' && path === '/teacher/file') {
      await teacherFromToken(body.token);
      return response({ key: `github-pages-local://${crypto.randomUUID()}/${String(body.filename || 'file')}` });
    }

    if (method === 'GET' && path === '/teacher/rooms') {
      const teacher = await teacherFromToken(url.searchParams.get('token') || '');
      const rooms = (await dbList('room/')).filter((r) => r.teacherId === teacher.id);
      const result = [];
      for (const room of rooms) {
        const paper = await dbGet(`paper/${room.paperId}`);
        const roster = room.rosterId ? await dbGet(`roster/${room.rosterId}`) : null;
        result.push({ ...room, paperTitle: paper?.title || '', rosterLabel: roster?.label || '' });
      }
      result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return response(result);
    }

    if (method === 'POST' && path === '/teacher/rooms') {
      const teacher = await teacherFromToken(body.token);
      const paper = await dbGet(`paper/${body.paperId}`);
      if (!paper || paper.teacherId !== teacher.id) return fail('시험지를 선택해 주세요.');
      if (body.authMode === 'birth' && !body.rosterId) return fail('생년월일 인증을 사용하려면 학생명단을 선택해야 합니다.');
      const code = await uniqueRoomCode();
      const room = {
        id: crypto.randomUUID(), teacherId: teacher.id, year: Number(body.year) || new Date().getFullYear(),
        paperId: body.paperId, rosterId: body.rosterId || null, code,
        title: String(body.title || paper.title).trim(), durationMin: Math.max(1, Number(body.durationMin) || 50),
        authMode: ['birth', 'name', 'nickname'].includes(body.authMode) ? body.authMode : 'birth',
        requireFullscreen: body.requireFullscreen !== false, status: 'waiting', entryOpen: true, answersLocked: false,
        createdAt: now(), startedAt: null, endedAt: null,
      };
      await dbSet(`room/${room.id}`, room);
      await dbSet(`room-code/${code}`, { roomId: room.id });
      return response(room);
    }

    if (method === 'POST' && path === '/teacher/rooms/clone') {
      const { teacher, room: source } = await getTeacherOwnedRoom(body.token, body.roomId);
      if (source.authMode === 'birth' && !body.rosterId) return fail('생년월일 인증을 사용하려면 학생명단을 선택해야 합니다.');
      const code = await uniqueRoomCode();
      const room = {
        ...source, id: crypto.randomUUID(), code, rosterId: body.rosterId || null,
        title: String(body.title || source.title), status: 'waiting', entryOpen: true, answersLocked: false,
        createdAt: now(), startedAt: null, endedAt: null,
      };
      await dbSet(`room/${room.id}`, room);
      await dbSet(`room-code/${code}`, { roomId: room.id });
      return response(room);
    }

    if (method === 'POST' && path === '/teacher/rooms/update') {
      const { room } = await getTeacherOwnedRoom(body.token, body.roomId);
      const patch = body.patch || {};
      if (typeof patch.entryOpen === 'boolean') room.entryOpen = patch.entryOpen;
      if (typeof patch.answersLocked === 'boolean') room.answersLocked = patch.answersLocked;
      if (patch.status && ['waiting', 'running', 'ended'].includes(patch.status)) {
        room.status = patch.status;
        if (patch.status === 'running' && !room.startedAt) room.startedAt = now();
        if (patch.status === 'ended') {
          room.endedAt = now(); room.entryOpen = false; room.answersLocked = true;
          const attempts = await dbList(`attempt/${room.id}/`);
          for (const attempt of attempts) {
            if (attempt.status !== 'submitted') {
              attempt.status = 'submitted'; attempt.submittedAt = now();
              await dbSet(`attempt/${room.id}/${attempt.studentNo}`, attempt);
            }
          }
        }
      }
      await dbSet(`room/${room.id}`, room);
      return response(room);
    }

    if (method === 'GET' && path === '/teacher/monitor') {
      const { teacher, room } = await getTeacherOwnedRoom(url.searchParams.get('token') || '', url.searchParams.get('roomId') || '');
      const paper = await dbGet(`paper/${room.paperId}`);
      const roster = room.rosterId ? await dbGet(`roster/${room.rosterId}`) : null;
      const attempts = await dbList(`attempt/${room.id}/`);
      const events = await dbList(`event/${room.id}/`);
      events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return response({ room, paper: paper?.teacherId === teacher.id ? paper : null, roster, attempts, events: events.slice(0, 500) });
    }

    if (method === 'POST' && path === '/teacher/reset-attempt') {
      const { room } = await getTeacherOwnedRoom(body.token, body.roomId);
      const studentNo = cleanStudentNo(body.studentNo);
      await dbDelete(`attempt/${room.id}/${studentNo}`);
      await dbDeletePrefix(`event/${room.id}/`, (event) => event?.studentNo === studentNo);
      return response({ ok: true });
    }

    if (method === 'GET' && path === '/teacher/results') {
      const { teacher, room } = await getTeacherOwnedRoom(url.searchParams.get('token') || '', url.searchParams.get('roomId') || '');
      const paper = await dbGet(`paper/${room.paperId}`);
      const roster = room.rosterId ? await dbGet(`roster/${room.rosterId}`) : null;
      const attempts = await dbList(`attempt/${room.id}/`);
      return response({ room, paper: paper?.teacherId === teacher.id ? paper : null, roster, attempts });
    }

    if (method === 'POST' && path === '/student/find-room') {
      const room = await getRoomByCode(body.code);
      if (!room) return fail('접속 코드를 찾을 수 없습니다.', 404);
      return response({ code: room.code, title: room.title, authMode: room.authMode, requireFullscreen: room.requireFullscreen, status: room.status, entryOpen: room.entryOpen, durationMin: room.durationMin });
    }

    if (method === 'POST' && path === '/student/enter') {
      const room = await getRoomByCode(body.code);
      if (!room) return fail('접속 코드를 찾을 수 없습니다.', 404);
      if (room.status === 'ended') return fail('이미 종료된 시험입니다.');
      if (!room.entryOpen) return fail('현재 학생 입장이 차단되어 있습니다.');
      const studentNo = cleanStudentNo(body.studentNo);
      if (!/^\d{4}$/.test(studentNo)) return fail('학번은 숫자 4자리로 입력해 주세요.');
      const roster = room.rosterId ? await dbGet(`roster/${room.rosterId}`) : null;
      const rosterStudent = roster?.students.find((student) => student.studentNo === studentNo) || null;
      if (roster && !rosterStudent) return fail('이 시험방의 학생명단에 없는 학번입니다.');
      const credential = String(body.credential || '');
      let studentName = rosterStudent?.name || normalizeName(credential);
      if (room.authMode === 'birth') {
        if (!rosterStudent?.birthHash) return fail('학생 생년월일 정보가 등록되어 있지 않습니다.');
        if ((await sha256(normalizeBirth(credential))) !== rosterStudent.birthHash) return fail('생년월일이 일치하지 않습니다.', 401);
      } else if (room.authMode === 'name') {
        if (rosterStudent && normalizeName(credential) !== normalizeName(rosterStudent.name)) return fail('이름이 일치하지 않습니다.', 401);
        studentName = rosterStudent?.name || normalizeName(credential);
      } else {
        if (!credential.trim()) return fail('별명을 입력해 주세요.');
        studentName = rosterStudent?.name || credential.trim();
      }
      const attemptKey = `attempt/${room.id}/${studentNo}`;
      let attempt = await dbGet(attemptKey);
      if (attempt?.status === 'submitted') return fail('이미 제출이 완료된 시험입니다.');
      if (attempt) {
        const gap = Math.max(0, Math.round((Date.now() - Date.parse(attempt.lastSeenAt)) / 1000));
        if (gap >= 10) await logEvent(attempt, room, 'reconnect', '재접속', gap);
        attempt.lastSeenAt = now();
      } else {
        attempt = {
          id: crypto.randomUUID(), roomId: room.id, studentNo, studentName,
          rosterStudent: Boolean(rosterStudent), status: 'entered', startedAt: null, submittedAt: null,
          deadlineAt: null, lastSeenAt: now(), violationCount: 0, answers: {}, createdAt: now(),
        };
      }
      await dbSet(attemptKey, attempt);
      return response({ token: await issueStudentSession(room.id, studentNo) });
    }

    if (method === 'GET' && path === '/student/state') {
      const { attempt, room, attemptKey } = await attemptFromToken(url.searchParams.get('token') || '');
      const paper = await dbGet(`paper/${room.paperId}`);
      attempt.lastSeenAt = now();
      await dbSet(attemptKey, attempt);
      const remaining = attempt.deadlineAt ? Math.max(0, Math.ceil((Date.parse(attempt.deadlineAt) - Date.now()) / 1000)) : room.durationMin * 60;
      return response({
        attempt,
        room: { id: room.id, title: room.title, status: room.status, requireFullscreen: room.requireFullscreen, answersLocked: room.answersLocked, durationMin: room.durationMin },
        questions: paper?.questions || [], remaining,
      });
    }

    if (method === 'POST' && path === '/student/start') {
      const { attempt, room, attemptKey } = await attemptFromToken(body.token);
      if (attempt.status === 'submitted') return fail('이미 제출된 시험입니다.');
      if (!attempt.startedAt) {
        attempt.startedAt = now();
        attempt.deadlineAt = new Date(Date.now() + room.durationMin * 60 * 1000).toISOString();
        attempt.status = 'in_progress'; attempt.lastSeenAt = now();
        await dbSet(attemptKey, attempt);
        if (room.status === 'waiting') {
          room.status = 'running'; room.startedAt = room.startedAt || now();
          await dbSet(`room/${room.id}`, room);
        }
      }
      return response({ ok: true });
    }

    if (method === 'POST' && path === '/student/save') {
      const { attempt, room, attemptKey } = await attemptFromToken(body.token);
      if (attempt.status === 'submitted') return response({ ok: false, reason: 'submitted' });
      if (room.status === 'ended' || room.answersLocked) return response({ ok: false, reason: 'locked' });
      if (attempt.deadlineAt && Date.parse(attempt.deadlineAt) <= Date.now()) {
        attempt.status = 'submitted'; attempt.submittedAt = now();
        await dbSet(attemptKey, attempt);
        await logEvent(attempt, room, 'auto_submit', '시간 종료 자동 제출');
        return response({ ok: false, reason: 'expired' });
      }
      if (body.answers && typeof body.answers === 'object') attempt.answers = { ...attempt.answers, ...body.answers };
      attempt.status = 'in_progress'; attempt.lastSeenAt = now();
      await dbSet(attemptKey, attempt);
      return response({ ok: true });
    }

    if (method === 'POST' && path === '/student/submit') {
      const { attempt, room, attemptKey } = await attemptFromToken(body.token);
      if (attempt.status === 'submitted') return response({ ok: true, already: true });
      if (body.answers && typeof body.answers === 'object') attempt.answers = { ...attempt.answers, ...body.answers };
      attempt.status = 'submitted'; attempt.submittedAt = now(); attempt.lastSeenAt = now();
      await dbSet(attemptKey, attempt);
      await logEvent(attempt, room, body.auto ? 'auto_submit' : 'submit', body.auto ? '시간 종료 자동 제출' : '학생 제출');
      return response({ ok: true, already: false });
    }

    if (method === 'POST' && path === '/student/event') {
      const { attempt, room, attemptKey } = await attemptFromToken(body.token);
      attempt.violationCount += 1; attempt.lastSeenAt = now();
      await dbSet(attemptKey, attempt);
      await logEvent(attempt, room, String(body.type || 'unknown'), String(body.detail || ''), Number.isFinite(Number(body.gapSeconds)) ? Number(body.gapSeconds) : null);
      return response({ ok: true });
    }

    if (method === 'POST' && path === '/student/heartbeat') {
      const { attempt, room, attemptKey } = await attemptFromToken(body.token);
      attempt.lastSeenAt = now();
      const expired = Boolean(attempt.deadlineAt && Date.parse(attempt.deadlineAt) <= Date.now());
      if (expired && attempt.status !== 'submitted') {
        attempt.status = 'submitted'; attempt.submittedAt = now();
        await logEvent(attempt, room, 'auto_submit', '시간 종료 자동 제출');
      }
      await dbSet(attemptKey, attempt);
      return response({ expired, attemptStatus: attempt.status, roomStatus: room.status, answersLocked: room.answersLocked });
    }

    return fail('요청 경로를 찾을 수 없습니다.', 404);
  }

  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl, window.location.origin);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const path = url.pathname.replace(/^\/api/, '') || '/';
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    try {
      const body = await parseBody(init);
      return await route(path, method, body, url);
    } catch (error) {
      console.error(error);
      return fail(error instanceof Error ? error.message : '브라우저 저장 오류가 발생했습니다.', 500);
    }
  };

  window.YG_GITHUB_PAGES_LOCAL_MODE = true;
})();
