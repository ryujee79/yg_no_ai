(() => {
  let parsedStudents = null;
  let parsedMeta = null;

  function notify(message, error = false) {
    const el = document.getElementById('toast');
    if (!el) return alert(message);
    el.textContent = message;
    el.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(el._studentRosterTimer);
    el._studentRosterTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
  }

  function classInfo(value) {
    const text = String(value ?? '').trim().replace(/\s+/g, '');
    let m = text.match(/^(\d+)-(\d+)$/);
    if (!m) m = text.match(/^(\d+)학년(\d+)반$/);
    if (!m) return null;
    const grade = Number(m[1]);
    const classNo = Number(m[2]);
    if (!Number.isInteger(grade) || !Number.isInteger(classNo) || grade < 1 || grade > 9 || classNo < 1 || classNo > 9) return null;
    return { grade, classNo, label: `${grade}-${classNo}` };
  }

  function cleanNumber(value) {
    const digits = String(value ?? '').replace(/[^0-9]/g, '');
    if (!digits) return null;
    const n = Number(digits);
    if (!Number.isInteger(n) || n < 1 || n > 99) return null;
    return n;
  }

  function parseSchoolRoster(rows) {
    let headerRow = -1;
    let classColumns = [];

    for (let r = 0; r < Math.min(rows.length, 10); r += 1) {
      const found = [];
      for (let c = 1; c < (rows[r]?.length || 0); c += 1) {
        const info = classInfo(rows[r][c]);
        if (info) found.push({ col: c, ...info });
      }
      if (found.length >= 2) {
        headerRow = r;
        classColumns = found;
        break;
      }
    }

    if (headerRow < 0 || !classColumns.length) return null;

    const students = [];
    const seen = new Set();
    let duplicateCount = 0;

    // 학년·반 행 바로 다음 행은 담임명, 그 다음 행부터 학생 데이터로 봅니다.
    for (let r = headerRow + 2; r < rows.length; r += 1) {
      const number = cleanNumber(rows[r]?.[0]);
      if (!number) continue;

      for (const cls of classColumns) {
        const rawName = rows[r]?.[cls.col];
        const name = String(rawName ?? '').trim();
        if (!name) continue;

        const studentNo = `${cls.grade}${cls.classNo}${String(number).padStart(2, '0')}`;
        if (seen.has(studentNo)) {
          duplicateCount += 1;
          continue;
        }
        seen.add(studentNo);
        students.push({ studentNo, name });
      }
    }

    students.sort((a, b) => a.studentNo.localeCompare(b.studentNo));
    return {
      students,
      meta: {
        mode: 'school-roster',
        classCount: classColumns.length,
        headerExcelRow: headerRow + 1,
        duplicateCount,
      },
    };
  }

  function parseSimpleTwoColumn(rows) {
    if (!rows.length) return { students: [], meta: { mode: 'simple', classCount: 0, duplicateCount: 0 } };
    const students = [];
    const seen = new Set();
    let duplicateCount = 0;
    let start = 0;
    const a0 = String(rows[0]?.[0] ?? '').replace(/\s+/g, '');
    const b0 = String(rows[0]?.[1] ?? '').replace(/\s+/g, '');
    if (/학번|학생번호/.test(a0) && /이름|성명/.test(b0)) start = 1;

    for (let r = start; r < rows.length; r += 1) {
      const studentNo = String(rows[r]?.[0] ?? '').replace(/\D/g, '').slice(-4);
      const name = String(rows[r]?.[1] ?? '').trim();
      if (!/^\d{4}$/.test(studentNo) || !name) continue;
      if (seen.has(studentNo)) { duplicateCount += 1; continue; }
      seen.add(studentNo);
      students.push({ studentNo, name });
    }
    students.sort((a, b) => a.studentNo.localeCompare(b.studentNo));
    return { students, meta: { mode: 'simple', classCount: 0, duplicateCount } };
  }

  async function parseFile(file) {
    if (!file) throw new Error('학생 명단 파일을 선택해 주세요.');
    if (!window.XLSX) throw new Error('Excel 읽기 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.');
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    return parseSchoolRoster(rows) || parseSimpleTwoColumn(rows);
  }

  function setPreview(result) {
    parsedStudents = result.students;
    parsedMeta = result.meta;
    const preview = document.getElementById('v3-student-preview');
    const importBtn = document.getElementById('v3-import-students');
    const replaceBtn = document.getElementById('v3-replace-students');
    if (preview) {
      if (parsedMeta.mode === 'school-roster') {
        preview.textContent = `${parsedMeta.classCount}개 학급 · 학생 ${parsedStudents.length}명 인식 · 학번 자동 생성`;
      } else {
        preview.textContent = `학생 ${parsedStudents.length}명 인식`;
      }
    }
    if (importBtn) importBtn.disabled = !parsedStudents.length;
    if (replaceBtn) replaceBtn.disabled = !parsedStudents.length;
  }

  async function submit(mode) {
    if (!parsedStudents?.length) return notify('먼저 학생 명단 파일을 선택해 주세요.', true);
    if (mode === 'replace' && !confirm(`기존 학생 계정을 모두 지우고 ${parsedStudents.length}명으로 새로 등록할까요?`)) return;

    const token = localStorage.getItem('ygAdminToken') || '';
    const path = mode === 'replace' ? '/api/admin/replace-students' : '/api/admin/import-students';
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, students: parsedStudents }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '학생 명단 등록 중 오류가 발생했습니다.');

    const reflected = (data.added || 0) + (data.updated || 0);
    notify(mode === 'replace' ? `학생 ${data.added || parsedStudents.length}명으로 교체했습니다.` : `학생 ${reflected}명을 반영했습니다.`);

    // 기존 관리자 화면의 재렌더링 조건을 초기화하고 DOM 변화를 한 번 발생시켜 목록/인원수를 갱신합니다.
    const main = document.querySelector('main.container');
    if (main) main.dataset.adminV3 = '';
    const ping = document.createElement('span');
    ping.hidden = true;
    document.body.appendChild(ping);
    requestAnimationFrame(() => ping.remove());
  }

  document.addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.id !== 'v3-student-file') return;
    event.stopImmediatePropagation();
    try {
      const result = await parseFile(target.files?.[0]);
      if (!result.students.length) throw new Error('학생을 한 명도 인식하지 못했습니다. 3행의 학년·반과 A열 번호를 확인해 주세요.');
      setPreview(result);
    } catch (error) {
      parsedStudents = null;
      parsedMeta = null;
      const preview = document.getElementById('v3-student-preview');
      if (preview) preview.textContent = '';
      notify(error instanceof Error ? error.message : '학생 명단을 읽지 못했습니다.', true);
    }
  }, true);

  document.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    if (target.id !== 'v3-import-students' && target.id !== 'v3-replace-students') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      await submit(target.id === 'v3-replace-students' ? 'replace' : 'import');
    } catch (error) {
      notify(error instanceof Error ? error.message : '학생 명단 등록 중 오류가 발생했습니다.', true);
    }
  }, true);
})();