const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const fullscreenLock = document.getElementById('fullscreen-lock');
const pdfStage = document.getElementById('pdf-stage');

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

const state = {
  view: 'landing',
  teacherToken: localStorage.getItem('ygTeacherToken') || '',
  teacher: null,
  tab: 'rooms',
  rosters: [],
  papers: [],
  rooms: [],
  paperDraft: null,
  rosterPreview: null,
  monitorRoomId: null,
  monitorData: null,
  monitorTimer: null,
  studentRoomInfo: null,
  studentCode: '',
  studentToken: localStorage.getItem('ygStudentToken') || '',
  exam: null,
  remaining: 0,
  examTimer: null,
  autosaveTimer: null,
  heartbeatTimer: null,
  guardActive: false,
  lastGuardEvent: {},
  submitted: false,
};

const qTypeLabel = {
  essay: '서·논술형',
  short: '주관식 단답형',
  long: '주관식 장문형',
  choice5: '객관식 5지선다형',
  ox: 'OX',
};

const authLabel = {
  birth: '학번 4자리 + 생년월일',
  name: '학번 4자리 + 이름',
  nickname: '학번 4자리 + 별명',
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 2600);
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) throw new Error(data.error || '요청 처리 중 오류가 발생했습니다.');
  return data;
}

function topbar(extra = '') {
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">YG</div>
        <div><h1>양곡 온라인 시험실</h1><small>시험지 · 시험방 · 응시기록</small></div>
      </div>
      ${extra}
    </header>`;
}

function clearMonitorTimer() {
  if (state.monitorTimer) clearInterval(state.monitorTimer);
  state.monitorTimer = null;
}

function clearExamTimers() {
  if (state.examTimer) clearInterval(state.examTimer);
  if (state.autosaveTimer) clearInterval(state.autosaveTimer);
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.examTimer = null;
  state.autosaveTimer = null;
  state.heartbeatTimer = null;
}

function renderLanding() {
  clearMonitorTimer();
  state.view = 'landing';
  app.innerHTML = `
    <div class="app-shell">
      ${topbar('')}
      <main class="container">
        <section class="hero">
          <h1>온라인 시험과 수행평가를 한 곳에서</h1>
          <p>시험방 접속, 자동 저장, 타이머, 응시 현황과 화면 이탈 기록을 지원합니다.</p>
        </section>
        <div class="entry-grid">
          <section class="entry-card">
            <div>
              <h2>교사 입장</h2>
              <p>시험지와 반 명단을 저장하고 시험방을 생성합니다. 응시·미응시와 화면 이탈 기록도 확인할 수 있습니다.</p>
            </div>
            <button class="primary" id="go-teacher">교사로 입장</button>
          </section>
          <section class="entry-card">
            <div>
              <h2>학생 입장</h2>
              <p>교사가 알려 준 6자리 접속 코드를 입력한 뒤 본인 인증을 하고 시험을 시작합니다.</p>
            </div>
            <button class="secondary" id="go-student">학생으로 입장</button>
          </section>
        </div>
        ${state.studentToken ? `<div style="max-width:860px;margin:16px auto 0"><button class="ghost" id="resume-exam" style="width:100%">중단된 시험 이어하기</button></div>` : ''}
      </main>
    </div>`;

  document.getElementById('go-teacher').onclick = async () => {
    if (state.teacherToken) {
      try {
        state.teacher = await api('/teacher/me', { method: 'POST', body: { token: state.teacherToken } });
        await loadTeacherData();
        renderTeacherDashboard();
        return;
      } catch {
        localStorage.removeItem('ygTeacherToken');
        state.teacherToken = '';
      }
    }
    renderTeacherAuth();
  };
  document.getElementById('go-student').onclick = renderStudentEntry;
  const resume = document.getElementById('resume-exam');
  if (resume) resume.onclick = resumeExam;
}

function renderTeacherAuth() {
  state.view = 'teacher-auth';
  app.innerHTML = `
    <div class="app-shell">
      ${topbar('<button class="ghost" id="back-home">처음으로</button>')}
      <main class="container">
        <section class="card auth-wrap">
          <h2>교사 로그인</h2>
          <p class="muted">이름과 내선번호 4자리로 로그인합니다.</p>
          <div class="form-grid">
            <label>이름<input id="teacher-name" autocomplete="name" placeholder="예: 유제호"></label>
            <label>내선번호 4자리<input id="teacher-ext" maxlength="4" inputmode="numeric" placeholder="0000"></label>
            <div class="form-row">
              <button class="primary" id="teacher-login">로그인</button>
              <button class="secondary" id="teacher-register">최초 등록</button>
            </div>
            <div class="notice">운영 단계에서는 관리자 교사 명단을 미리 등록하는 방식을 권장합니다. 현재 버전에서는 교사가 최초 1회 직접 등록할 수 있습니다.</div>
          </div>
        </section>
      </main>
    </div>`;
  document.getElementById('back-home').onclick = renderLanding;
  const submit = async (mode) => {
    const name = document.getElementById('teacher-name').value.trim();
    const ext = document.getElementById('teacher-ext').value.trim();
    try {
      const result = await api(`/teacher/${mode}`, { method: 'POST', body: { name, ext } });
      state.teacherToken = result.token;
      state.teacher = result.teacher;
      localStorage.setItem('ygTeacherToken', result.token);
      await loadTeacherData();
      renderTeacherDashboard();
    } catch (error) {
      toast(error.message, true);
    }
  };
  document.getElementById('teacher-login').onclick = () => submit('login');
  document.getElementById('teacher-register').onclick = () => submit('register');
}

async function loadTeacherData() {
  const token = encodeURIComponent(state.teacherToken);
  [state.rosters, state.papers, state.rooms] = await Promise.all([
    api(`/teacher/rosters?token=${token}`),
    api(`/teacher/papers?token=${token}`),
    api(`/teacher/rooms?token=${token}`),
  ]);
}

function renderTeacherDashboard() {
  clearMonitorTimer();
  state.view = 'teacher-dashboard';
  app.innerHTML = `
    <div class="app-shell">
      ${topbar(`<div class="flex"><strong>${esc(state.teacher?.name || '')} 선생님</strong><button class="ghost" id="teacher-logout">로그아웃</button></div>`)}
      <main class="container">
        <div class="tabs">
          <button class="tab ${state.tab === 'rooms' ? 'active' : ''}" data-tab="rooms">시험방</button>
          <button class="tab ${state.tab === 'papers' ? 'active' : ''}" data-tab="papers">내 시험지</button>
          <button class="tab ${state.tab === 'rosters' ? 'active' : ''}" data-tab="rosters">학생명단</button>
        </div>
        <div id="teacher-content"></div>
      </main>
    </div>`;
  document.getElementById('teacher-logout').onclick = () => {
    localStorage.removeItem('ygTeacherToken');
    state.teacherToken = '';
    state.teacher = null;
    renderLanding();
  };
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.onclick = () => {
      state.tab = button.dataset.tab;
      renderTeacherDashboard();
    };
  });
  if (state.tab === 'rooms') renderRoomsTab();
  if (state.tab === 'papers') renderPapersTab();
  if (state.tab === 'rosters') renderRostersTab();
}

function renderRostersTab() {
  const content = document.getElementById('teacher-content');
  content.innerHTML = `
    <div class="section-head"><h2>학생명단</h2><span class="muted">반 명단을 올리면 미응시 학생까지 자동 확인됩니다.</span></div>
    <div class="grid-2">
      <section class="card">
        <h3 style="margin-top:0">반 명단 업로드</h3>
        <div class="form-grid">
          <div class="form-row">
            <label>학년도<input id="roster-year" type="number" value="${new Date().getFullYear()}"></label>
            <label>학년<select id="roster-grade"><option>1</option><option>2</option><option>3</option></select></label>
          </div>
          <label>반<input id="roster-class" type="number" min="1" value="1"></label>
          <div class="dropzone">
            <input id="roster-file" type="file" accept=".xlsx,.xls,.csv">
            <div class="file-name">학번·이름·생년월일 열을 자동으로 찾습니다.</div>
          </div>
          <div id="roster-preview"></div>
          <button class="primary" id="save-roster" disabled>이 명단 저장</button>
        </div>
      </section>
      <section>
        ${state.rosters.length ? state.rosters.map((r) => `
          <div class="card" style="margin-bottom:12px">
            <div class="section-head" style="margin:0">
              <div><strong>${esc(r.label)}</strong><div class="muted" style="margin-top:5px">${r.students?.length ?? r.studentCount ?? 0}명</div></div>
              <button class="danger tiny" data-delete-roster="${r.id}">삭제</button>
            </div>
          </div>`).join('') : '<div class="card empty">저장된 학생명단이 없습니다.</div>'}
      </section>
    </div>`;
  document.getElementById('roster-file').onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      state.rosterPreview = await parseRosterFile(file);
      const preview = document.getElementById('roster-preview');
      preview.innerHTML = `<div class="notice">${state.rosterPreview.length}명을 인식했습니다. ${state.rosterPreview.slice(0, 5).map((s) => `${esc(s.studentNo)} ${esc(s.name)}`).join(' · ')}${state.rosterPreview.length > 5 ? ' …' : ''}</div>`;
      document.getElementById('save-roster').disabled = false;
    } catch (error) {
      toast(error.message, true);
    }
  };
  document.getElementById('save-roster').onclick = async () => {
    if (!state.rosterPreview?.length) return;
    try {
      await api('/teacher/rosters', {
        method: 'POST',
        body: {
          token: state.teacherToken,
          year: Number(document.getElementById('roster-year').value),
          grade: Number(document.getElementById('roster-grade').value),
          classNo: Number(document.getElementById('roster-class').value),
          students: state.rosterPreview,
        },
      });
      state.rosterPreview = null;
      await loadTeacherData();
      renderTeacherDashboard();
      toast('학생명단을 저장했습니다.');
    } catch (error) {
      toast(error.message, true);
    }
  };
  document.querySelectorAll('[data-delete-roster]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('이 학생명단을 삭제하시겠습니까?')) return;
      try {
        await api(`/teacher/rosters?token=${encodeURIComponent(state.teacherToken)}&id=${button.dataset.deleteRoster}`, { method: 'DELETE' });
        await loadTeacherData();
        renderTeacherDashboard();
      } catch (error) {
        toast(error.message, true);
      }
    };
  });
}

async function parseRosterFile(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const synonyms = {
    studentNo: ['학번', '번호', '학생번호', 'studentno', 'student no'],
    name: ['이름', '성명', '학생명', 'name'],
    birth: ['생년월일', '생년', '생일', 'birth', 'birthday'],
  };
  let headerRow = -1;
  let indices = null;
  for (let r = 0; r < Math.min(rows.length, 15); r += 1) {
    const normalized = rows[r].map((v) => String(v).replace(/\s+/g, '').toLowerCase());
    const find = (list) => normalized.findIndex((h) => list.some((s) => h === s.replace(/\s+/g, '').toLowerCase()));
    const studentNo = find(synonyms.studentNo);
    const name = find(synonyms.name);
    const birth = find(synonyms.birth);
    if (studentNo >= 0 && name >= 0) {
      headerRow = r;
      indices = { studentNo, name, birth };
      break;
    }
  }
  if (!indices) throw new Error('학번과 이름 열을 찾지 못했습니다. 헤더명을 확인해 주세요.');
  return rows.slice(headerRow + 1)
    .map((row) => ({
      studentNo: String(row[indices.studentNo] ?? '').replace(/\D/g, '').slice(-4).padStart(4, '0'),
      name: String(row[indices.name] ?? '').trim(),
      birth: indices.birth >= 0 ? normalizeSpreadsheetBirth(row[indices.birth]) : '',
    }))
    .filter((row) => /^\d{4}$/.test(row.studentNo) && row.name);
}

function normalizeSpreadsheetBirth(value) {
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) return `${date.y}${String(date.m).padStart(2, '0')}${String(date.d).padStart(2, '0')}`;
  }
  return String(value ?? '').replace(/\D/g, '');
}

function renderPapersTab() {
  const content = document.getElementById('teacher-content');
  content.innerHTML = `
    <div class="section-head"><h2>내 시험지</h2><button class="primary" id="new-paper">새 시험지</button></div>
    ${state.papers.length ? `<div class="table-wrap"><table><thead><tr><th>시험지</th><th>과목</th><th>문항</th><th>수정일</th><th>관리</th></tr></thead><tbody>
      ${state.papers.map((p) => `<tr>
        <td><strong>${esc(p.title)}</strong>${p.sourceName ? `<div class="muted">원본: ${esc(p.sourceName)}</div>` : ''}</td>
        <td>${esc(p.subject || '-')}</td><td>${p.questions?.length || 0}</td><td>${formatDate(p.updatedAt)}</td>
        <td><div class="toolbar"><button class="tiny" data-edit-paper="${p.id}">편집</button><button class="tiny" data-copy-paper="${p.id}">복사</button><button class="danger tiny" data-delete-paper="${p.id}">삭제</button></div></td>
      </tr>`).join('')}
    </tbody></table></div>` : '<div class="card empty">아직 저장한 시험지가 없습니다.</div>'}`;
  document.getElementById('new-paper').onclick = () => openPaperEditor();
  document.querySelectorAll('[data-edit-paper]').forEach((button) => {
    button.onclick = () => openPaperEditor(state.papers.find((p) => p.id === button.dataset.editPaper));
  });
  document.querySelectorAll('[data-copy-paper]').forEach((button) => {
    button.onclick = async () => {
      try {
        await api('/teacher/papers/copy', { method: 'POST', body: { token: state.teacherToken, id: button.dataset.copyPaper } });
        await loadTeacherData();
        renderTeacherDashboard();
        toast('시험지 사본을 만들었습니다.');
      } catch (error) { toast(error.message, true); }
    };
  });
  document.querySelectorAll('[data-delete-paper]').forEach((button) => {
    button.onclick = async () => {
      if (!confirm('이 시험지를 삭제하시겠습니까?')) return;
      try {
        await api(`/teacher/papers?token=${encodeURIComponent(state.teacherToken)}&id=${button.dataset.deletePaper}`, { method: 'DELETE' });
        await loadTeacherData(); renderTeacherDashboard();
      } catch (error) { toast(error.message, true); }
    };
  });
}

function emptyQuestion(order) {
  return { id: crypto.randomUUID(), order, type: 'short', prompt: '', choices: [], points: 0 };
}

function openPaperEditor(paper = null) {
  state.paperDraft = paper
    ? JSON.parse(JSON.stringify(paper))
    : { title: '', subject: '', year: new Date().getFullYear(), sourceName: null, sourceKey: null, questions: [emptyQuestion(1)] };
  renderPaperEditor();
}

function renderPaperEditor() {
  state.view = 'paper-editor';
  const p = state.paperDraft;
  app.innerHTML = `
    <div class="app-shell">
      ${topbar('<button class="ghost" id="paper-back">시험지 목록</button>')}
      <main class="container">
        <div class="section-head"><div><h2>시험지 편집</h2><div class="muted">PDF · Excel · HWPX 자동 분할 또는 직접 작성</div></div><button class="primary" id="save-paper">시험지 저장</button></div>
        <section class="card" style="margin-bottom:18px">
          <div class="form-row">
            <label>시험지 제목<input id="paper-title" value="${esc(p.title)}" placeholder="예: 문학 수행평가 1차"></label>
            <label>과목<input id="paper-subject" value="${esc(p.subject || '')}" placeholder="예: 문학"></label>
          </div>
          <div class="dropzone" style="margin-top:14px">
            <input id="paper-file" type="file" accept=".pdf,.xlsx,.xls,.hwpx">
            <div class="file-name">문항 번호(1번, 문제 1, 1.)를 기준으로 나눕니다. 자동 분할 후 직접 수정할 수 있습니다.</div>
          </div>
          ${p.sourceName ? `<div class="notice" style="margin-top:10px">현재 원본: ${esc(p.sourceName)}</div>` : ''}
        </section>
        <div class="section-head"><h2>문항 ${p.questions.length}개</h2><button class="secondary" id="add-question">문항 추가</button></div>
        <div id="question-list">${p.questions.map(questionEditorHtml).join('')}</div>
      </main>
    </div>`;
  document.getElementById('paper-back').onclick = () => { state.paperDraft = null; state.tab = 'papers'; renderTeacherDashboard(); };
  document.getElementById('paper-title').oninput = (e) => { p.title = e.target.value; };
  document.getElementById('paper-subject').oninput = (e) => { p.subject = e.target.value; };
  document.getElementById('paper-file').onchange = handlePaperFile;
  document.getElementById('add-question').onclick = () => { p.questions.push(emptyQuestion(p.questions.length + 1)); renderPaperEditor(); };
  bindQuestionEditors();
  document.getElementById('save-paper').onclick = savePaperDraft;
}

function questionEditorHtml(q, index) {
  const choiceInputs = q.type === 'choice5'
    ? `<div class="choice-grid">${[0,1,2,3,4].map((i) => `<input data-choice="${i}" data-q="${index}" value="${esc(q.choices?.[i] || '')}" placeholder="${i + 1}번 보기">`).join('')}</div>`
    : '';
  return `<section class="question-editor">
    <div class="question-head"><strong>${index + 1}번</strong><div class="toolbar"><select data-type data-q="${index}">${Object.entries(qTypeLabel).map(([k,v]) => `<option value="${k}" ${q.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select><button class="danger tiny" data-remove-q="${index}">삭제</button></div></div>
    <textarea data-prompt data-q="${index}" placeholder="문제와 제시문을 입력하세요.">${esc(q.prompt)}</textarea>
    ${choiceInputs}
  </section>`;
}

function bindQuestionEditors() {
  document.querySelectorAll('[data-prompt]').forEach((el) => el.oninput = (e) => { state.paperDraft.questions[Number(e.target.dataset.q)].prompt = e.target.value; });
  document.querySelectorAll('[data-choice]').forEach((el) => el.oninput = (e) => {
    const q = state.paperDraft.questions[Number(e.target.dataset.q)];
    q.choices ||= ['', '', '', '', '']; q.choices[Number(e.target.dataset.choice)] = e.target.value;
  });
  document.querySelectorAll('[data-type]').forEach((el) => el.onchange = (e) => {
    const q = state.paperDraft.questions[Number(e.target.dataset.q)]; q.type = e.target.value;
    if (q.type === 'choice5' && q.choices.length !== 5) q.choices = ['', '', '', '', ''];
    renderPaperEditor();
  });
  document.querySelectorAll('[data-remove-q]').forEach((button) => button.onclick = () => {
    if (state.paperDraft.questions.length === 1) return toast('문항은 1개 이상 있어야 합니다.', true);
    state.paperDraft.questions.splice(Number(button.dataset.removeQ), 1);
    state.paperDraft.questions.forEach((q, i) => q.order = i + 1);
    renderPaperEditor();
  });
}

async function handlePaperFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  toast('문제지에서 문항을 읽고 있습니다.');
  try {
    const text = await extractDocumentText(file);
    const questions = splitQuestions(text);
    if (!questions.length) throw new Error('문항 번호를 찾지 못했습니다. 직접 문항을 작성해 주세요.');
    state.paperDraft.questions = questions;
    state.paperDraft.sourceName = file.name;
    if (file.size <= 6 * 1024 * 1024) {
      try {
        const base64 = await fileToBase64(file);
        const uploaded = await api('/teacher/file', { method: 'POST', body: { token: state.teacherToken, filename: file.name, base64 } });
        state.paperDraft.sourceKey = uploaded.key;
      } catch (error) {
        console.warn('Original file archival skipped:', error);
      }
    }
    renderPaperEditor();
    toast(`${questions.length}개 문항으로 나눴습니다. 내용을 확인해 주세요.`);
  } catch (error) { toast(error.message, true); }
}

async function extractDocumentText(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(' '));
    }
    return pages.join('\n');
  }
  if (['xlsx', 'xls'].includes(ext)) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    return wb.SheetNames.map((name) => XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: ' ', RS: '\n' })).join('\n');
  }
  if (ext === 'hwpx') {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const sectionNames = Object.keys(zip.files).filter((name) => /Contents\/section\d+\.xml$/i.test(name)).sort();
    if (!sectionNames.length) throw new Error('HWPX 본문을 찾지 못했습니다.');
    const parts = [];
    for (const name of sectionNames) {
      const xml = await zip.files[name].async('string');
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      parts.push(doc.documentElement.textContent || '');
    }
    return parts.join('\n');
  }
  throw new Error('PDF, XLSX/XLS, HWPX 파일만 지원합니다.');
}

function splitQuestions(text) {
  const normalized = String(text || '').replace(/\r/g, '\n').replace(/\u00a0/g, ' ');
  const re = /(?:^|\n|\s)(?:문제\s*)?(\d{1,3})\s*(?:번|[.)])\s*/g;
  const matches = [...normalized.matchAll(re)];
  if (!matches.length) return [];
  const questions = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
    let prompt = normalized.slice(start, end).trim();
    if (!prompt) continue;
    const circled = ['①', '②', '③', '④', '⑤'];
    const positions = circled.map((mark) => prompt.indexOf(mark));
    let type = /\bO\s*X\b|O\s*\/\s*X|○\s*×/i.test(prompt) ? 'ox' : 'short';
    let choices = [];
    if (positions.every((p) => p >= 0)) {
      type = 'choice5';
      const first = positions[0];
      const stem = prompt.slice(0, first).trim();
      choices = positions.map((pos, idx) => prompt.slice(pos + 1, idx < 4 ? positions[idx + 1] : prompt.length).trim());
      prompt = stem;
    } else if (/서술|논술|근거를 들어|자신의 견해|자신의 생각/.test(prompt)) {
      type = 'essay';
    } else if (/설명하시오|서술하시오|작성하시오/.test(prompt)) {
      type = 'long';
    }
    questions.push({ id: crypto.randomUUID(), order: questions.length + 1, type, prompt, choices, points: 0 });
  }
  return questions;
}

async function savePaperDraft() {
  const p = state.paperDraft;
  if (!p.title.trim()) return toast('시험지 제목을 입력해 주세요.', true);
  if (!p.questions.length) return toast('문항을 한 개 이상 만들어 주세요.', true);
  try {
    await api('/teacher/papers', { method: 'POST', body: { token: state.teacherToken, ...p } });
    state.paperDraft = null;
    await loadTeacherData();
    state.tab = 'papers';
    renderTeacherDashboard();
    toast('시험지를 저장했습니다.');
  } catch (error) { toast(error.message, true); }
}

function renderRoomsTab() {
  const content = document.getElementById('teacher-content');
  const rosterOptions = state.rosters.map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join('');
  content.innerHTML = `
    <div class="grid-2" style="margin-bottom:22px">
      <section class="card">
        <h3 style="margin-top:0">시험방 만들기</h3>
        <div class="form-grid">
          <label>시험명<input id="room-title" placeholder="예: 2학년 3반 문학 수행평가"></label>
          <label>시험지<select id="room-paper"><option value="">시험지 선택</option>${state.papers.map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}</select></label>
          <label>학생명단<select id="room-roster"><option value="">명단 없이 진행</option>${rosterOptions}</select></label>
          <div class="form-row"><label>제한시간(분)<input id="room-duration" type="number" min="1" value="50"></label><label>인증<select id="room-auth"><option value="birth">학번+생년월일</option><option value="name">학번+이름</option><option value="nickname">학번+별명</option></select></label></div>
          <label style="display:flex;grid-template-columns:auto 1fr;align-items:center"><input id="room-fullscreen" type="checkbox" checked style="width:auto">전체화면 필수</label>
          <button class="primary" id="create-room">시험방 생성</button>
        </div>
      </section>
      <section class="card">
        <h3 style="margin-top:0">운영 안내</h3>
        <p class="muted" style="line-height:1.7">같은 시험지를 여러 반에 사용할 때는 아래 목록의 ‘다른 반 실시’를 사용하세요. 새 접속 코드와 새 응시기록이 생성되며 기존 학생 답안은 복사되지 않습니다.</p>
        <div class="notice">일반 웹브라우저는 Alt+Tab 자체를 운영체제 수준에서 차단할 수 없습니다. 대신 화면 이탈과 전체화면 해제를 즉시 기록하고, 전체화면이 풀리면 답안 입력을 잠급니다.</div>
      </section>
    </div>
    <div class="section-head"><h2>시험방</h2><span class="muted">${state.rooms.length}개</span></div>
    ${state.rooms.length ? `<div class="table-wrap"><table><thead><tr><th>시험</th><th>접속코드</th><th>대상</th><th>상태</th><th>관리</th><th>다른 반 실시</th></tr></thead><tbody>
      ${state.rooms.map((r) => `<tr>
        <td><strong>${esc(r.title)}</strong><div class="muted">${esc(r.paperTitle || '')} · ${r.durationMin}분</div></td>
        <td><span class="code-box">${esc(r.code)}</span></td>
        <td>${esc(r.rosterLabel || '명단 없음')}</td>
        <td><span class="badge ${r.status === 'running' ? 'running' : ''}">${r.status === 'waiting' ? '대기' : r.status === 'running' ? '진행 중' : '종료'}</span></td>
        <td><div class="toolbar"><button class="tiny" data-monitor="${r.id}">감독</button>${r.status !== 'ended' ? `<button class="tiny" data-room-state="${r.id}" data-next-state="${r.status === 'waiting' ? 'running' : 'ended'}">${r.status === 'waiting' ? '시작' : '종료'}</button>` : ''}</div></td>
        <td><div class="flex"><select data-clone-roster="${r.id}" style="min-width:150px"><option value="">반 선택</option>${rosterOptions}</select><button class="secondary tiny" data-clone="${r.id}">다른 반 실시</button></div></td>
      </tr>`).join('')}
    </tbody></table></div>` : '<div class="card empty">아직 만든 시험방이 없습니다.</div>'}`;
  document.getElementById('create-room').onclick = createRoom;
  document.querySelectorAll('[data-monitor]').forEach((button) => button.onclick = () => openMonitor(button.dataset.monitor));
  document.querySelectorAll('[data-room-state]').forEach((button) => button.onclick = () => updateRoom(button.dataset.roomState, { status: button.dataset.nextState }));
  document.querySelectorAll('[data-clone]').forEach((button) => button.onclick = async () => {
    const select = document.querySelector(`[data-clone-roster="${button.dataset.clone}"]`);
    if (!select.value) return toast('다른 반 학생명단을 선택해 주세요.', true);
    const source = state.rooms.find((r) => r.id === button.dataset.clone);
    const roster = state.rosters.find((r) => r.id === select.value);
    try {
      await api('/teacher/rooms/clone', { method: 'POST', body: { token: state.teacherToken, roomId: source.id, rosterId: roster.id, title: `${source.title} - ${roster.label}` } });
      await loadTeacherData(); renderTeacherDashboard(); toast('다른 반용 시험방을 만들었습니다.');
    } catch (error) { toast(error.message, true); }
  });
}

async function createRoom() {
  const paperId = document.getElementById('room-paper').value;
  const rosterId = document.getElementById('room-roster').value || null;
  const title = document.getElementById('room-title').value.trim();
  const authMode = document.getElementById('room-auth').value;
  try {
    await api('/teacher/rooms', { method: 'POST', body: { token: state.teacherToken, paperId, rosterId, title, durationMin: Number(document.getElementById('room-duration').value), authMode, requireFullscreen: document.getElementById('room-fullscreen').checked, year: new Date().getFullYear() } });
    await loadTeacherData(); renderTeacherDashboard(); toast('시험방을 만들었습니다.');
  } catch (error) { toast(error.message, true); }
}

async function updateRoom(roomId, patch) {
  try {
    await api('/teacher/rooms/update', { method: 'POST', body: { token: state.teacherToken, roomId, patch } });
    await loadTeacherData();
    if (state.monitorRoomId === roomId) await refreshMonitor(); else renderTeacherDashboard();
  } catch (error) { toast(error.message, true); }
}

async function openMonitor(roomId) {
  state.monitorRoomId = roomId;
  state.view = 'monitor';
  await refreshMonitor(true);
  clearMonitorTimer();
  state.monitorTimer = setInterval(() => refreshMonitor(false), 2500);
}

async function refreshMonitor(fullRender = true) {
  try {
    state.monitorData = await api(`/teacher/monitor?token=${encodeURIComponent(state.teacherToken)}&roomId=${encodeURIComponent(state.monitorRoomId)}`);
    renderMonitor(fullRender);
  } catch (error) {
    clearMonitorTimer(); toast(error.message, true);
  }
}

function renderMonitor() {
  const d = state.monitorData;
  if (!d) return;
  const rosterStudents = d.roster?.students || [];
  const attemptMap = new Map(d.attempts.map((a) => [a.studentNo, a]));
  const rows = rosterStudents.length
    ? rosterStudents.map((s) => ({ studentNo: s.studentNo, name: s.name, attempt: attemptMap.get(s.studentNo) || null }))
    : d.attempts.map((a) => ({ studentNo: a.studentNo, name: a.studentName, attempt: a }));
  const extras = d.attempts.filter((a) => rosterStudents.length && !rosterStudents.some((s) => s.studentNo === a.studentNo));
  extras.forEach((a) => rows.push({ studentNo: a.studentNo, name: a.studentName, attempt: a }));
  const statuses = rows.map((row) => computedStatus(row.attempt));
  const submitted = statuses.filter((s) => s === '제출').length;
  const inProgress = statuses.filter((s) => s === '응시 중').length;
  const disconnected = statuses.filter((s) => s === '연결 끊김').length;
  const absent = statuses.filter((s) => s === '미응시').length;
  app.innerHTML = `
    <div class="app-shell">
      ${topbar('<button class="ghost" id="monitor-back">시험방 목록</button>')}
      <main class="container">
        <div class="section-head"><div><h2>${esc(d.room.title)}</h2><div class="muted">접속코드 <strong>${esc(d.room.code)}</strong> · ${d.room.durationMin}분</div></div><div class="toolbar"><button class="secondary" id="download-xlsx">답안 Excel</button><button class="secondary" id="download-zip">개인별 PDF ZIP</button></div></div>
        <div class="grid-3" style="margin-bottom:18px">
          <div class="stat-card">대상 인원<strong>${rows.length}</strong></div>
          <div class="stat-card">응시 중<strong>${inProgress}</strong></div>
          <div class="stat-card">제출<strong>${submitted}</strong></div>
          <div class="stat-card">미응시<strong>${absent}</strong></div>
          <div class="stat-card">연결 끊김<strong>${disconnected}</strong></div>
          <div class="stat-card">부정행위 기록<strong>${d.events.filter((e) => !['submit','auto_submit'].includes(e.type)).length}</strong></div>
        </div>
        <div class="card" style="margin-bottom:18px">
          <div class="section-head"><h3 style="margin:0">시험방 제어</h3><span class="badge ${d.room.status === 'running' ? 'running' : ''}">${d.room.status === 'waiting' ? '대기' : d.room.status === 'running' ? '진행 중' : '종료'}</span></div>
          <div class="toolbar">
            ${d.room.status === 'waiting' ? '<button class="primary" id="monitor-start">시험 시작</button>' : ''}
            ${d.room.status !== 'ended' ? '<button class="danger" id="monitor-end">시험 종료</button>' : ''}
            <button class="ghost" id="toggle-entry">입장 ${d.room.entryOpen ? '차단' : '허용'}</button>
            <button class="ghost" id="toggle-lock">답안 ${d.room.answersLocked ? '입력 허용' : '잠금'}</button>
          </div>
        </div>
        <div class="table-wrap" style="margin-bottom:18px"><table><thead><tr><th>학번</th><th>이름</th><th>상태</th><th>시작</th><th>제출</th><th>이탈 기록</th><th>관리</th></tr></thead><tbody>
          ${rows.map((row) => {
            const a = row.attempt; const status = computedStatus(a);
            return `<tr><td>${esc(row.studentNo)}</td><td><strong>${esc(row.name)}</strong></td><td><span class="badge ${status === '제출' ? 'submitted' : status === '응시 중' ? 'running' : status === '연결 끊김' ? 'alert' : 'absent'}">${status}</span></td><td>${a?.startedAt ? formatTime(a.startedAt) : '-'}</td><td>${a?.submittedAt ? formatTime(a.submittedAt) : '-'}</td><td>${a?.violationCount || 0}</td><td><div class="toolbar">${a ? `<button class="tiny" data-student-pdf="${row.studentNo}">PDF</button><button class="danger tiny" data-reset="${row.studentNo}">재응시 허용</button>` : '-'}</div></td></tr>`;
          }).join('')}
        </tbody></table></div>
        <section class="card"><div class="section-head"><h3 style="margin:0">부정행위·접속 기록</h3><span class="muted">최근 500건</span></div>
          <div class="monitor-alerts">${d.events.length ? d.events.map((e) => `<div class="alert-item"><strong>${esc(e.studentNo)} ${esc(e.studentName)}</strong> · ${eventLabel(e.type)} · ${formatTime(e.createdAt)}${e.gapSeconds ? ` · ${e.gapSeconds}초` : ''}<div class="muted">${esc(e.detail || '')}</div></div>`).join('') : '<div class="empty">기록이 없습니다.</div>'}</div>
        </section>
      </main>
    </div>`;
  document.getElementById('monitor-back').onclick = async () => { clearMonitorTimer(); state.monitorRoomId = null; await loadTeacherData(); state.tab = 'rooms'; renderTeacherDashboard(); };
  document.getElementById('download-xlsx').onclick = () => downloadRoomExcel(d.room.id);
  document.getElementById('download-zip').onclick = () => downloadRoomPdfZip(d.room.id);
  document.getElementById('monitor-start')?.addEventListener('click', () => updateRoom(d.room.id, { status: 'running' }));
  document.getElementById('monitor-end')?.addEventListener('click', () => { if (confirm('시험을 종료하면 모든 학생의 답안이 잠깁니다. 종료하시겠습니까?')) updateRoom(d.room.id, { status: 'ended' }); });
  document.getElementById('toggle-entry').onclick = () => updateRoom(d.room.id, { entryOpen: !d.room.entryOpen });
  document.getElementById('toggle-lock').onclick = () => updateRoom(d.room.id, { answersLocked: !d.room.answersLocked });
  document.querySelectorAll('[data-reset]').forEach((button) => button.onclick = async () => {
    if (!confirm(`${button.dataset.reset} 학생의 기존 답안을 지우고 재응시를 허용하시겠습니까?`)) return;
    try { await api('/teacher/reset-attempt', { method: 'POST', body: { token: state.teacherToken, roomId: d.room.id, studentNo: button.dataset.reset } }); await refreshMonitor(); } catch (error) { toast(error.message, true); }
  });
  document.querySelectorAll('[data-student-pdf]').forEach((button) => button.onclick = () => downloadStudentPdf(d.room.id, button.dataset.studentPdf));
}

function computedStatus(attempt) {
  if (!attempt) return '미응시';
  if (attempt.status === 'submitted') return '제출';
  if (attempt.status === 'in_progress' && Date.now() - Date.parse(attempt.lastSeenAt) > 16000) return '연결 끊김';
  if (attempt.status === 'in_progress') return '응시 중';
  return '입장';
}

function eventLabel(type) {
  const labels = { fullscreen_exit: '전체화면 해제', blur: '다른 창 이동', visibility_hidden: '다른 탭/화면 이동', copy: '복사 시도', paste: '붙여넣기 시도', cut: '잘라내기 시도', contextmenu: '우클릭 시도', devtools_key: '개발자도구 단축키 시도', offline: '인터넷 연결 끊김', online: '인터넷 연결 복구', reconnect: '재접속', submit: '제출', auto_submit: '자동 제출' };
  return labels[type] || type;
}

async function getRoomResults(roomId) {
  return api(`/teacher/results?token=${encodeURIComponent(state.teacherToken)}&roomId=${encodeURIComponent(roomId)}`);
}

async function downloadRoomExcel(roomId) {
  try {
    const data = await getRoomResults(roomId);
    const attempts = new Map(data.attempts.map((a) => [a.studentNo, a]));
    const students = data.roster?.students?.length ? data.roster.students : data.attempts.map((a) => ({ studentNo: a.studentNo, name: a.studentName }));
    const rows = students.map((s) => {
      const a = attempts.get(s.studentNo);
      const row = { 학번: s.studentNo, 이름: s.name, 상태: computedStatus(a), 시작시각: a?.startedAt || '', 제출시각: a?.submittedAt || '', 부정행위기록수: a?.violationCount || 0 };
      (data.paper?.questions || []).forEach((q) => { row[`Q${q.order}`] = a?.answers?.[q.id] || ''; });
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '답안');
    XLSX.writeFile(wb, `${safeFilename(data.room.title)}_답안.xlsx`);
  } catch (error) { toast(error.message, true); }
}

async function downloadStudentPdf(roomId, studentNo) {
  try {
    const data = await getRoomResults(roomId);
    const attempt = data.attempts.find((a) => a.studentNo === studentNo);
    if (!attempt) throw new Error('학생 답안을 찾을 수 없습니다.');
    const blob = await makeStudentPdfBlob(data, attempt);
    downloadBlob(blob, `${studentNo}_${safeFilename(attempt.studentName)}_${safeFilename(data.room.title)}.pdf`);
  } catch (error) { toast(error.message, true); }
}

async function downloadRoomPdfZip(roomId) {
  try {
    toast('개인별 PDF를 만들고 있습니다.');
    const data = await getRoomResults(roomId);
    const zip = new JSZip();
    for (const attempt of data.attempts.filter((a) => a.status === 'submitted')) {
      const blob = await makeStudentPdfBlob(data, attempt);
      zip.file(`${attempt.studentNo}_${safeFilename(attempt.studentName)}.pdf`, blob);
    }
    const output = await zip.generateAsync({ type: 'blob' });
    downloadBlob(output, `${safeFilename(data.room.title)}_개인별답안.zip`);
    toast('PDF ZIP 파일을 만들었습니다.');
  } catch (error) { toast(error.message, true); }
}

async function makeStudentPdfBlob(data, attempt) {
  pdfStage.innerHTML = `<div class="pdf-sheet"><h1>${esc(data.room.title)}</h1><div>학번 ${esc(attempt.studentNo)} · 이름 ${esc(attempt.studentName)}</div><hr>${(data.paper?.questions || []).map((q) => `<section style="margin-top:22px"><strong>${q.order}번 · ${esc(qTypeLabel[q.type] || q.type)}</strong><div style="white-space:pre-wrap;line-height:1.65;margin-top:8px">${esc(q.prompt)}</div><div class="pdf-answer">${esc(attempt.answers?.[q.id] || '(미작성)')}</div></section>`).join('')}</div>`;
  const sheet = pdfStage.firstElementChild;
  const canvas = await html2canvas(sheet, { scale: 1.5, backgroundColor: '#ffffff' });
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageW = 210, pageH = 297, margin = 8;
  const imgW = pageW - margin * 2;
  const imgH = canvas.height * imgW / canvas.width;
  const img = canvas.toDataURL('image/jpeg', 0.92);
  let y = margin;
  pdf.addImage(img, 'JPEG', margin, y, imgW, imgH);
  let remaining = imgH - (pageH - margin * 2);
  while (remaining > 0) {
    pdf.addPage();
    y -= pageH - margin * 2;
    pdf.addImage(img, 'JPEG', margin, y, imgW, imgH);
    remaining -= pageH - margin * 2;
  }
  pdfStage.innerHTML = '';
  return pdf.output('blob');
}

function renderStudentEntry() {
  state.view = 'student-entry';
  state.studentRoomInfo = null;
  app.innerHTML = `
    <div class="app-shell">
      ${topbar('<button class="ghost" id="student-home">처음으로</button>')}
      <main class="container"><section class="card auth-wrap"><h2>학생 입장</h2><p class="muted">교사가 알려 준 접속 코드를 입력하세요.</p><div class="form-grid"><label>접속 코드<input id="student-code" maxlength="6" autocomplete="off" style="text-transform:uppercase" placeholder="ABC123"></label><button class="primary" id="find-room">시험방 찾기</button><div id="student-auth-area"></div></div></section></main>
    </div>`;
  document.getElementById('student-home').onclick = renderLanding;
  document.getElementById('find-room').onclick = async () => {
    const code = document.getElementById('student-code').value.trim().toUpperCase();
    try {
      state.studentRoomInfo = await api('/student/find-room', { method: 'POST', body: { code } });
      state.studentCode = code; renderStudentAuthArea();
    } catch (error) { toast(error.message, true); }
  };
}

function renderStudentAuthArea() {
  const r = state.studentRoomInfo;
  const area = document.getElementById('student-auth-area');
  const credentialLabel = r.authMode === 'birth' ? '생년월일' : r.authMode === 'name' ? '이름' : '별명';
  area.innerHTML = `<div class="notice" style="margin-bottom:12px"><strong>${esc(r.title)}</strong><br>${r.durationMin}분 · 인증: ${esc(authLabel[r.authMode])}</div><div class="form-grid"><label>학번 4자리<input id="student-no" maxlength="4" inputmode="numeric" placeholder="3101"></label><label>${credentialLabel}<input id="student-credential" ${r.authMode === 'birth' ? 'inputmode="numeric" placeholder="20080101 또는 080101"' : ''}></label><button class="primary" id="enter-room">인증하고 입장</button><div class="notice">시험 시작 후 화면 이탈, 전체화면 해제, 복사·붙여넣기, 우클릭, 개발자도구 단축키 시도가 기록됩니다. 브라우저만으로 Alt+Tab 자체를 운영체제 수준에서 막을 수는 없습니다.</div></div>`;
  document.getElementById('enter-room').onclick = enterStudentRoom;
}

async function enterStudentRoom() {
  try {
    const result = await api('/student/enter', { method: 'POST', body: { code: state.studentCode, studentNo: document.getElementById('student-no').value, credential: document.getElementById('student-credential').value } });
    state.studentToken = result.token; localStorage.setItem('ygStudentToken', result.token);
    await loadExamState();
    if (state.exam.attempt.startedAt) startExamUi(); else renderExamReady();
  } catch (error) { toast(error.message, true); }
}

async function resumeExam() {
  try {
    await loadExamState();
    if (state.exam.attempt.status === 'submitted') throw new Error('이미 제출된 시험입니다.');
    if (state.exam.attempt.startedAt) startExamUi(); else renderExamReady();
  } catch (error) {
    localStorage.removeItem('ygStudentToken'); state.studentToken = ''; toast(error.message, true); renderStudentEntry();
  }
}

async function loadExamState() {
  state.exam = await api(`/student/state?token=${encodeURIComponent(state.studentToken)}`);
  state.remaining = state.exam.remaining;
  const backupKey = examBackupKey();
  const backup = JSON.parse(localStorage.getItem(backupKey) || '{}');
  state.exam.attempt.answers = { ...backup, ...(state.exam.attempt.answers || {}) };
}

function examBackupKey() {
  return state.exam ? `ygExamBackup:${state.exam.room.id}:${state.exam.attempt.studentNo}` : 'ygExamBackup';
}

function renderExamReady() {
  state.view = 'exam-ready';
  app.innerHTML = `<div class="student-shell">${topbar('')}<main class="container"><section class="card auth-wrap"><h2>${esc(state.exam.room.title)}</h2><p class="muted">${esc(state.exam.attempt.studentNo)} ${esc(state.exam.attempt.studentName)} · 제한시간 ${state.exam.room.durationMin}분</p><div class="notice" style="margin:18px 0">시작 버튼을 누르면 제한시간이 바로 시작됩니다.${state.exam.room.requireFullscreen ? ' 전체화면 전환이 필수입니다.' : ''}</div><button class="primary" id="start-exam" style="width:100%;font-size:18px">시험 시작</button></section></main></div>`;
  document.getElementById('start-exam').onclick = async () => {
    try {
      if (state.exam.room.requireFullscreen) await document.documentElement.requestFullscreen();
      await api('/student/start', { method: 'POST', body: { token: state.studentToken } });
      await loadExamState(); startExamUi();
    } catch (error) { toast(error.message, true); }
  };
}

function startExamUi() {
  clearExamTimers();
  state.view = 'exam'; state.guardActive = true; state.submitted = false;
  renderExam();
  updateFullscreenLock();
  state.examTimer = setInterval(() => {
    state.remaining = Math.max(0, state.remaining - 1);
    updateTimerDisplay();
    if (state.remaining <= 0) submitExam(true);
  }, 1000);
  state.autosaveTimer = setInterval(saveExamAnswers, 5000);
  state.heartbeatTimer = setInterval(heartbeat, 8000);
}

function renderExam() {
  const answers = state.exam.attempt.answers || {};
  app.innerHTML = `<div class="student-shell"><header class="exam-topbar"><div><div class="exam-title">${esc(state.exam.room.title)}</div><small>${esc(state.exam.attempt.studentNo)} ${esc(state.exam.attempt.studentName)}</small></div><div id="timer" class="timer">${formatSeconds(state.remaining)}</div></header><main class="exam-container">${state.exam.questions.map((q) => examQuestionHtml(q, answers[q.id] || '')).join('')}</main><div class="exam-actions"><button class="ghost" id="save-now">임시저장</button><button class="primary" id="submit-exam">완료·제출</button></div></div>`;
  document.querySelectorAll('[data-answer]').forEach((el) => {
    el.oninput = () => updateAnswerFromElement(el);
    el.onchange = () => updateAnswerFromElement(el);
  });
  document.querySelectorAll('[data-ox]').forEach((button) => button.onclick = () => {
    state.exam.attempt.answers[button.dataset.oxQuestion] = button.dataset.ox;
    localStorage.setItem(examBackupKey(), JSON.stringify(state.exam.attempt.answers));
    renderExam(); updateTimerDisplay();
  });
  document.getElementById('save-now').onclick = async () => { await saveExamAnswers(); toast('현재 답안을 저장했습니다.'); };
  document.getElementById('submit-exam').onclick = () => { if (confirm('제출 후에는 수정할 수 없습니다. 제출하시겠습니까?')) submitExam(false); };
  updateTimerDisplay();
}

function examQuestionHtml(q, value) {
  let answer = '';
  if (q.type === 'short') answer = `<input class="answer-short" data-answer data-qid="${q.id}" value="${esc(value)}" autocomplete="off">`;
  if (q.type === 'long' || q.type === 'essay') answer = `<textarea class="answer-long" data-answer data-qid="${q.id}">${esc(value)}</textarea>`;
  if (q.type === 'choice5') answer = (q.choices || []).map((choice, i) => `<label class="choice-option"><input type="radio" data-answer data-qid="${q.id}" name="q-${q.id}" value="${i + 1}" ${String(value) === String(i + 1) ? 'checked' : ''}><span>${i + 1}. ${esc(choice)}</span></label>`).join('');
  if (q.type === 'ox') answer = `<div class="ox-wrap"><button class="ox-button ${value === 'O' ? 'selected' : ''}" data-ox-question="${q.id}" data-ox="O">O</button><button class="ox-button ${value === 'X' ? 'selected' : ''}" data-ox-question="${q.id}" data-ox="X">X</button></div>`;
  return `<section class="exam-question"><h3>${q.order}번 <span class="muted" style="font-size:13px">${esc(qTypeLabel[q.type])}</span></h3><div class="prompt">${esc(q.prompt)}</div>${answer}</section>`;
}

function updateAnswerFromElement(el) {
  if (el.type === 'radio' && !el.checked) return;
  state.exam.attempt.answers[el.dataset.qid] = el.value;
  localStorage.setItem(examBackupKey(), JSON.stringify(state.exam.attempt.answers));
}

async function saveExamAnswers() {
  if (!state.guardActive || state.submitted) return;
  try {
    const result = await api('/student/save', { method: 'POST', body: { token: state.studentToken, answers: state.exam.attempt.answers } });
    if (result.reason === 'expired') submitExam(true);
    if (result.reason === 'locked') showExamLocked('교사가 답안 입력을 잠갔습니다.');
  } catch (error) { console.warn(error); }
}

async function heartbeat() {
  if (!state.guardActive || state.submitted) return;
  try {
    const result = await api('/student/heartbeat', { method: 'POST', body: { token: state.studentToken } });
    if (result.expired || result.attemptStatus === 'submitted') return submitExam(true);
    if (result.roomStatus === 'ended' || result.answersLocked) showExamLocked('시험이 종료되었거나 답안 입력이 잠겼습니다.');
  } catch { }
}

async function submitExam(auto) {
  if (state.submitted) return;
  state.submitted = true;
  try {
    await api('/student/submit', { method: 'POST', body: { token: state.studentToken, answers: state.exam.attempt.answers, auto } });
  } catch (error) {
    state.submitted = false; return toast(error.message, true);
  }
  state.guardActive = false; clearExamTimers(); fullscreenLock.classList.add('hidden');
  localStorage.removeItem(examBackupKey()); localStorage.removeItem('ygStudentToken'); state.studentToken = '';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  app.innerHTML = `<div class="student-shell">${topbar('')}<main class="container"><section class="card auth-wrap" style="text-align:center"><h2>${auto ? '시간이 종료되어 자동 제출되었습니다.' : '제출이 완료되었습니다.'}</h2><p class="muted">답안이 저장되었습니다. 시험 창을 닫아도 됩니다.</p><button class="ghost" id="done-home">처음으로</button></section></main></div>`;
  document.getElementById('done-home').onclick = renderLanding;
}

function showExamLocked(message) {
  state.guardActive = false; clearExamTimers();
  app.innerHTML = `<div class="student-shell">${topbar('')}<main class="container"><section class="card auth-wrap" style="text-align:center"><h2>답안 입력이 잠겼습니다</h2><p class="muted">${esc(message)}</p></section></main></div>`;
}

function updateTimerDisplay() {
  const el = document.getElementById('timer');
  if (!el) return;
  el.textContent = formatSeconds(state.remaining);
  el.classList.toggle('warning', state.remaining <= 300);
}

function formatSeconds(seconds) {
  const min = Math.floor(Math.max(0, seconds) / 60);
  const sec = Math.max(0, seconds) % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function updateFullscreenLock() {
  if (!state.guardActive || !state.exam?.room?.requireFullscreen) {
    fullscreenLock.classList.add('hidden'); return;
  }
  fullscreenLock.classList.toggle('hidden', Boolean(document.fullscreenElement));
}

async function guardEvent(type, detail = '') {
  if (!state.guardActive || state.submitted) return;
  const last = state.lastGuardEvent[type] || 0;
  if (Date.now() - last < 900) return;
  state.lastGuardEvent[type] = Date.now();
  api('/student/event', { method: 'POST', body: { token: state.studentToken, type, detail } }).catch(() => {});
}

document.addEventListener('fullscreenchange', () => {
  if (state.guardActive && state.exam?.room?.requireFullscreen && !document.fullscreenElement) guardEvent('fullscreen_exit', '전체화면이 해제됨');
  updateFullscreenLock();
});
window.addEventListener('blur', () => guardEvent('blur', '시험 창 포커스 이탈'));
document.addEventListener('visibilitychange', () => { if (document.hidden) guardEvent('visibility_hidden', '시험 화면이 보이지 않음'); });
['copy', 'paste', 'cut'].forEach((type) => document.addEventListener(type, (e) => { if (!state.guardActive) return; e.preventDefault(); guardEvent(type, `${type} 시도 차단`); }));
document.addEventListener('contextmenu', (e) => { if (!state.guardActive) return; e.preventDefault(); guardEvent('contextmenu', '우클릭 시도 차단'); });
document.addEventListener('keydown', (e) => {
  if (!state.guardActive) return;
  const key = e.key.toLowerCase();
  const dev = e.key === 'F12' || (e.ctrlKey && e.shiftKey && ['i', 'j', 'c'].includes(key)) || (e.ctrlKey && key === 'u');
  if (dev) { e.preventDefault(); guardEvent('devtools_key', '개발자도구 관련 단축키 시도 차단'); }
});
window.addEventListener('offline', () => guardEvent('offline', '인터넷 연결 끊김'));
window.addEventListener('online', () => guardEvent('online', '인터넷 연결 복구'));
document.getElementById('return-fullscreen').onclick = () => document.documentElement.requestFullscreen().catch(() => {});

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function formatTime(value) {
  if (!value) return '-';
  return new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function safeFilename(value) { return String(value || '파일').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80); }
function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function fileToBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }); }

renderLanding();
