import type { Config, Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';

declare const Netlify: any;

type Dict = Record<string, any>;

type Teacher = {
  id: string;
  name: string;
  extHash: string;
  createdAt: string;
};

type RosterStudent = {
  studentNo: string;
  name: string;
  birthHash: string | null;
};

type Roster = {
  id: string;
  teacherId: string;
  year: number;
  grade: number;
  classNo: number;
  label: string;
  students: RosterStudent[];
  createdAt: string;
};

type Question = {
  id: string;
  order: number;
  type: 'essay' | 'short' | 'long' | 'choice5' | 'ox';
  prompt: string;
  choices: string[];
  points: number;
};

type Paper = {
  id: string;
  teacherId: string;
  year: number;
  title: string;
  subject: string;
  sourceName?: string | null;
  sourceKey?: string | null;
  questions: Question[];
  createdAt: string;
  updatedAt: string;
};

type Room = {
  id: string;
  teacherId: string;
  year: number;
  paperId: string;
  rosterId: string | null;
  code: string;
  title: string;
  durationMin: number;
  authMode: 'birth' | 'name' | 'nickname';
  requireFullscreen: boolean;
  status: 'waiting' | 'running' | 'ended';
  entryOpen: boolean;
  answersLocked: boolean;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
};

type Attempt = {
  id: string;
  roomId: string;
  studentNo: string;
  studentName: string;
  rosterStudent: boolean;
  status: 'entered' | 'in_progress' | 'submitted';
  startedAt: string | null;
  submittedAt: string | null;
  deadlineAt: string | null;
  lastSeenAt: string;
  violationCount: number;
  answers: Record<string, string>;
  createdAt: string;
};

type ProctorEvent = {
  id: string;
  roomId: string;
  attemptId: string;
  studentNo: string;
  studentName: string;
  type: string;
  detail: string;
  gapSeconds?: number | null;
  createdAt: string;
};

function dataStore() {
  const context = Netlify?.context?.deploy?.context;
  if (context === 'production') {
    return getStore('yg-exam-data', { consistency: 'strong' });
  }
  return getDeployStore('yg-exam-data');
}

function fileStore() {
  const context = Netlify?.context?.deploy?.context;
  if (context === 'production') {
    return getStore('yg-exam-files', { consistency: 'strong' });
  }
  return getDeployStore('yg-exam-files');
}

function now() {
  return new Date().toISOString();
}

function normalizeName(value: string) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function normalizeBirth(value: string) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 6) {
    const yy = Number(digits.slice(0, 2));
    return `${yy > 30 ? '19' : '20'}${digits}`;
  }
  return digits;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(`yg-no-ai-v1::${value}`);
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

function cleanStudentNo(value: string) {
  return String(value || '').replace(/\D/g, '').slice(-4).padStart(4, '0');
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function fail(message: string, status = 400) {
  return json({ error: message }, status);
}

async function bodyOf(req: Request): Promise<Dict> {
  try {
    return (await req.json()) as Dict;
  } catch {
    return {};
  }
}

async function getJSON<T>(key: string): Promise<T | null> {
  return (await dataStore().get(key, { type: 'json' })) as T | null;
}

async function setJSON(key: string, value: any) {
  await dataStore().setJSON(key, value);
}

async function listJSON<T>(prefix: string): Promise<T[]> {
  const store = dataStore();
  const result = await store.list({ prefix });
  const values: T[] = [];
  for (const blob of result.blobs) {
    const item = (await store.get(blob.key, { type: 'json' })) as T | null;
    if (item) values.push(item);
  }
  return values;
}

async function teacherFromToken(token: string): Promise<Teacher> {
  if (!token) throw new Error('교사 로그인이 필요합니다.');
  const key = `session/teacher/${await sha256(token)}.json`;
  const session = await getJSON<{ teacherId: string; expiresAt: string }>(key);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    throw new Error('교사 로그인 세션이 만료되었습니다.');
  }
  const teacher = await getJSON<Teacher>(`teacher/${session.teacherId}.json`);
  if (!teacher) throw new Error('교사 정보를 찾을 수 없습니다.');
  return teacher;
}

async function attemptFromToken(token: string) {
  if (!token) throw new Error('학생 응시 세션이 없습니다.');
  const session = await getJSON<{ roomId: string; studentNo: string }>(
    `session/student/${await sha256(token)}.json`,
  );
  if (!session) throw new Error('학생 응시 세션이 만료되었습니다.');
  const attemptKey = `attempt/${session.roomId}/${session.studentNo}.json`;
  const attempt = await getJSON<Attempt>(attemptKey);
  const room = await getJSON<Room>(`room/${session.roomId}.json`);
  if (!attempt || !room) throw new Error('응시 정보를 찾을 수 없습니다.');
  return { attempt, room, attemptKey };
}

async function issueTeacherSession(teacherId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await setJSON(`session/teacher/${await sha256(token)}.json`, { teacherId, expiresAt });
  return token;
}

async function issueStudentSession(roomId: string, studentNo: string) {
  const token = randomToken();
  await setJSON(`session/student/${await sha256(token)}.json`, { roomId, studentNo });
  return token;
}

async function uniqueRoomCode() {
  for (let i = 0; i < 12; i += 1) {
    const code = randomRoomCode();
    const existing = await getJSON(`room-code/${code}.json`);
    if (!existing) return code;
  }
  throw new Error('접속 코드 생성에 실패했습니다. 다시 시도해 주세요.');
}

async function getRoomByCode(code: string) {
  const normalized = String(code || '').trim().toUpperCase();
  const ref = await getJSON<{ roomId: string }>(`room-code/${normalized}.json`);
  if (!ref) return null;
  return await getJSON<Room>(`room/${ref.roomId}.json`);
}

async function getTeacherOwnedRoom(token: string, roomId: string) {
  const teacher = await teacherFromToken(token);
  const room = await getJSON<Room>(`room/${roomId}.json`);
  if (!room || room.teacherId !== teacher.id) throw new Error('시험방을 찾을 수 없습니다.');
  return { teacher, room };
}

async function logEvent(attempt: Attempt, room: Room, type: string, detail = '', gapSeconds: number | null = null) {
  const event: ProctorEvent = {
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
  await setJSON(`event/${room.id}/${Date.now()}-${event.id}.json`, event);
}

async function route(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = req.method.toUpperCase();

  if (method === 'GET' && path === '/health') {
    return json({ ok: true, time: now() });
  }

  if (method === 'POST' && path === '/teacher/register') {
    const body = await bodyOf(req);
    const name = normalizeName(body.name);
    const ext = String(body.ext || '');
    if (!name) return fail('이름을 입력해 주세요.');
    if (!/^\d{4}$/.test(ext)) return fail('내선번호는 숫자 4자리로 입력해 주세요.');
    const indexKey = `teacher-index/${await sha256(name)}.json`;
    const existing = await getJSON<{ teacherId: string }>(indexKey);
    if (existing) return fail('이미 등록된 교사입니다. 로그인해 주세요.');
    const teacher: Teacher = {
      id: crypto.randomUUID(),
      name,
      extHash: await sha256(ext),
      createdAt: now(),
    };
    await setJSON(`teacher/${teacher.id}.json`, teacher);
    await setJSON(indexKey, { teacherId: teacher.id });
    const token = await issueTeacherSession(teacher.id);
    return json({ token, teacher: { id: teacher.id, name: teacher.name } });
  }

  if (method === 'POST' && path === '/teacher/login') {
    const body = await bodyOf(req);
    const name = normalizeName(body.name);
    const ext = String(body.ext || '');
    const index = await getJSON<{ teacherId: string }>(`teacher-index/${await sha256(name)}.json`);
    if (!index) return fail('이름 또는 내선번호가 올바르지 않습니다.', 401);
    const teacher = await getJSON<Teacher>(`teacher/${index.teacherId}.json`);
    if (!teacher || teacher.extHash !== (await sha256(ext))) {
      return fail('이름 또는 내선번호가 올바르지 않습니다.', 401);
    }
    const token = await issueTeacherSession(teacher.id);
    return json({ token, teacher: { id: teacher.id, name: teacher.name } });
  }

  if (method === 'POST' && path === '/teacher/me') {
    const body = await bodyOf(req);
    const teacher = await teacherFromToken(body.token);
    return json({ id: teacher.id, name: teacher.name });
  }

  if (method === 'GET' && path === '/teacher/rosters') {
    const teacher = await teacherFromToken(url.searchParams.get('token') || '');
    const rosters = await listJSON<Roster>(`roster/${teacher.id}/`);
    rosters.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json(rosters.map((r) => ({ ...r, studentCount: r.students.length })));
  }

  if (method === 'POST' && path === '/teacher/rosters') {
    const body = await bodyOf(req);
    const teacher = await teacherFromToken(body.token);
    const studentsRaw = Array.isArray(body.students) ? body.students : [];
    if (!studentsRaw.length) return fail('학생 명단에서 학생을 찾지 못했습니다.');
    const students: RosterStudent[] = [];
    for (const student of studentsRaw) {
      const studentNo = cleanStudentNo(student.studentNo);
      const name = normalizeName(student.name);
      if (!studentNo || !name) continue;
      const birth = normalizeBirth(student.birth || '');
      students.push({
        studentNo,
        name,
        birthHash: birth ? await sha256(birth) : null,
      });
    }
    const roster: Roster = {
      id: crypto.randomUUID(),
      teacherId: teacher.id,
      year: Number(body.year) || new Date().getFullYear(),
      grade: Number(body.grade) || 1,
      classNo: Number(body.classNo) || 1,
      label: `${Number(body.year) || new Date().getFullYear()}학년도 ${Number(body.grade) || 1}학년 ${Number(body.classNo) || 1}반`,
      students,
      createdAt: now(),
    };
    await setJSON(`roster/${teacher.id}/${roster.id}.json`, roster);
    return json(roster);
  }

  if (method === 'DELETE' && path === '/teacher/rosters') {
    const token = url.searchParams.get('token') || '';
    const id = url.searchParams.get('id') || '';
    const teacher = await teacherFromToken(token);
    await dataStore().delete(`roster/${teacher.id}/${id}.json`);
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/teacher/papers') {
    const teacher = await teacherFromToken(url.searchParams.get('token') || '');
    const papers = await listJSON<Paper>(`paper/${teacher.id}/`);
    papers.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return json(papers);
  }

  if (method === 'POST' && path === '/teacher/papers') {
    const body = await bodyOf(req);
    const teacher = await teacherFromToken(body.token);
    const previous = body.id
      ? await getJSON<Paper>(`paper/${teacher.id}/${body.id}.json`)
      : null;
    const id = previous?.id || crypto.randomUUID();
    const questions: Question[] = (Array.isArray(body.questions) ? body.questions : []).map(
      (q: Dict, index: number) => ({
        id: q.id || crypto.randomUUID(),
        order: index + 1,
        type: ['essay', 'short', 'long', 'choice5', 'ox'].includes(q.type) ? q.type : 'short',
        prompt: String(q.prompt || ''),
        choices: Array.isArray(q.choices) ? q.choices.slice(0, 5).map(String) : [],
        points: Number(q.points) || 0,
      }),
    );
    const paper: Paper = {
      id,
      teacherId: teacher.id,
      year: Number(body.year) || new Date().getFullYear(),
      title: String(body.title || '제목 없는 시험지').trim(),
      subject: String(body.subject || '').trim(),
      sourceName: body.sourceName || previous?.sourceName || null,
      sourceKey: body.sourceKey || previous?.sourceKey || null,
      questions,
      createdAt: previous?.createdAt || now(),
      updatedAt: now(),
    };
    await setJSON(`paper/${teacher.id}/${paper.id}.json`, paper);
    return json(paper);
  }

  if (method === 'POST' && path === '/teacher/papers/copy') {
    const body = await bodyOf(req);
    const teacher = await teacherFromToken(body.token);
    const paper = await getJSON<Paper>(`paper/${teacher.id}/${body.id}.json`);
    if (!paper) return fail('시험지를 찾을 수 없습니다.', 404);
    const copy: Paper = {
      ...paper,
      id: crypto.randomUUID(),
      title: `${paper.title} (사본)`,
      questions: paper.questions.map((q) => ({ ...q, id: crypto.randomUUID() })),
      createdAt: now(),
      updatedAt: now(),
    };
    await setJSON(`paper/${teacher.id}/${copy.id}.json`, copy);
    return json(copy);
  }

  if (method === 'DELETE' && path === '/teacher/papers') {
    const teacher = await teacherFromToken(url.searchParams.get('token') || '');
    const id = url.searchParams.get('id') || '';
    const rooms = await listJSON<Room>(`room-owner/${teacher.id}/`);
    if (rooms.some((room) => room.paperId === id)) {
      return fail('이 시험지를 사용하는 시험방이 있어 삭제할 수 없습니다.');
    }
    await dataStore().delete(`paper/${teacher.id}/${id}.json`);
    return json({ ok: true });
  }

  if (method === 'POST' && path === '/teacher/file') {
    const body = await bodyOf(req);
    const teacher = await teacherFromToken(body.token);
    if (!body.base64 || !body.filename) return fail('파일 데이터가 없습니다.');
    const buffer = Buffer.from(String(body.base64), 'base64');
    if (buffer.byteLength > 6 * 1024 * 1024) {
      return fail('원본 파일 보관은 현재 6MB 이하 파일만 지원합니다. 문제 추출과 시험 생성은 그대로 가능합니다.');
    }
    const key = `${teacher.id}/${crypto.randomUUID()}-${String(body.filename).replace(/[^0-9A-Za-z._가-힣-]/g, '_')}`;
    const sliced = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    await fileStore().set(key, sliced);
    return json({ key });
  }

  if (method === 'GET' && path === '/teacher/rooms') {
    const teacher = await teacherFromToken(url.searchParams.get('token') || '');
    const rooms = await listJSON<Room>(`room-owner/${teacher.id}/`);
    const result = [];
    for (const room of rooms) {
      const paper = await getJSON<Paper>(`paper/${teacher.id}/${room.paperId}.json`);
      const roster = room.rosterId
        ? await getJSON<Roster>(`roster/${teacher.id}/${room.rosterId}.json`)
        : null;
      result.push({ ...room, paperTitle: paper?.title || '', rosterLabel: roster?.label || '' });
    }
    result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json(result);
  }

  if (method === 'POST' && path === '/teacher/rooms') {
    const body = await bodyOf(req);
    const teacher = await teacherFromToken(body.token);
    const paper = await getJSON<Paper>(`paper/${teacher.id}/${body.paperId}.json`);
    if (!paper) return fail('시험지를 선택해 주세요.');
    if (body.authMode === 'birth' && !body.rosterId) {
      return fail('생년월일 인증을 사용하려면 학생명단을 선택해야 합니다.');
    }
    const code = await uniqueRoomCode();
    const room: Room = {
      id: crypto.randomUUID(),
      teacherId: teacher.id,
      year: Number(body.year) || new Date().getFullYear(),
      paperId: body.paperId,
      rosterId: body.rosterId || null,
      code,
      title: String(body.title || paper.title),
      durationMin: Math.max(1, Number(body.durationMin) || 50),
      authMode: ['birth', 'name', 'nickname'].includes(body.authMode) ? body.authMode : 'birth',
      requireFullscreen: body.requireFullscreen !== false,
      status: 'waiting',
      entryOpen: true,
      answersLocked: false,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
    };
    await setJSON(`room/${room.id}.json`, room);
    await setJSON(`room-owner/${teacher.id}/${room.id}.json`, room);
    await setJSON(`room-code/${code}.json`, { roomId: room.id });
    return json(room);
  }

  if (method === 'POST' && path === '/teacher/rooms/clone') {
    const body = await bodyOf(req);
    const { teacher, room: source } = await getTeacherOwnedRoom(body.token, body.roomId);
    const code = await uniqueRoomCode();
    const room: Room = {
      ...source,
      id: crypto.randomUUID(),
      code,
      rosterId: body.rosterId || null,
      title: String(body.title || source.title),
      status: 'waiting',
      entryOpen: true,
      answersLocked: false,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
    };
    if (room.authMode === 'birth' && !room.rosterId) {
      return fail('생년월일 인증을 사용하려면 학생명단을 선택해야 합니다.');
    }
    await setJSON(`room/${room.id}.json`, room);
    await setJSON(`room-owner/${teacher.id}/${room.id}.json`, room);
    await setJSON(`room-code/${code}.json`, { roomId: room.id });
    return json(room);
  }

  if (method === 'POST' && path === '/teacher/rooms/update') {
    const body = await bodyOf(req);
    const { teacher, room } = await getTeacherOwnedRoom(body.token, body.roomId);
    const patch = body.patch || {};
    if (typeof patch.entryOpen === 'boolean') room.entryOpen = patch.entryOpen;
    if (typeof patch.answersLocked === 'boolean') room.answersLocked = patch.answersLocked;
    if (patch.status && ['waiting', 'running', 'ended'].includes(patch.status)) {
      room.status = patch.status;
      if (patch.status === 'running' && !room.startedAt) room.startedAt = now();
      if (patch.status === 'ended') {
        room.endedAt = now();
        room.entryOpen = false;
        room.answersLocked = true;
        const attempts = await listJSON<Attempt>(`attempt/${room.id}/`);
        for (const attempt of attempts) {
          if (attempt.status !== 'submitted') {
            attempt.status = 'submitted';
            attempt.submittedAt = now();
            await setJSON(`attempt/${room.id}/${attempt.studentNo}.json`, attempt);
          }
        }
      }
    }
    await setJSON(`room/${room.id}.json`, room);
    await setJSON(`room-owner/${teacher.id}/${room.id}.json`, room);
    return json(room);
  }

  if (method === 'GET' && path === '/teacher/monitor') {
    const token = url.searchParams.get('token') || '';
    const roomId = url.searchParams.get('roomId') || '';
    const { teacher, room } = await getTeacherOwnedRoom(token, roomId);
    const paper = await getJSON<Paper>(`paper/${teacher.id}/${room.paperId}.json`);
    const roster = room.rosterId
      ? await getJSON<Roster>(`roster/${teacher.id}/${room.rosterId}.json`)
      : null;
    const attempts = await listJSON<Attempt>(`attempt/${room.id}/`);
    const events = await listJSON<ProctorEvent>(`event/${room.id}/`);
    events.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json({ room, paper, roster, attempts, events: events.slice(0, 500) });
  }

  if (method === 'POST' && path === '/teacher/reset-attempt') {
    const body = await bodyOf(req);
    const { room } = await getTeacherOwnedRoom(body.token, body.roomId);
    const studentNo = cleanStudentNo(body.studentNo);
    const attempt = await getJSON<Attempt>(`attempt/${room.id}/${studentNo}.json`);
    if (attempt) {
      await dataStore().delete(`attempt/${room.id}/${studentNo}.json`);
      const events = await dataStore().list({ prefix: `event/${room.id}/` });
      for (const item of events.blobs) {
        const event = (await dataStore().get(item.key, { type: 'json' })) as ProctorEvent | null;
        if (event?.studentNo === studentNo) await dataStore().delete(item.key);
      }
    }
    return json({ ok: true });
  }

  if (method === 'GET' && path === '/teacher/results') {
    const token = url.searchParams.get('token') || '';
    const roomId = url.searchParams.get('roomId') || '';
    const { teacher, room } = await getTeacherOwnedRoom(token, roomId);
    const paper = await getJSON<Paper>(`paper/${teacher.id}/${room.paperId}.json`);
    const roster = room.rosterId
      ? await getJSON<Roster>(`roster/${teacher.id}/${room.rosterId}.json`)
      : null;
    const attempts = await listJSON<Attempt>(`attempt/${room.id}/`);
    return json({ room, paper, roster, attempts });
  }

  if (method === 'POST' && path === '/student/find-room') {
    const body = await bodyOf(req);
    const room = await getRoomByCode(body.code);
    if (!room) return fail('접속 코드를 찾을 수 없습니다.', 404);
    return json({
      code: room.code,
      title: room.title,
      authMode: room.authMode,
      requireFullscreen: room.requireFullscreen,
      status: room.status,
      entryOpen: room.entryOpen,
      durationMin: room.durationMin,
    });
  }

  if (method === 'POST' && path === '/student/enter') {
    const body = await bodyOf(req);
    const room = await getRoomByCode(body.code);
    if (!room) return fail('접속 코드를 찾을 수 없습니다.', 404);
    if (room.status === 'ended') return fail('이미 종료된 시험입니다.');
    if (!room.entryOpen) return fail('현재 학생 입장이 차단되어 있습니다.');
    const studentNo = cleanStudentNo(body.studentNo);
    if (!/^\d{4}$/.test(studentNo)) return fail('학번은 숫자 4자리로 입력해 주세요.');
    const teacher = await getJSON<Teacher>(`teacher/${room.teacherId}.json`);
    if (!teacher) return fail('시험방 정보를 확인할 수 없습니다.');
    const roster = room.rosterId
      ? await getJSON<Roster>(`roster/${room.teacherId}/${room.rosterId}.json`)
      : null;
    const rosterStudent = roster?.students.find((student) => student.studentNo === studentNo) || null;
    if (roster && !rosterStudent) return fail('이 시험방의 학생명단에 없는 학번입니다.');
    const credential = String(body.credential || '');
    let studentName = rosterStudent?.name || normalizeName(credential);
    if (room.authMode === 'birth') {
      if (!rosterStudent?.birthHash) return fail('학생 생년월일 정보가 등록되어 있지 않습니다.');
      if ((await sha256(normalizeBirth(credential))) !== rosterStudent.birthHash) {
        return fail('생년월일이 일치하지 않습니다.', 401);
      }
    } else if (room.authMode === 'name') {
      if (rosterStudent && normalizeName(credential) !== normalizeName(rosterStudent.name)) {
        return fail('이름이 일치하지 않습니다.', 401);
      }
      studentName = rosterStudent?.name || normalizeName(credential);
    } else {
      if (!credential.trim()) return fail('별명을 입력해 주세요.');
      studentName = rosterStudent?.name || credential.trim();
    }
    const key = `attempt/${room.id}/${studentNo}.json`;
    let attempt = await getJSON<Attempt>(key);
    if (attempt?.status === 'submitted') return fail('이미 제출이 완료된 시험입니다.');
    if (attempt) {
      const gap = Math.max(0, Math.round((Date.now() - Date.parse(attempt.lastSeenAt)) / 1000));
      if (gap >= 10) await logEvent(attempt, room, 'reconnect', '재접속', gap);
      attempt.lastSeenAt = now();
      await setJSON(key, attempt);
    } else {
      attempt = {
        id: crypto.randomUUID(),
        roomId: room.id,
        studentNo,
        studentName,
        rosterStudent: Boolean(rosterStudent),
        status: 'entered',
        startedAt: null,
        submittedAt: null,
        deadlineAt: null,
        lastSeenAt: now(),
        violationCount: 0,
        answers: {},
        createdAt: now(),
      };
      await setJSON(key, attempt);
    }
    const token = await issueStudentSession(room.id, studentNo);
    return json({ token });
  }

  if (method === 'GET' && path === '/student/state') {
    const token = url.searchParams.get('token') || '';
    const { attempt, room, attemptKey } = await attemptFromToken(token);
    const paper = await getJSON<Paper>(`paper/${room.teacherId}/${room.paperId}.json`);
    attempt.lastSeenAt = now();
    await setJSON(attemptKey, attempt);
    const remaining = attempt.deadlineAt
      ? Math.max(0, Math.ceil((Date.parse(attempt.deadlineAt) - Date.now()) / 1000))
      : room.durationMin * 60;
    return json({
      attempt,
      room: {
        id: room.id,
        title: room.title,
        status: room.status,
        requireFullscreen: room.requireFullscreen,
        answersLocked: room.answersLocked,
        durationMin: room.durationMin,
      },
      questions: paper?.questions || [],
      remaining,
    });
  }

  if (method === 'POST' && path === '/student/start') {
    const body = await bodyOf(req);
    const { attempt, room, attemptKey } = await attemptFromToken(body.token);
    if (attempt.status === 'submitted') return fail('이미 제출된 시험입니다.');
    if (!attempt.startedAt) {
      attempt.startedAt = now();
      attempt.deadlineAt = new Date(Date.now() + room.durationMin * 60 * 1000).toISOString();
      attempt.status = 'in_progress';
      attempt.lastSeenAt = now();
      await setJSON(attemptKey, attempt);
      if (room.status === 'waiting') {
        room.status = 'running';
        room.startedAt = room.startedAt || now();
        await setJSON(`room/${room.id}.json`, room);
        await setJSON(`room-owner/${room.teacherId}/${room.id}.json`, room);
      }
    }
    return json({ ok: true });
  }

  if (method === 'POST' && path === '/student/save') {
    const body = await bodyOf(req);
    const { attempt, room, attemptKey } = await attemptFromToken(body.token);
    if (attempt.status === 'submitted') return json({ ok: false, reason: 'submitted' });
    if (room.status === 'ended' || room.answersLocked) return json({ ok: false, reason: 'locked' });
    if (attempt.deadlineAt && Date.parse(attempt.deadlineAt) <= Date.now()) {
      attempt.status = 'submitted';
      attempt.submittedAt = now();
      await setJSON(attemptKey, attempt);
      await logEvent(attempt, room, 'auto_submit', '시간 종료 자동 제출');
      return json({ ok: false, reason: 'expired' });
    }
    if (body.answers && typeof body.answers === 'object') {
      attempt.answers = { ...attempt.answers, ...body.answers };
    }
    attempt.status = 'in_progress';
    attempt.lastSeenAt = now();
    await setJSON(attemptKey, attempt);
    return json({ ok: true });
  }

  if (method === 'POST' && path === '/student/submit') {
    const body = await bodyOf(req);
    const { attempt, room, attemptKey } = await attemptFromToken(body.token);
    if (attempt.status === 'submitted') return json({ ok: true, already: true });
    if (body.answers && typeof body.answers === 'object') {
      attempt.answers = { ...attempt.answers, ...body.answers };
    }
    attempt.status = 'submitted';
    attempt.submittedAt = now();
    attempt.lastSeenAt = now();
    await setJSON(attemptKey, attempt);
    await logEvent(attempt, room, body.auto ? 'auto_submit' : 'submit', body.auto ? '시간 종료 자동 제출' : '학생 제출');
    return json({ ok: true, already: false });
  }

  if (method === 'POST' && path === '/student/event') {
    const body = await bodyOf(req);
    const { attempt, room, attemptKey } = await attemptFromToken(body.token);
    attempt.violationCount += 1;
    attempt.lastSeenAt = now();
    await setJSON(attemptKey, attempt);
    await logEvent(
      attempt,
      room,
      String(body.type || 'unknown'),
      String(body.detail || ''),
      Number.isFinite(Number(body.gapSeconds)) ? Number(body.gapSeconds) : null,
    );
    return json({ ok: true });
  }

  if (method === 'POST' && path === '/student/heartbeat') {
    const body = await bodyOf(req);
    const { attempt, room, attemptKey } = await attemptFromToken(body.token);
    attempt.lastSeenAt = now();
    const expired = Boolean(attempt.deadlineAt && Date.parse(attempt.deadlineAt) <= Date.now());
    if (expired && attempt.status !== 'submitted') {
      attempt.status = 'submitted';
      attempt.submittedAt = now();
      await logEvent(attempt, room, 'auto_submit', '시간 종료 자동 제출');
    }
    await setJSON(attemptKey, attempt);
    return json({
      expired,
      attemptStatus: attempt.status,
      roomStatus: room.status,
      answersLocked: room.answersLocked,
    });
  }

  return fail('요청 경로를 찾을 수 없습니다.', 404);
}

export default async (req: Request, _context: Context) => {
  try {
    return await route(req);
  } catch (error) {
    console.error(error);
    return fail(error instanceof Error ? error.message : '서버 오류가 발생했습니다.', 500);
  }
};

export const config: Config = {
  path: '/api/*',
};
