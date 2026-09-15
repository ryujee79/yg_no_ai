(() => {
  const app = document.getElementById('app');
  let adminToken = localStorage.getItem('ygAdminToken') || '';
  let studentAccountToken = localStorage.getItem('ygStudentAccountToken') || '';
  let studentAccount = null;
  let pendingRoom = null;

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

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

  function topbar(title, right = '') {
    return `<header class="topbar"><div class="brand"><div class="brand-mark">YG</div><div><h1>${esc(title)}</h1><small>양곡 온라인 시험실</small></div></div>${right}</header>`;
  }

  function notify(message, error = false) {
    const el = document.getElementById('toast');
    if (!el) return alert(message);
    el.textContent = message;
    el.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(el._ygTimer);
    el._ygTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
  }

  function customizeTeacherAuth() {
    const input = document.getElementById('teacher-ext');
    if (!input || input.dataset.authV2 === '1') return;
    input.dataset.authV2 = '1';
    input.type = 'password';
    input.removeAttribute('maxlength');
    input.removeAttribute('inputmode');
    input.placeholder = '비밀번호';
    const label = input.closest('label');
    if (label && label.firstChild?.nodeType === Node.TEXT_NODE) label.firstChild.textContent = '비밀번호';
    const nameInput = document.getElementById('teacher-name');
    if (nameInput) {
      nameInput.placeholder = '교사 이름 또는 admin';
      const nameLabel = nameInput.closest('label');
      if (nameLabel && nameLabel.firstChild?.nodeType === Node.TEXT_NODE) nameLabel.firstChild.textContent = '이름 또는 관리자 아이디';
    }
    const register = document.getElementById('teacher-register');
    if (register) register.remove();
    const authWrap = input.closest('.auth-wrap');
    const muted = authWrap?.querySelector('.muted');
    if (muted) muted.textContent = '교사는 이름과 비밀번호로, 관리자는 admin과 관리자 비밀번호로 로그인합니다.';
    const notice = authWrap?.querySelector('.notice');
    if (notice) notice.textContent = '교사의 최초 비밀번호는 내선번호 4자리입니다. 관리자의 최초 비밀번호는 17752이며 첫 로그인에서 새 비밀번호로 변경합니다.';
  }

  function removeAdminEntry() {
    document.getElementById('go-admin-overlay')?.closest('.entry-card')?.remove();
  }

  const observer = new MutationObserver(() => {
    removeAdminEntry();
    customizeTeacherAuth();
    if (sessionStorage.getItem('ygAutoTeacher') === '1') {
      const btn = document.getElementById('go-teacher');
      if (btn) { sessionStorage.removeItem('ygAutoTeacher'); setTimeout(() => btn.click(), 0); }
    }
    if (sessionStorage.getItem('ygAutoResume') === '1') {
      const btn = document.getElementById('resume-exam');
      if (btn) { sessionStorage.removeItem('ygAutoResume'); setTimeout(() => btn.click(), 0); }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => { removeAdminEntry(); customizeTeacherAuth(); }, 0);

  function passwordModal({ title, changeToken, endpoint, onSuccess }) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.65);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
    wrap.innerHTML = `<div class="card" style="width:min(480px,100%);padding:24px"><h2 style="margin-top:0">${esc(title)}</h2><p class="muted">새 비밀번호는 6자 이상으로 설정하세요.</p><div class="form-grid"><label>새 비밀번호<input id="yg-new-password" type="password" autocomplete="new-password"></label><label>새 비밀번호 확인<input id="yg-new-password2" type="password" autocomplete="new-password"></label><button class="primary" id="yg-change-password">비밀번호 변경</button></div></div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('#yg-change-password').onclick = async () => {
      const p1 = wrap.querySelector('#yg-new-password').value;
      const p2 = wrap.querySelector('#yg-new-password2').value;
      if (p1.length < 6) return notify('새 비밀번호는 6자 이상으로 입력해 주세요.', true);
      if (p1 !== p2) return notify('새 비밀번호 확인이 일치하지 않습니다.', true);
      try {
        const result = await api(endpoint, { method: 'POST', body: { changeToken, newPassword: p1 } });
        wrap.remove();
        await onSuccess(result, p1);
      } catch (error) { notify(error.message, true); }
    };
  }

  async function teacherOrAdminLogin() {
    const name = document.getElementById('teacher-name')?.value.trim() || '';
    const password = document.getElementById('teacher-ext')?.value || '';
    if (!name || !password) return notify('이름(또는 admin)과 비밀번호를 입력해 주세요.', true);

    if (name.toLowerCase() === 'admin') {
      try {
        const result = await api('/admin/login', { method: 'POST', body: { id: 'admin', password } });
        if (result.mustChangePassword) {
          passwordModal({
            title: '관리자 최초 비밀번호 변경',
            changeToken: result.changeToken,
            endpoint: '/admin/change-password',
            onSuccess: async (changed) => {
              adminToken = changed.token;
              localStorage.setItem('ygAdminToken', adminToken);
              renderAdminDashboard();
            },
          });
          return;
        }
        adminToken = result.token;
        localStorage.setItem('ygAdminToken', adminToken);
        renderAdminDashboard();
      } catch (error) { notify(error.message, true); }
      return;
    }

    try {
      const result = await api('/teacher/login', { method: 'POST', body: { name, password } });
      if (result.mustChangePassword) {
        passwordModal({
          title: '교사 최초 비밀번호 변경',
          changeToken: result.changeToken,
          endpoint: '/teacher/change-password',
          onSuccess: async (changed) => {
            localStorage.setItem('ygTeacherToken', changed.token);
            sessionStorage.setItem('ygAutoTeacher', '1');
            location.reload();
          },
        });
        return;
      }
      localStorage.setItem('ygTeacherToken', result.token);
      sessionStorage.setItem('ygAutoTeacher', '1');
      location.reload();
    } catch (error) { notify(error.message, true); }
  }

  async function openStudentLogin() {
    if (studentAccountToken) {
      try {
        studentAccount = await api(`/student/account-me?token=${encodeURIComponent(studentAccountToken)}`);
        renderStudentRoomAccess();
        return;
      } catch {
        studentAccountToken = '';
        studentAccount = null;
        localStorage.removeItem('ygStudentAccountToken');
      }
    }
    renderStudentLogin();
  }

  function renderStudentLogin() {
    app.innerHTML = `<div class="app-shell">${topbar('학생 로그인', '<button class="ghost" id="student-login-home">처음으로</button>')}<main class="container"><section class="card auth-wrap"><h2>학생 로그인</h2><p class="muted">시험방을 찾기 전에 학생 계정으로 먼저 로그인합니다.</p><div class="form-grid"><label>학번 4자리<input id="student-account-no" maxlength="4" inputmode="numeric" autocomplete="username" placeholder="3101"></label><label>비밀번호<input id="student-account-password" type="password" autocomplete="current-password" placeholder="비밀번호"></label><button class="primary" id="student-account-login">로그인</button><div class="notice">최초 비밀번호는 관리자에게 등록된 생년월일입니다. 최초 로그인 시 새 비밀번호로 변경해야 합니다.</div></div></section></main></div>`;
    document.getElementById('student-login-home').onclick = () => location.reload();
    document.getElementById('student-account-login').onclick = studentLogin;
  }

  async function studentLogin(passwordOverride = null) {
    const studentNo = document.getElementById('student-account-no')?.value.trim() || '';
    const password = passwordOverride ?? document.getElementById('student-account-password')?.value ?? '';
    if (!/^\d{4}$/.test(studentNo)) return notify('학번 4자리를 입력해 주세요.', true);
    if (!password) return notify('비밀번호를 입력해 주세요.', true);
    try {
      const result = await api('/student/login', { method: 'POST', body: { studentNo, password } });
      if (result.mustChangePassword) {
        passwordModal({
          title: '학생 최초 비밀번호 변경',
          changeToken: result.changeToken,
          endpoint: '/student/change-password',
          onSuccess: async (_changed, newPassword) => {
            const login = await api('/student/login', { method: 'POST', body: { studentNo, password: newPassword } });
            studentAccountToken = login.token;
            studentAccount = { studentNo: login.studentNo, name: login.name };
            localStorage.setItem('ygStudentAccountToken', studentAccountToken);
            renderStudentRoomAccess();
          },
        });
        return;
      }
      studentAccountToken = result.token;
      studentAccount = { studentNo: result.studentNo, name: result.name };
      localStorage.setItem('ygStudentAccountToken', studentAccountToken);
      renderStudentRoomAccess();
    } catch (error) { notify(error.message, true); }
  }

  function renderStudentRoomAccess() {
    pendingRoom = null;
    app.innerHTML = `<div class="app-shell">${topbar('학생 시험방', `<div class="flex"><strong>${esc(studentAccount?.studentNo || '')} ${esc(studentAccount?.name || '')}</strong><button class="ghost" id="student-account-logout">로그아웃</button></div>`)}<main class="container"><section class="card auth-wrap"><h2>시험방 접속</h2><p class="muted">교사가 알려 준 6자리 접속 코드를 입력하세요.</p><div class="form-grid"><label>접속 코드<input id="student-room-code" maxlength="6" autocomplete="off" style="text-transform:uppercase" placeholder="ABC123"></label><button class="primary" id="student-find-room">시험방 찾기</button><div id="student-room-result"></div></div></section></main></div>`;
    document.getElementById('student-account-logout').onclick = () => {
      localStorage.removeItem('ygStudentAccountToken');
      studentAccountToken = '';
      studentAccount = null;
      renderStudentLogin();
    };
    document.getElementById('student-find-room').onclick = findStudentRoom;
  }

  async function findStudentRoom() {
    const code = document.getElementById('student-room-code')?.value.trim().toUpperCase() || '';
    if (!code) return notify('접속 코드를 입력해 주세요.', true);
    try {
      pendingRoom = await api('/student/find-room-authenticated', { method: 'POST', body: { token: studentAccountToken, code } });
      const result = document.getElementById('student-room-result');
      result.innerHTML = `<div class="notice" style="margin:14px 0"><strong>${esc(pendingRoom.title)}</strong><br>제한시간 ${pendingRoom.durationMin}분${pendingRoom.requireFullscreen ? ' · 전체화면 필수' : ''}</div><button class="primary" id="student-enter-room" style="width:100%">이 시험에 입장</button>`;
      document.getElementById('student-enter-room').onclick = () => enterStudentRoom(code);
    } catch (error) { pendingRoom = null; notify(error.message, true); }
  }

  async function enterStudentRoom(code) {
    try {
      const result = await api('/student/enter-authenticated', { method: 'POST', body: { token: studentAccountToken, code } });
      localStorage.setItem('ygStudentToken', result.token);
      sessionStorage.setItem('ygAutoResume', '1');
      location.reload();
    } catch (error) { notify(error.message, true); }
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest?.('button');
    if (!target) return;
    if (target.id === 'teacher-login') {
      event.preventDefault();
      event.stopImmediatePropagation();
      teacherOrAdminLogin();
      return;
    }
    if (target.id === 'go-student') {
      event.preventDefault();
      event.stopImmediatePropagation();
      openStudentLogin();
    }
  }, true);

  async function renderAdminDashboard() {
    try {
      const [summary, teachers, students] = await Promise.all([
        api(`/admin/summary?token=${encodeURIComponent(adminToken)}`),
        api(`/admin/teachers?token=${encodeURIComponent(adminToken)}`),
        api(`/admin/students?token=${encodeURIComponent(adminToken)}`),
      ]);
      app.innerHTML = `<div class="app-shell">${topbar('관리자 설정', '<div class="flex"><strong>admin</strong><button class="danger" id="admin-logout">로그아웃</button></div>')}<main class="container">
        <div class="notice" style="margin-bottom:18px">관리자가 교사·학생 기본 계정을 등록합니다. 교사와 학생은 최초 로그인에서 비밀번호를 변경합니다.</div>
        <div class="grid-2" style="margin-bottom:18px">
          <section class="card"><h3 style="margin-top:0">교사 계정</h3><div style="font-size:30px;font-weight:800">${summary.teachers}명</div><div class="muted">최초 로그인 전 ${summary.teacherFirstLoginPending}명</div></section>
          <section class="card"><h3 style="margin-top:0">학생 계정</h3><div style="font-size:30px;font-weight:800">${summary.students}명</div><div class="muted">최초 로그인 전 ${summary.studentFirstLoginPending}명</div></section>
        </div>
        <div class="grid-2">
          <section class="card"><h3 style="margin-top:0">교사 명단 업로드</h3><p class="muted">필수 열: 이름, 내선번호. 최초 비밀번호는 내선번호 4자리입니다.</p><input id="admin-teacher-file" type="file" accept=".xlsx,.xls,.csv"><div id="teacher-file-preview" class="muted" style="margin:10px 0"></div><button class="primary" id="admin-import-teachers" disabled>교사 계정 등록</button></section>
          <section class="card"><h3 style="margin-top:0">학생 명단 업로드</h3><p class="muted">필수 열: 학번, 이름, 생년월일. 최초 비밀번호는 생년월일입니다.</p><input id="admin-student-file" type="file" accept=".xlsx,.xls,.csv"><div id="student-file-preview" class="muted" style="margin:10px 0"></div><button class="primary" id="admin-import-students" disabled>학생 계정 등록</button></section>
        </div>
        <div class="section-head"><h2>등록 현황</h2></div>
        <div class="grid-2">
          <section class="card"><h3 style="margin-top:0">교사</h3><div class="table-wrap"><table><thead><tr><th>이름</th><th>상태</th></tr></thead><tbody>${teachers.slice(0,100).map(t => `<tr><td>${esc(t.name)}</td><td>${t.mustChangePassword ? '최초 로그인 전' : '변경 완료'}</td></tr>`).join('') || '<tr><td colspan="2">등록 없음</td></tr>'}</tbody></table></div></section>
          <section class="card"><h3 style="margin-top:0">학생</h3><div class="table-wrap"><table><thead><tr><th>학번</th><th>이름</th><th>상태</th></tr></thead><tbody>${students.slice(0,100).map(s => `<tr><td>${esc(s.studentNo)}</td><td>${esc(s.name)}</td><td>${s.mustChangePassword ? '최초 로그인 전' : '변경 완료'}</td></tr>`).join('') || '<tr><td colspan="3">등록 없음</td></tr>'}</tbody></table></div></section>
        </div>
      </main></div>`;
      document.getElementById('admin-logout').onclick = () => {
        localStorage.removeItem('ygAdminToken');
        adminToken = '';
        location.reload();
      };
      bindAdminImports();
    } catch (error) {
      localStorage.removeItem('ygAdminToken');
      adminToken = '';
      notify(error.message, true);
      location.reload();
    }
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
    const n = row.map(norm);
    return n.findIndex((cell) => names.map(norm).includes(cell));
  }
  function findHeader(rows, spec) {
    for (let r = 0; r < Math.min(rows.length, 20); r += 1) {
      const indices = {};
      let ok = true;
      for (const [key, names] of Object.entries(spec)) {
        indices[key] = headerIndex(rows[r], names);
        if (indices[key] < 0) ok = false;
      }
      if (ok) return { row: r, indices };
    }
    throw new Error('필수 헤더를 찾지 못했습니다.');
  }
  function parseTeachers(rows) {
    const h = findHeader(rows, { name: ['이름','성명','교사명'], ext: ['내선번호','내선','내선번호4자리','extension','ext'] });
    return rows.slice(h.row + 1).map(row => ({
      name: String(row[h.indices.name] || '').trim(),
      ext: String(row[h.indices.ext] || '').replace(/\D/g, '').slice(-4).padStart(4, '0'),
    })).filter(x => x.name && /^\d{4}$/.test(x.ext));
  }
  function parseStudents(rows) {
    const h = findHeader(rows, { studentNo: ['학번','학생학번','학생번호'], name: ['이름','성명','학생명'], birth: ['생년월일','생년','생일','birth','birthday'] });
    return rows.slice(h.row + 1).map(row => ({
      studentNo: String(row[h.indices.studentNo] || '').replace(/\D/g, '').slice(-4).padStart(4, '0'),
      name: String(row[h.indices.name] || '').trim(),
      birth: String(row[h.indices.birth] || '').replace(/\D/g, ''),
    })).filter(x => x.studentNo && x.name && (x.birth.length === 6 || x.birth.length === 8));
  }

  function bindAdminImports() {
    let teacherRows = null;
    let studentRows = null;
    const tf = document.getElementById('admin-teacher-file');
    const sf = document.getElementById('admin-student-file');
    tf.onchange = async () => {
      try {
        teacherRows = parseTeachers(await rowsFromFile(tf.files[0]));
        document.getElementById('teacher-file-preview').textContent = `${teacherRows.length}명을 인식했습니다.`;
        document.getElementById('admin-import-teachers').disabled = !teacherRows.length;
      } catch (error) { notify(error.message, true); }
    };
    sf.onchange = async () => {
      try {
        studentRows = parseStudents(await rowsFromFile(sf.files[0]));
        document.getElementById('student-file-preview').textContent = `${studentRows.length}명을 인식했습니다.`;
        document.getElementById('admin-import-students').disabled = !studentRows.length;
      } catch (error) { notify(error.message, true); }
    };
    document.getElementById('admin-import-teachers').onclick = async () => {
      try {
        const r = await api('/admin/import-teachers', { method: 'POST', body: { token: adminToken, teachers: teacherRows } });
        notify(`교사 계정: 신규 ${r.added}명, 갱신 ${r.updated}명, 제외 ${r.skipped}명`);
        renderAdminDashboard();
      } catch (error) { notify(error.message, true); }
    };
    document.getElementById('admin-import-students').onclick = async () => {
      try {
        const r = await api('/admin/import-students', { method: 'POST', body: { token: adminToken, students: studentRows } });
        notify(`학생 계정: 신규 ${r.added}명, 갱신 ${r.updated}명, 제외 ${r.skipped}명`);
        renderAdminDashboard();
      } catch (error) { notify(error.message, true); }
    };
  }
})();