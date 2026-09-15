(() => {
  const DB_NAME = 'yg-no-ai-github-pages';
  const STORE_NAME = 'kv';
  const previousFetch = window.fetch.bind(window);
  const APP_NAME = '양곡고 No AI 평가센터';

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const cleanStudentNo = (value) => String(value || '').replace(/\D/g, '').slice(-4).padStart(4, '0');
  const normalizeName = (value) => String(value || '').replace(/\s+/g, '').trim();
  const normalizeBirth = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 6) {
      const yy = Number(digits.slice(0, 2));
      return `${yy > 30 ? '19' : '20'}${digits}`;
    }
    return digits;
  };
  const now = () => new Date().toISOString();

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
  async function dbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
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
        if (String(cur.key).startsWith(prefix)) out.push({ key: String(cur.key), value: cur.value });
        cur.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(out); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  async function dbDeleteWhere(prefix, predicate = null) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const key = String(cur.key);
        if (key.startsWith(prefix) && (!predicate || predicate(cur.value, key))) cur.delete();
        cur.continue();
      };
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
  async function requireAdmin(token) {
    if (!token) throw new Error('관리자 로그인이 필요합니다.');
    const session = await dbGet(`account-session/admin/${await legacyHash(token)}`);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) throw new Error('관리자 로그인 세션이 만료되었습니다.');
  }

  async function upsertTeacher(row, preserveChangedPassword = true) {
    const name = normalizeName(row.name);
    const ext = String(row.ext || '').replace(/\D/g, '').slice(-4);
    if (!name || !/^\d{4}$/.test(ext)) return { skipped: 1 };
    const indexKey = `account/teacher-index/${await legacyHash(name)}`;
    const index = await dbGet(indexKey);
    let account = index?.teacherId ? await dbGet(`account/teacher/${index.teacherId}`) : null;
    let added = 0, updated = 0;
    if (!account) {
      const id = crypto.randomUUID();
      account = { id, name, passwordHash: await passwordHash('teacher', id, ext), mustChangePassword: true, createdAt: now(), updatedAt: now() };
      added = 1;
    } else {
      account.name = name;
      if (!preserveChangedPassword || account.mustChangePassword) {
        account.passwordHash = await passwordHash('teacher', account.id, ext);
        account.mustChangePassword = true;
      }
      account.updatedAt = now();
      updated = 1;
    }
    await dbSet(`account/teacher/${account.id}`, account);
    await dbSet(indexKey, { teacherId: account.id });
    await dbSet(`teacher/${account.id}`, { id: account.id, name, extHash: await legacyHash(ext), createdAt: account.createdAt });
    await dbSet(`teacher-index/${await legacyHash(name)}`, { teacherId: account.id });
    return { added, updated, skipped: 0 };
  }

  async function upsertStudent(row, preserveChangedPassword = true) {
    const studentNo = cleanStudentNo(row.studentNo);
    const name = normalizeName(row.name);
    const birth = normalizeBirth(row.birth || '');
    if (!/^\d{4}$/.test(studentNo) || !name) return { skipped: 1 };
    let account = await dbGet(`account/student/${studentNo}`);
    let added = 0, updated = 0;
    if (!account) {
      account = {
        studentNo, name, birth,
        passwordHash: await passwordHash('student', studentNo, studentNo),
        mustChangePassword: true,
        createdAt: now(), updatedAt: now(),
      };
      added = 1;
    } else {
      account.name = name;
      if (birth) account.birth = birth;
      if (!preserveChangedPassword || account.mustChangePassword) {
        account.passwordHash = await passwordHash('student', studentNo, studentNo);
        account.mustChangePassword = true;
      }
      account.updatedAt = now();
      updated = 1;
    }
    await dbSet(`account/student/${studentNo}`, account);
    return { added, updated, skipped: 0 };
  }

  async function importMany(role, body, replaceAll = false) {
    await requireAdmin(body.token);
    const rows = Array.isArray(role === 'teacher' ? body.teachers : body.students)
      ? (role === 'teacher' ? body.teachers : body.students) : [];
    if (!rows.length) return fail('등록할 명단이 없습니다.');
    if (replaceAll) await deleteAll(role, body.token, false);
    let added = 0, updated = 0, skipped = 0;
    for (const row of rows) {
      const result = role === 'teacher'
        ? await upsertTeacher(row, !replaceAll)
        : await upsertStudent(row, !replaceAll);
      added += result.added || 0;
      updated += result.updated || 0;
      skipped += result.skipped || 0;
    }
    return json({ ok: true, added, updated, skipped });
  }

  async function addOne(role, body) {
    await requireAdmin(body.token);
    if (role === 'teacher') {
      const name = normalizeName(body.name);
      const existing = await dbGet(`account/teacher-index/${await legacyHash(name)}`);
      if (existing) return fail('이미 등록된 교사입니다.');
      const result = await upsertTeacher({ name, ext: body.ext }, false);
      if (result.skipped) return fail('이름과 내선번호 4자리를 확인해 주세요.');
      return json({ ok: true });
    }
    const studentNo = cleanStudentNo(body.studentNo);
    if (await dbGet(`account/student/${studentNo}`)) return fail('이미 등록된 학생입니다.');
    const result = await upsertStudent({ studentNo, name: body.name, birth: body.birth }, false);
    if (result.skipped) return fail('학번 4자리와 이름을 확인해 주세요.');
    return json({ ok: true });
  }

  async function deleteOne(role, body) {
    await requireAdmin(body.token);
    if (role === 'teacher') {
      const account = await dbGet(`account/teacher/${body.id}`);
      if (!account) return fail('교사 계정을 찾을 수 없습니다.', 404);
      await dbDelete(`account/teacher/${account.id}`);
      await dbDelete(`account/teacher-index/${await legacyHash(account.name)}`);
      await dbDelete(`teacher/${account.id}`);
      await dbDelete(`teacher-index/${await legacyHash(account.name)}`);
      await dbDeleteWhere('session/teacher/', (v) => v?.teacherId === account.id);
      return json({ ok: true });
    }
    const studentNo = cleanStudentNo(body.studentNo);
    if (!(await dbGet(`account/student/${studentNo}`))) return fail('학생 계정을 찾을 수 없습니다.', 404);
    await dbDelete(`account/student/${studentNo}`);
    await dbDeleteWhere('account-session/student/', (v) => v?.studentNo === studentNo);
    return json({ ok: true });
  }

  async function deleteAll(role, token, checkAuth = true) {
    if (checkAuth) await requireAdmin(token);
    if (role === 'teacher') {
      await dbDeleteWhere('account/teacher/');
      await dbDeleteWhere('account/teacher-index/');
      await dbDeleteWhere('teacher/');
      await dbDeleteWhere('teacher-index/');
      await dbDeleteWhere('session/teacher/');
    } else {
      await dbDeleteWhere('account/student/');
      await dbDeleteWhere('account-session/student/');
    }
    return json({ ok: true });
  }

  async function migrateStudentInitialPasswords() {
    const rows = await dbList('account/student/');
    for (const { value: account } of rows) {
      if (!account?.studentNo || !account.mustChangePassword) continue;
      account.passwordHash = await passwordHash('student', account.studentNo, account.studentNo);
      account.updatedAt = now();
      await dbSet(`account/student/${account.studentNo}`, account);
    }
  }

  window.fetch = async function adminV3Fetch(input, init = {}) {
    const target = typeof input === 'string' ? input : input?.url;
    let url;
    try { url = new URL(target, location.href); } catch { return previousFetch(input, init); }
    if (!url.pathname.includes('/api/')) return previousFetch(input, init);
    const path = url.pathname.slice(url.pathname.indexOf('/api/') + 4) || '/';
    const method = String(init.method || 'GET').toUpperCase();
    const body = await parseBody(init);
    try {
      if (method === 'POST' && path === '/admin/import-students') return importMany('student', body, false);
      if (method === 'POST' && path === '/admin/replace-students') return importMany('student', body, true);
      if (method === 'POST' && path === '/admin/replace-teachers') return importMany('teacher', body, true);
      if (method === 'POST' && path === '/admin/add-student') return addOne('student', body);
      if (method === 'POST' && path === '/admin/add-teacher') return addOne('teacher', body);
      if (method === 'POST' && path === '/admin/delete-student') return deleteOne('student', body);
      if (method === 'POST' && path === '/admin/delete-teacher') return deleteOne('teacher', body);
      if (method === 'POST' && path === '/admin/delete-all-students') return deleteAll('student', body.token, true);
      if (method === 'POST' && path === '/admin/delete-all-teachers') return deleteAll('teacher', body.token, true);
      return previousFetch(input, init);
    } catch (error) {
      return fail(error instanceof Error ? error.message : '계정 처리 중 오류가 발생했습니다.', 500);
    }
  };

  function notify(message, error = false) {
    const el = document.getElementById('toast');
    if (!el) return alert(message);
    el.textContent = message;
    el.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(el._v3timer);
    el._v3timer = setTimeout(() => { el.className = 'toast'; }, 2800);
  }
  async function api(path, options = {}) {
    const res = await fetch(`/api${path}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '요청 처리 중 오류가 발생했습니다.');
    return data;
  }

  function applyBranding() {
    document.title = APP_NAME;
    document.querySelectorAll('.brand h1').forEach((el) => {
      if (el.textContent.trim() === '양곡 온라인 시험실') el.textContent = APP_NAME;
    });
    document.querySelectorAll('.brand small').forEach((el) => {
      const text = el.textContent.trim();
      if (text === '양곡 온라인 시험실') el.textContent = APP_NAME;
      if (text === '시험지 · 시험방 · 응시기록') el.remove();
    });
    const hero = document.querySelector('.hero');
    if (hero) {
      const h1 = hero.querySelector('h1');
      const p = hero.querySelector('p');
      if (h1) h1.textContent = 'AI는 잠시 OFF, 내 생각은 ON';
      if (p) p.textContent = '직접 생각하고 직접 답하는 양곡고 온라인 평가 공간';
    }
    document.querySelectorAll('.auth-wrap .notice').forEach((el) => {
      if (/최초 비밀번호|관리자의 최초 비밀번호|교사의 최초 비밀번호/.test(el.textContent || '')) el.remove();
    });
    document.querySelectorAll('.auth-wrap .muted').forEach((el) => {
      if ((el.textContent || '').includes('교사는 이름과 비밀번호로')) el.textContent = '이름과 비밀번호를 입력하세요.';
    });
  }

  function rowsFromFile(file) {
    return file.arrayBuffer().then((buffer) => {
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    });
  }
  const norm = (v) => String(v ?? '').replace(/\s+/g, '').toLowerCase();
  function headerIndex(row, names) {
    const normalized = row.map(norm);
    return normalized.findIndex((cell) => names.some((name) => cell === norm(name)));
  }
  function findHeader(rows, spec) {
    for (let r = 0; r < Math.min(rows.length, 20); r += 1) {
      const indices = {};
      let ok = true;
      for (const [key, names] of Object.entries(spec)) {
        indices[key] = headerIndex(rows[r], names);
        if (indices[key] < 0 && key !== 'birth') ok = false;
      }
      if (ok) return { row: r, indices };
    }
    throw new Error('필수 헤더를 찾지 못했습니다.');
  }
  function parseTeachers(rows) {
    const h = findHeader(rows, { name: ['이름','성명','교사명'], ext: ['내선번호','내선','내선번호4자리','extension','ext'] });
    return rows.slice(h.row + 1).map((row) => ({
      name: String(row[h.indices.name] || '').trim(),
      ext: String(row[h.indices.ext] || '').replace(/\D/g, '').slice(-4),
    })).filter((x) => x.name && /^\d{4}$/.test(x.ext));
  }
  function parseStudents(rows) {
    const h = findHeader(rows, { studentNo: ['학번','학생학번','학생번호'], name: ['이름','성명','학생명'], birth: ['생년월일','생년','생일','birth','birthday'] });
    return rows.slice(h.row + 1).map((row) => ({
      studentNo: String(row[h.indices.studentNo] || '').replace(/\D/g, '').slice(-4),
      name: String(row[h.indices.name] || '').trim(),
      birth: h.indices.birth >= 0 ? String(row[h.indices.birth] || '').replace(/\D/g, '') : '',
    })).filter((x) => /^\d{4}$/.test(x.studentNo) && x.name);
  }

  let renderingAdmin = false;
  async function renderAdminV3() {
    const topTitle = document.querySelector('.topbar h1')?.textContent.trim();
    if (topTitle !== '관리자 설정' || renderingAdmin) return;
    const main = document.querySelector('main.container');
    if (!main || main.dataset.adminV3 === '1') return;
    const token = localStorage.getItem('ygAdminToken') || '';
    if (!token) return;
    renderingAdmin = true;
    try {
      const [summary, teachers, students] = await Promise.all([
        api(`/admin/summary?token=${encodeURIComponent(token)}`),
        api(`/admin/teachers?token=${encodeURIComponent(token)}`),
        api(`/admin/students?token=${encodeURIComponent(token)}`),
      ]);
      main.dataset.adminV3 = '1';
      main.innerHTML = `
        <div class="grid-2" style="margin-bottom:18px">
          <section class="card"><h3 style="margin-top:0">교사 계정</h3><div style="font-size:30px;font-weight:800">${summary.teachers}명</div></section>
          <section class="card"><h3 style="margin-top:0">학생 계정</h3><div style="font-size:30px;font-weight:800">${summary.students}명</div></section>
        </div>
        <div class="grid-2">
          <section class="card">
            <h3 style="margin-top:0">교사 개별 추가</h3>
            <div class="form-grid"><label>이름<input id="v3-teacher-name"></label><label>내선번호<input id="v3-teacher-ext" maxlength="4" inputmode="numeric"></label><button class="primary" id="v3-add-teacher">추가</button></div>
          </section>
          <section class="card">
            <h3 style="margin-top:0">학생 개별 추가</h3>
            <div class="form-grid"><label>학번<input id="v3-student-no" maxlength="4" inputmode="numeric"></label><label>이름<input id="v3-student-name"></label><label>생년월일<input id="v3-student-birth" inputmode="numeric" placeholder="선택 입력"></label><button class="primary" id="v3-add-student">추가</button></div>
          </section>
        </div>
        <div class="grid-2" style="margin-top:18px">
          <section class="card">
            <h3 style="margin-top:0">교사 명단 파일</h3>
            <input id="v3-teacher-file" type="file" accept=".xlsx,.xls,.csv"><div id="v3-teacher-preview" class="muted" style="margin:10px 0"></div>
            <div class="form-row"><button class="primary" id="v3-import-teachers" disabled>추가·갱신</button><button class="secondary" id="v3-replace-teachers" disabled>전체 교체 등록</button><button class="danger" id="v3-delete-all-teachers">교사 전체 삭제</button></div>
          </section>
          <section class="card">
            <h3 style="margin-top:0">학생 명단 파일</h3>
            <input id="v3-student-file" type="file" accept=".xlsx,.xls,.csv"><div id="v3-student-preview" class="muted" style="margin:10px 0"></div>
            <div class="form-row"><button class="primary" id="v3-import-students" disabled>추가·갱신</button><button class="secondary" id="v3-replace-students" disabled>전체 교체 등록</button><button class="danger" id="v3-delete-all-students">학생 전체 삭제</button></div>
          </section>
        </div>
        <div class="grid-2" style="margin-top:18px">
          <section class="card"><div class="section-head"><h3>교사 목록</h3><span class="muted">${teachers.length}명</span></div><div class="table-wrap"><table><thead><tr><th>이름</th><th>상태</th><th></th></tr></thead><tbody>${teachers.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.mustChangePassword ? '비밀번호 변경 전' : '사용 중'}</td><td><button class="danger v3-delete-teacher" data-id="${esc(t.id)}" data-name="${esc(t.name)}">삭제</button></td></tr>`).join('') || '<tr><td colspan="3">등록된 교사가 없습니다.</td></tr>'}</tbody></table></div></section>
          <section class="card"><div class="section-head"><h3>학생 목록</h3><span class="muted">${students.length}명</span></div><div class="table-wrap"><table><thead><tr><th>학번</th><th>이름</th><th>상태</th><th></th></tr></thead><tbody>${students.map((s) => `<tr><td>${esc(s.studentNo)}</td><td>${esc(s.name)}</td><td>${s.mustChangePassword ? '비밀번호 변경 전' : '사용 중'}</td><td><button class="danger v3-delete-student" data-no="${esc(s.studentNo)}" data-name="${esc(s.name)}">삭제</button></td></tr>`).join('') || '<tr><td colspan="4">등록된 학생이 없습니다.</td></tr>'}</tbody></table></div></section>
        </div>`;
      bindAdminV3(token);
    } catch (error) {
      notify(error.message, true);
    } finally {
      renderingAdmin = false;
    }
  }

  function rerenderAdmin() {
    const main = document.querySelector('main.container');
    if (main) main.dataset.adminV3 = '';
    renderAdminV3();
  }

  function bindAdminV3(token) {
    let teacherRows = null;
    let studentRows = null;
    const tf = document.getElementById('v3-teacher-file');
    const sf = document.getElementById('v3-student-file');
    tf.onchange = async () => {
      try {
        teacherRows = parseTeachers(await rowsFromFile(tf.files[0]));
        document.getElementById('v3-teacher-preview').textContent = `${teacherRows.length}명 인식`;
        document.getElementById('v3-import-teachers').disabled = !teacherRows.length;
        document.getElementById('v3-replace-teachers').disabled = !teacherRows.length;
      } catch (e) { notify(e.message, true); }
    };
    sf.onchange = async () => {
      try {
        studentRows = parseStudents(await rowsFromFile(sf.files[0]));
        document.getElementById('v3-student-preview').textContent = `${studentRows.length}명 인식`;
        document.getElementById('v3-import-students').disabled = !studentRows.length;
        document.getElementById('v3-replace-students').disabled = !studentRows.length;
      } catch (e) { notify(e.message, true); }
    };
    document.getElementById('v3-add-teacher').onclick = async () => {
      try {
        await api('/admin/add-teacher', { method: 'POST', body: { token, name: document.getElementById('v3-teacher-name').value, ext: document.getElementById('v3-teacher-ext').value } });
        notify('교사를 추가했습니다.'); rerenderAdmin();
      } catch (e) { notify(e.message, true); }
    };
    document.getElementById('v3-add-student').onclick = async () => {
      try {
        await api('/admin/add-student', { method: 'POST', body: { token, studentNo: document.getElementById('v3-student-no').value, name: document.getElementById('v3-student-name').value, birth: document.getElementById('v3-student-birth').value } });
        notify('학생을 추가했습니다.'); rerenderAdmin();
      } catch (e) { notify(e.message, true); }
    };
    document.getElementById('v3-import-teachers').onclick = async () => {
      try { const r = await api('/admin/import-teachers', { method: 'POST', body: { token, teachers: teacherRows } }); notify(`교사 ${r.added + r.updated}명 반영`); rerenderAdmin(); } catch (e) { notify(e.message, true); }
    };
    document.getElementById('v3-import-students').onclick = async () => {
      try { const r = await api('/admin/import-students', { method: 'POST', body: { token, students: studentRows } }); notify(`학생 ${r.added + r.updated}명 반영`); rerenderAdmin(); } catch (e) { notify(e.message, true); }
    };
    document.getElementById('v3-replace-teachers').onclick = async () => {
      if (!confirm('기존 교사 계정을 모두 지우고 이 파일의 명단으로 새로 등록할까요?')) return;
      try { const r = await api('/admin/replace-teachers', { method: 'POST', body: { token, teachers: teacherRows } }); notify(`교사 ${r.added}명으로 교체했습니다.`); rerenderAdmin(); } catch (e) { notify(e.message, true); }
    };
    document.getElementById('v3-replace-students').onclick = async () => {
      if (!confirm('기존 학생 계정을 모두 지우고 이 파일의 명단으로 새로 등록할까요?')) return;
      try { const r = await api('/admin/replace-students', { method: 'POST', body: { token, students: studentRows } }); notify(`학생 ${r.added}명으로 교체했습니다.`); rerenderAdmin(); } catch (e) { notify(e.message, true); }
    };
    document.getElementById('v3-delete-all-teachers').onclick = async () => {
      if (!confirm('등록된 교사 계정을 모두 삭제할까요?')) return;
      try { await api('/admin/delete-all-teachers', { method: 'POST', body: { token } }); notify('교사 계정을 모두 삭제했습니다.'); rerenderAdmin(); } catch (e) { notify(e.message, true); }
    };
    document.getElementById('v3-delete-all-students').onclick = async () => {
      if (!confirm('등록된 학생 계정을 모두 삭제할까요?')) return;
      try { await api('/admin/delete-all-students', { method: 'POST', body: { token } }); notify('학생 계정을 모두 삭제했습니다.'); rerenderAdmin(); } catch (e) { notify(e.message, true); }
    };
    document.querySelectorAll('.v3-delete-teacher').forEach((btn) => btn.onclick = async () => {
      if (!confirm(`${btn.dataset.name} 교사 계정을 삭제할까요?`)) return;
      try { await api('/admin/delete-teacher', { method: 'POST', body: { token, id: btn.dataset.id } }); notify('삭제했습니다.'); rerenderAdmin(); } catch (e) { notify(e.message, true); }
    });
    document.querySelectorAll('.v3-delete-student').forEach((btn) => btn.onclick = async () => {
      if (!confirm(`${btn.dataset.no} ${btn.dataset.name} 학생 계정을 삭제할까요?`)) return;
      try { await api('/admin/delete-student', { method: 'POST', body: { token, studentNo: btn.dataset.no } }); notify('삭제했습니다.'); rerenderAdmin(); } catch (e) { notify(e.message, true); }
    });
  }

  const observer = new MutationObserver(() => {
    applyBranding();
    renderAdminV3();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  applyBranding();
  migrateStudentInitialPasswords().catch(console.error);
})();