import { evaluateNorm, extractUniqueTestIds, buildTestLabel, getLevelClass } from './normEngine.js';
import { getTaskById, loadJson, resolveDataUrls, loadTestsCatalog } from './taskEngine.js';

const USERS_KEY = 'motor-testing-users';
const ACTIVE_USER_KEY = 'motor-testing-current-user';
const state = {
  users: [],
  currentUser: null,
  taskGuide: [],
  norms: [],
  currentTaskId: null,
  selectedStudentId: null,
  activeTab: 'student',
};

// Google OAuth client id (created in Google Cloud) — provided by user
const GOOGLE_CLIENT_ID = '186905345243-kmllfrlqu222q9tjiejd3vfeuo1q4o1h.apps.googleusercontent.com';

const elements = {
  authScreen: document.querySelector('#auth-screen'),
  authForm: document.querySelector('#auth-form'),
  authName: document.querySelector('#auth-name'),
  authEmail: document.querySelector('#auth-email'),
  authPassword: document.querySelector('#auth-password'),
  authMessage: document.querySelector('#auth-message'),
  teacherLoginButton: document.querySelector('#teacher-login-button'),
  appScreen: document.querySelector('#app-screen'),
  logoutButton: document.querySelector('#logout-button'),
  roleTabs: document.querySelectorAll('.tab-btn'),
  studentView: document.querySelector('#student-view'),
  teacherView: document.querySelector('#teacher-view'),
  profileForm: document.querySelector('#profile-form'),
  genderSelect: document.querySelector('#gender-select'),
  specializationInput: document.querySelector('#specialization-input'),
  profileSummary: document.querySelector('#profile-summary'),
  taskList: document.querySelector('#task-list'),
  taskTitle: document.querySelector('#task-title'),
  taskDescription: document.querySelector('#task-description'),
  taskStatus: document.querySelector('#task-status'),
  taskQuizResponse: document.querySelector('#task-quiz-response'),
  quizSubmit: document.querySelector('#quiz-submit'),
  quizFeedback: document.querySelector('#quiz-feedback'),
  testSelect: document.querySelector('#test-select'),
  resultInput: document.querySelector('#result-input'),
  evaluateButton: document.querySelector('#evaluate-button'),
  evaluationResult: document.querySelector('#evaluation-result'),
  onlineStatus: document.querySelector('#online-status'),
  teacherStudents: document.querySelector('#teacher-students'),
  teacherDetail: document.querySelector('#teacher-detail'),
  historyButton: document.querySelector('#history-button'),
  exportPassport: document.querySelector('#export-passport'),
  studentHistory: document.querySelector('#student-history'),
  studentHistoryList: document.querySelector('#student-history-list'),
};

function setOnlineStatus() {
  const isOnline = navigator.onLine;
  elements.onlineStatus.textContent = isOnline ? 'Online' : 'Offline';
  elements.onlineStatus.classList.toggle('online', isOnline);
  elements.onlineStatus.classList.toggle('offline', !isOnline);
}

function readStorage(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.warn(`Storage read error for ${key}:`, error);
    return fallback;
  }
}

function writeStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function ensureDemoUsers() {
  const existingUsers = readStorage(USERS_KEY, []);

  if (existingUsers.length) {
    state.users = existingUsers;
    return;
  }

  const defaultStudents = [
    {
      id: 'student-demo-1',
      name: 'Анна Коваль',
      email: 'student@demo.com',
      password: 'demo123',
      role: 'student',
      profile: {
        gender: 'female',
        specialization: 'Легка атлетика',
      },
      quizAnswers: [
        {
          taskId: 'task_1',
          taskName: 'Вимірювання швидкісних здібностей',
          answer: 'Для визначення швидкості використовують забіги на 30 м і 60 м, а також реакцію на старт.',
          createdAt: new Date().toISOString(),
        },
      ],
      results: [
        {
          testId: 'speed_sprint_30m',
          value: 5.2,
          levelNameUi: 'добрий',
          date: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
    },
  ];
  state.users = [...defaultStudents];
  writeStorage(USERS_KEY, state.users);
}

function loadCurrentUser() {
  const storedUser = readStorage(ACTIVE_USER_KEY, null);
  state.currentUser = storedUser ? state.users.find((user) => user.id === storedUser.id) || null : null;
}

function persistCurrentUser() {
  if (!state.currentUser) {
    localStorage.removeItem(ACTIVE_USER_KEY);
    return;
  }

  writeStorage(ACTIVE_USER_KEY, { id: state.currentUser.id, email: state.currentUser.email, role: state.currentUser.role });
}

function saveUsers() {
  writeStorage(USERS_KEY, state.users);
}

function setCurrentUser(user) {
  state.currentUser = user;
  persistCurrentUser();
  renderApplication();
}

function showAuthMessage(message, isError = false) {
  elements.authMessage.textContent = message;
  elements.authMessage.style.background = isError ? 'rgba(239,68,68,0.08)' : '#eef7ff';
  elements.authMessage.style.borderColor = isError ? 'rgba(239,68,68,0.25)' : '#d2e9ff';
  elements.authMessage.style.color = isError ? '#b91c1c' : '#0f172a';
}

function handleAuthSubmit(event) {
  event.preventDefault();
  const name = elements.authName.value.trim();
  const email = elements.authEmail.value.trim();
  const password = elements.authPassword.value.trim();

  if (!name || !email || !password) {
    showAuthMessage('Заповніть усі поля для реєстрації або входу.', true);
    return;
  }

  const normalizedEmail = email.toLowerCase();
  // require gmail addresses only
  if (!/^[^@\s]+@gmail\.com$/i.test(normalizedEmail)) {
    showAuthMessage('Реєстрація дозволена тільки через акаунти Gmail (закінчення @gmail.com).', true);
    return;
  }

  // simple password policy: min 8 chars, at least one letter and one digit
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(password)) {
    showAuthMessage('Пароль має містити принаймні 8 символів, одну літеру та одну цифру.', true);
    return;
  }
  let existingUser = state.users.find((user) => user.email.toLowerCase() === normalizedEmail);

  if (existingUser) {
    if (existingUser.password !== password) {
      showAuthMessage('Пароль не співпадає. Спробуйте ще раз.', true);
      return;
    }

    setCurrentUser(existingUser);
    showAuthMessage(`Ласкаво просимо, ${existingUser.name}!`);
    return;
  }

  // New registrations are always students
  const newUser = {
    id: `user-${Date.now()}`,
    name,
    email: normalizedEmail,
    password,
    role: 'student',
    profile: {
      gender: 'male',
      specialization: 'Легка атлетика',
    },
    quizAnswers: [],
    results: [],
    createdAt: new Date().toISOString(),
  };

  state.users.push(newUser);
  saveUsers();
  setCurrentUser(newUser);
  showAuthMessage(`Обліковий запис ${newUser.name} створено успішно.`);
}

function logout() {
  state.currentUser = null;
  localStorage.removeItem(ACTIVE_USER_KEY);
  renderApplication();
}

function handleTeacherLogin() {
  // Prompt Google Identity to sign in the teacher; do not auto-set any local demo user.
  if (window.google && google.accounts && google.accounts.id) {
    google.accounts.id.prompt();
    showAuthMessage('Будь ласка, увійдіть через Google акаунт викладача (athletica401@gmail.com).');
    return;
  }

  // Fallback: instruct user to use Google Sign-In button
  showAuthMessage('Використайте кнопку Google Sign‑In для входу як викладач.', true);
}

// --- Google Identity helpers ---
function parseJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

function normalizeGmail(email) {
  if (!email) return email;
  const parts = email.toLowerCase().split('@');
  if (parts.length !== 2) return email.toLowerCase();
  const [local, domain] = parts;
  if (domain === 'gmail.com') {
    const base = local.split('+')[0].replace(/\./g, '');
    return `${base}@gmail.com`;
  }
  return email.toLowerCase();
}

function initGoogleSignIn(clientId) {
  if (!clientId) return;
  // Render Google button when library loaded
  const tryInit = () => {
    if (!window.google || !google.accounts || !google.accounts.id) {
      // retry shortly if not yet loaded
      setTimeout(tryInit, 300);
      return;
    }

    google.accounts.id.initialize({
      client_id: clientId,
      callback: handleCredentialResponse,
    });

    const container = document.getElementById('googleSignIn');
    if (container) {
      google.accounts.id.renderButton(container, { theme: 'outline', size: 'large' });
    }
  };

  tryInit();
}

function handleCredentialResponse(response) {
  if (!response || !response.credential) return;
  const payload = parseJwt(response.credential);
  if (!payload || !payload.email) {
    showAuthMessage('Не вдалося отримати інформацію про користувача від Google.', true);
    return;
  }

  const email = payload.email.toLowerCase();
  const name = payload.name || email.split('@')[0];

  // Map Google account to app user; teacher whitelist keeps demo teacher
  const teacherWhitelist = Array.isArray(state.teachersWhitelist) ? state.teachersWhitelist : ['athletica401@gmail.com'];
  const normalizedEmail = normalizeGmail(email);
  const normalizedWhitelist = teacherWhitelist.map((e) => normalizeGmail(String(e).toLowerCase()));
  const role = teacherWhitelist.map((e) => String(e).toLowerCase()).includes(email) || normalizedWhitelist.includes(normalizedEmail) ? 'teacher' : 'student';

  let existing = state.users.find((u) => u.email.toLowerCase() === email);
  if (!existing) {
    existing = {
      id: `user-google-${payload.sub}`,
      name,
      email,
      role,
      profile: { gender: 'male', specialization: '' },
      quizAnswers: [],
      results: [],
      createdAt: new Date().toISOString(),
    };
    state.users.push(existing);
    saveUsers();
  }

  // If an existing user was found but their role is outdated, upgrade to teacher when whitelisted
  if (existing && role === 'teacher' && existing.role !== 'teacher') {
    existing.role = 'teacher';
    saveUsers();
  }

  // Save raw Google payload for debugging (helps verify which email Google returned)
  try {
    localStorage.setItem('motor-testing-last-google', JSON.stringify(payload));
  } catch (e) {}

  setCurrentUser(existing);
  showAuthMessage(`Увійшли як ${existing.name} (${existing.email}) — роль: ${existing.role}`);
}

function renderApplication() {
  const isLoggedIn = Boolean(state.currentUser);
  elements.authScreen.classList.toggle('hidden', isLoggedIn);
  elements.appScreen.classList.toggle('hidden', !isLoggedIn);
  elements.logoutButton.classList.toggle('hidden', !isLoggedIn);

  if (!isLoggedIn) {
    return;
  }

  const currentRole = state.currentUser.role || 'student';
  state.activeTab = currentRole === 'teacher' ? 'teacher' : 'student';

  elements.roleTabs.forEach((button) => {
    const isActive = button.dataset.role === state.activeTab;
    button.classList.toggle('active', isActive);
    button.disabled = currentRole === 'student' && button.dataset.role === 'teacher';
  });

  elements.studentView.classList.toggle('hidden', state.activeTab !== 'student');
  elements.teacherView.classList.toggle('hidden', state.activeTab !== 'teacher');

  if (state.currentUser.role === 'student') {
    renderStudentProfile();
    renderStudentView();
    return;
  }

  renderTeacherDashboard();
}

function renderStudentProfile() {
  if (!state.currentUser) {
    return;
  }

  const profile = state.currentUser.profile || { gender: 'male', specialization: 'Легка атлетика' };
  state.currentUser.profile = profile;
  elements.genderSelect.value = profile.gender || 'male';
  elements.specializationInput.value = profile.specialization || '';

  const genderText = profile.gender === 'male' ? 'Чоловіча' : 'Жіноча';
  elements.profileSummary.textContent = `Профіль: ${state.currentUser.name} • Стать: ${genderText} • Спеціалізація: ${profile.specialization || 'Не вказано'}`;
}

function renderStudentView() {
  if (!state.currentUser || state.currentUser.role !== 'student') {
    return;
  }

  renderTaskList();
  renderCurrentTask();
  renderTestOptions();
  renderStudentProfile();
}

function renderHistory() {
  if (!state.currentUser) return;

  const results = state.currentUser.results || [];
  const html = results.length
    ? results
        .map(
          (r) => `
          <div class="result-item">
            <strong>${buildTestLabel(r.testId)}</strong>
            <div>Результат: ${r.value}</div>
            <div>Рівень: ${r.levelNameUi || '-'}</div>
            <div class="detail-meta">${new Date(r.date).toLocaleString()}</div>
          </div>
        `
        )
        .join('')
    : '<p>Результати відсутні.</p>';

  if (elements.studentHistory && elements.studentHistoryList) {
    elements.studentHistoryList.innerHTML = html;
    elements.studentHistory.classList.remove('hidden');
    elements.studentHistory.scrollIntoView({ behavior: 'smooth' });
  }
}

function exportPassportJSON() {
  if (!state.currentUser) return;
  const passport = {
    id: state.currentUser.id,
    name: state.currentUser.name,
    email: state.currentUser.email,
    profile: state.currentUser.profile,
    quizAnswers: state.currentUser.quizAnswers || [],
    results: state.currentUser.results || [],
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(passport, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.currentUser.name.replace(/\s+/g, '_')}_passport.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderTaskList() {
  if (!state.taskGuide.length) {
    elements.taskList.innerHTML = '<p>Дані про завдання відсутні.</p>';
    return;
  }

  elements.taskList.innerHTML = state.taskGuide
    .map((task) => {
      const isActive = task.task_id === state.currentTaskId;
      return `
        <article class="task-item ${isActive ? 'is-active' : ''}">
          <div>
            <h3>${task.task_name_ui}</h3>
            <p>${task.task_description}</p>
          </div>
          <button type="button" data-task-id="${task.task_id}">Відкрити</button>
        </article>
      `;
    })
    .join('');

  // Event delegation handles clicks on task buttons in bindEvents()
}

function getRelevantTestsForTask(task) {
  if (!task || !Array.isArray(state.testsCatalog)) return [];

  const txt = (task.task_name_ui || task.task_description || '').toLowerCase();

  const keywordChecks = [
    { kws: ['швидк', 'speed'], match: (t) => /(швидк|speed)/i.test((t.category||'') + ' ' + (t.title||'')) },
    { kws: ['витрив', 'endurance'], match: (t) => /(витрив|endurance|endurance)/i.test((t.category||'') + ' ' + (t.title||'')) },
    { kws: ['гнучк', 'flex'], match: (t) => /(гнучк|flex)/i.test((t.category||'') + ' ' + (t.title||'')) },
    { kws: ['коорд', 'сприт', 'coord', 'agility'], match: (t) => /(коорд|сприт|coord|agility)/i.test((t.category||'') + ' ' + (t.title||'')) },
    { kws: ['сил', 'strength', 'power'], match: (t) => /(сил|strength|power|explosive)/i.test((t.category||'') + ' ' + (t.title||'')) },
  ];

  // pick the first matching rule by task title/description
  const rule = keywordChecks.find((r) => r.kws.some((k) => txt.includes(k)));

  let candidates = state.testsCatalog || [];
  if (rule) {
    candidates = candidates.filter(rule.match);
  } else {
    // fallback: try to match by common Ukrainian words in title
    candidates = candidates.filter((t) => {
      const hay = ((t.title || '') + ' ' + (t.category || '')).toLowerCase();
      return ['speed', 'витрив', 'flex', 'гнучк', 'strength', 'coord', 'agility'].some((k) => hay.includes(k));
    });
  }

  return candidates.slice(0, 12);
}

function renderTestDetail(testId) {
  if (!state.testsCatalog || !testId) return;
  const t = state.testsCatalog.find((x) => x.test_id === testId);
  if (!t) return;

  elements.taskTitle.textContent = t.title || testId;
  elements.taskStatus.textContent = `Тест: ${t.test_id}`;

  const video = t.video_example || t.reference || '';

  const html = `
    <div class="test-detail">
      <h3>${t.title || ''}${t.category ? ' — ' + t.category : ''}</h3>
      ${t.metrics ? `<div><strong>Метрика:</strong> ${t.metrics}</div>` : ''}
      ${t.inventory ? `<div><strong>Обладнання:</strong> ${t.inventory}</div>` : ''}
      ${t.performance_technique ? `<div><strong>Техніка виконання:</strong> ${t.performance_technique}</div>` : ''}
      ${t.result_recording ? `<div><strong>Фіксація результату:</strong> ${t.result_recording}</div>` : ''}
      ${video ? `<div><strong>Відео:</strong> <a href="${video}" target="_blank" rel="noreferrer">Переглянути приклад</a></div>` : ''}
      <div style="margin-top:12px"><button id="back-to-module" class="secondary-btn" type="button">Назад до модуля</button></div>
    </div>`;

  elements.taskDescription.innerHTML = html;
  if (elements.taskTitle && elements.taskTitle.scrollIntoView) {
    elements.taskTitle.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderCurrentTask() {
  const task = getTaskById(state.taskGuide, state.currentTaskId) || state.taskGuide[0];

  if (!task) {
    return;
  }

  state.currentTaskId = task.task_id;
  elements.taskTitle.textContent = task.task_name_ui;
  // Show description and list of relevant tests
  const related = getRelevantTestsForTask(task);
  let descHtml = `<span>${task.task_description || ''}</span>`;

    if (related && related.length) {
    descHtml += '<div class="related-tests"><h4>Рекомендовані тести для вивчення</h4><ul>';
    descHtml += related
      .map((t) => {
        // compact summary shown in the module list; full details appear only after click
        return `
          <li class="related-test-item">
            <button type="button" class="open-test-btn" data-test-id="${t.test_id}">
              <div class="related-test-summary">
                <h5>${t.title}${t.category ? ' — ' + t.category : ''}</h5>
                ${t.metrics ? `<div class="muted">${t.metrics}</div>` : ''}
              </div>
            </button>
          </li>`;
      })
      .join('');
    descHtml += '</ul></div>';
  }

  elements.taskDescription.innerHTML = descHtml;
  elements.taskStatus.textContent = `Модуль: ${task.task_name_ui}`;
  elements.taskQuizResponse.value = '';
  elements.quizFeedback.textContent = '';
  elements.quizFeedback.className = 'quiz-feedback';
  // Ensure the task card is visible to the user
  if (elements.taskTitle && elements.taskTitle.scrollIntoView) {
    elements.taskTitle.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  // hide student history when viewing a module
  if (elements.studentHistory) elements.studentHistory.classList.add('hidden');
  // set per-module quiz question placeholder (use explicit quiz_question if provided)
  const subject = (task.task_name_ui || '').replace(/^Вимірювання\s*/i, '').trim();
  const questionText = task.quiz_question && task.quiz_question.length
    ? task.quiz_question
    : `Які з вивчених тестів є доречними для вимірювання ${subject} в обраному виді спорту? У відповіді зазначити власний вид спорту`;
  if (elements.taskQuizResponse) elements.taskQuizResponse.placeholder = questionText;
}

function renderTestOptions() {
  const catalog = state.testsCatalog || [];
  const testIds = extractUniqueTestIds(state.norms);

  if (catalog.length) {
    // Prefer catalog titles and order by catalog
    const options = catalog
      .filter((c) => testIds.includes(c.test_id))
      .map((c) => `<option value="${c.test_id}">${c.title} — ${c.category || ''}</option>`);

    if (options.length) {
      elements.testSelect.innerHTML = options.join('');
      return;
    }
  }

  if (!testIds.length) {
    elements.testSelect.innerHTML = '<option value="">Немає нормативів</option>';
    return;
  }

  elements.testSelect.innerHTML = testIds
    .map((testId) => `<option value="${testId}">${buildTestLabel(testId)}</option>`)
    .join('');
}

function updateEvaluationResult(result) {
  const resultBox = elements.evaluationResult;
  resultBox.className = 'result-box';

  if (!result || !result.ok) {
    resultBox.textContent = result?.error || 'Невідома помилка оцінювання.';
    resultBox.classList.add('weak');
    resultBox.classList.remove('hidden');
    return;
  }

  const levelClass = getLevelClass(result.levelNameUi);
  resultBox.classList.add(levelClass || 'good');
  resultBox.innerHTML = `
    <strong>Рівень:</strong> ${result.levelNameUi}<br />
    <strong>Тест:</strong> ${buildTestLabel(result.testId)}<br />
    <strong>Результат:</strong> ${result.value}<br />
    <strong>Діапазон:</strong> ${result.range.min}–${result.range.max}
  `;
  resultBox.classList.remove('hidden');
}

function saveStudentProfile() {
  if (!state.currentUser || state.currentUser.role !== 'student') {
    return;
  }

  const profile = {
    gender: elements.genderSelect.value,
    specialization: elements.specializationInput.value.trim() || 'Не вказано',
  };

  state.currentUser.profile = profile;
  saveUsers();
  renderStudentProfile();
}

function handleEvaluation() {
  if (!state.currentUser || state.currentUser.role !== 'student') {
    return;
  }

  const testId = elements.testSelect.value;
  const rawValue = elements.resultInput.value;
  const result = evaluateNorm(testId, state.currentUser.profile?.gender || 'male', rawValue, state.norms);

  if (result.ok) {
    state.currentUser.results = state.currentUser.results || [];
    state.currentUser.results.push({
      testId: result.testId,
      value: result.value,
      levelNameUi: result.levelNameUi,
      date: new Date().toISOString(),
    });
    saveUsers();
  }

  updateEvaluationResult(result);
}

function handleQuizSubmit() {
  const task = getTaskById(state.taskGuide, state.currentTaskId) || state.taskGuide[0];

  if (!task) {
    elements.quizFeedback.textContent = 'Спочатку завантажте перелік модулів.';
    elements.quizFeedback.className = 'quiz-feedback warning';
    return;
  }

  const answer = elements.taskQuizResponse.value.trim();

  if (!answer) {
    elements.quizFeedback.textContent = 'Будь ласка, введіть відповідь на контрольне запитання.';
    elements.quizFeedback.className = 'quiz-feedback warning';
    return;
  }

  const rubric = [
    'швидкість',
    'сила',
    'витривалість',
    'гнучкість',
    'координація',
    'спритність',
    'легка атлетика',
    'підготовленість',
    'тест',
    'показник',
  ];

  const matchCount = rubric.filter((word) => answer.toLowerCase().includes(word)).length;
  const isMeaningful = matchCount >= 2 || answer.length >= 30;

  if (isMeaningful) {
    state.currentUser.quizAnswers = state.currentUser.quizAnswers || [];
    state.currentUser.quizAnswers.push({
      taskId: task.task_id,
      taskName: task.task_name_ui,
      answer,
      createdAt: new Date().toISOString(),
    });
    saveUsers();
    elements.quizFeedback.textContent = `Відповідь оформлена коректно. Для модуля «${task.task_name_ui}» зафіксовано логічну аргументацію щодо вибору тестів і показників.`;
    elements.quizFeedback.className = 'quiz-feedback success';
  } else {
    elements.quizFeedback.textContent = 'Відповідь коротка або недостатньо конкретна. Додайте назви рухових якостей, тестів або показників, які вони оцінюють.';
    elements.quizFeedback.className = 'quiz-feedback warning';
  }
}

function getStudentProgress(student) {
  const answersCount = (student.quizAnswers || []).length;
  const testsCount = (student.results || []).length;
  const profile = student.profile || {};
  const progressPercentage = Math.min(100, Math.round(((answersCount + testsCount) / 12) * 100));

  return {
    answersCount,
    testsCount,
    progressPercentage,
    specialization: profile.specialization || 'Не вказано',
    gender: profile.gender === 'male' ? 'Чоловіча' : 'Жіноча',
  };
}

function renderTeacherDashboard() {
  // Show all users except those explicitly marked as 'teacher' (case-insensitive)
  const students = state.users.filter((user) => {
    const role = (user && user.role) ? String(user.role).trim().toLowerCase() : '';
    return role !== 'teacher';
  });

  if (!students.length) {
    elements.teacherStudents.innerHTML = '<div class="teacher-empty">Студентів поки немає.</div>';
    elements.teacherDetail.innerHTML = '<div class="teacher-empty">Виберіть студента для перегляду паспорта.</div>';
    return;
  }

  state.selectedStudentId = state.selectedStudentId || students[0].id;
  const selectedStudent = students.find((student) => student.id === state.selectedStudentId) || students[0];

  elements.teacherStudents.innerHTML = students
    .map((student) => {
      const progress = getStudentProgress(student);
      const isSelected = student.id === selectedStudent.id;

      return `
        <div class="student-item ${isSelected ? 'is-active' : ''}">
          <div>
            <h3>${student.name}</h3>
            <p>${progress.specialization} • ${progress.progressPercentage}% прогрес</p>
          </div>
          <button type="button" data-student-id="${student.id}">Вибрати</button>
        </div>
      `;
    })
    .join('');
  // Add export controls
  const exportControls = document.createElement('div');
  exportControls.style.marginTop = '12px';
  exportControls.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;">
      <button id="export-all-csv" class="secondary-btn" type="button">Експорт усіх студентів (CSV)</button>
      <input id="sheets-endpoint" type="text" placeholder="Apps Script URL (опційно)" style="flex:1;min-width:220px;" />
      <button id="export-to-sheets" class="secondary-btn" type="button">Експорт у Google Sheets</button>
    </div>
  `;
  elements.teacherDetail.prepend(exportControls);

  elements.teacherStudents.querySelectorAll('[data-student-id]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedStudentId = button.dataset.studentId;
      renderTeacherDashboard();
    });
  });

  // Wire export buttons if present
  const csvBtn = document.getElementById('export-all-csv');
  if (csvBtn) csvBtn.addEventListener('click', exportStudentsCSV);
  const sheetsBtn = document.getElementById('export-to-sheets');
  if (sheetsBtn) {
    sheetsBtn.addEventListener('click', async () => {
      const endpoint = document.getElementById('sheets-endpoint')?.value?.trim();
      const res = await exportToSheets(endpoint);
      if (res.ok) showAuthMessage('Дані експортовано в Google Sheets.');
      else showAuthMessage(`Помилка експорту: ${res.error}`, true);
    });
  }

  // Import students dump (paste JSON) — available from teacher console/UI if button exists
  window.importStudentsDump = function (text) {
    try {
      if (!text) throw new Error('No input provided');
      const parsed = JSON.parse(text);
      const incoming = Array.isArray(parsed) ? parsed : (parsed.students || parsed.users || []);
      if (!Array.isArray(incoming)) throw new Error('Expected an array of student objects');

      const raw = localStorage.getItem('motor-testing-users') || '[]';
      const stored = JSON.parse(raw);
      const byEmail = {};
      stored.forEach(u => {
        const e = (typeof normalizeGmail === 'function') ? normalizeGmail(u.email || u.login || '') : (u.email || u.login || '');
        if (e) byEmail[e] = u;
      });

      let added = 0, updated = 0;
      incoming.forEach(u => {
        const eRaw = u.email || u.login || '';
        const email = (typeof normalizeGmail === 'function') ? normalizeGmail(eRaw) : eRaw;
        if (!email) return;
        if (byEmail[email]) {
          byEmail[email] = Object.assign({}, byEmail[email], u);
          updated++;
        } else {
          byEmail[email] = u;
          added++;
        }
      });

      const merged = Object.values(byEmail);
      localStorage.setItem('motor-testing-users', JSON.stringify(merged));
      showAuthMessage(`Імпортовано: додано ${added}, оновлено ${updated}.`);
      if (typeof renderTeacherDashboard === 'function') renderTeacherDashboard();
      return { ok: true, added, updated };
    } catch (err) {
      showAuthMessage(`Імпорт не вдався: ${err.message}`, true);
      return { ok: false, error: err.message };
    }
  };

  window.importStudentsDumpPrompt = function () {
    const text = window.prompt('Вставте JSON дамп `motor-testing-users` і натисніть OK');
    if (text) return window.importStudentsDump(text);
    return { ok: false, error: 'Canceled' };
  };

  const importBtn = document.getElementById('import-all-json');
  if (importBtn) importBtn.addEventListener('click', window.importStudentsDumpPrompt);

  const answers = selectedStudent.quizAnswers || [];
  const results = selectedStudent.results || [];
  const progress = getStudentProgress(selectedStudent);

  elements.teacherDetail.innerHTML = `
    <div class="teacher-summary">
      <h3>Паспорт студента: ${selectedStudent.name}</h3>
      <p>Email: ${selectedStudent.email}</p>
      <p>Стать: ${progress.gender}</p>
      <p>Спеціалізація: ${progress.specialization}</p>
    </div>

    <div class="metrics-grid">
      <div class="metric-card">
        <span>Прогрес</span>
        <strong>${progress.progressPercentage}%</strong>
      </div>
      <div class="metric-card">
        <span>Відповіді</span>
        <strong>${progress.answersCount}</strong>
      </div>
      <div class="metric-card">
        <span>Тести</span>
        <strong>${progress.testsCount}</strong>
      </div>
    </div>

    <div class="detail-section">
      <h4>Результати тестування</h4>
      ${results.length
        ? results
            .map(
              (item) => `
                <div class="result-item">
                  <strong>${buildTestLabel(item.testId)}</strong>
                  <span>Результат: ${item.value}</span><br />
                  <span>Рівень: ${item.levelNameUi}</span>
                </div>
              `
            )
            .join('')
        : '<p>Тести ще не виконані.</p>'}
    </div>

    <div class="detail-section">
      <h4>Відповіді на завдання</h4>
      ${answers.length
        ? answers
            .map(
              (item) => `
                <div class="answer-item">
                  <strong>${item.taskName}</strong>
                  <span>${item.answer}</span>
                </div>
              `
            )
            .join('')
        : '<p>Відповіді на завдання відсутні.</p>'}
    </div>
  `;
}

function buildStudentsCSV(students) {
  const rows = [];
  rows.push(['id', 'name', 'email', 'gender', 'specialization', 'testId', 'testValue', 'testLevel', 'testDate', 'quizTaskId', 'quizTaskName', 'quizAnswer', 'quizDate'].join(','));
  students.forEach((s) => {
    const profile = s.profile || {};
    const tests = s.results || [];
    const answers = s.quizAnswers || [];
    const maxRows = Math.max(tests.length, answers.length, 1);
    for (let i = 0; i < maxRows; i++) {
      const t = tests[i] || {};
      const a = answers[i] || {};
      const row = [
        s.id || '',
        s.name || '',
        s.email || '',
        profile.gender || '',
        profile.specialization || '',
        t.testId || '',
        t.value || '',
        t.levelNameUi || '',
        t.date || '',
        a.taskId || '',
        a.taskName || '',
        (a.answer || '').replace(/\n/g, ' '),
        a.createdAt || '',
      ];
      rows.push(row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
    }
  });
  return rows.join('\n');
}

function exportStudentsCSV() {
  const students = state.users.filter((u) => u.role === 'student');
  const csv = buildStudentsCSV(students);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `students_export_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportToSheets(endpointUrl) {
  if (!endpointUrl) return { ok: false, error: 'No endpoint' };
  const students = state.users.filter((u) => u.role === 'student');
  try {
    const res = await fetch(endpointUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ students }) });
    if (!res.ok) throw new Error('Request failed');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function loadAppData() {
  const taskUrls = [
    './data/task_guide_2.json',
    './data/task_guide.json',
    'data/task_guide_2.json',
    'data/task_guide.json',
  ];

  const normUrls = [
    './data/norms_dictionary_2.json',
    './data/norms_dictionary.json',
    'data/norms_dictionary_2.json',
    'data/norms_dictionary.json',
  ];

  try {
    const taskUrl = await resolveDataUrls(taskUrls);
    const normUrl = await resolveDataUrls(normUrls);

    const testsCatalog = await loadTestsCatalog();
    state.testsCatalog = testsCatalog;

    state.taskGuide = await loadJson(taskUrl);
    state.norms = await loadJson(normUrl);
    // load teacher whitelist (client-side JSON)
    try {
      state.teachersWhitelist = await loadJson('./data/teachers.json');
    } catch (e) {
      state.teachersWhitelist = ['athletica401@gmail.com'];
    }

    if (!state.taskGuide.length) {
      throw new Error('Task guide is empty.');
    }

    state.currentTaskId = state.taskGuide[0].task_id;
    renderTestOptions();
    renderTaskList();
    renderCurrentTask();
  } catch (error) {
    console.error(error);
    elements.taskList.innerHTML = '<p>Не вдалося завантажити дані про модулі. Перевірте файли JSON у папці data.</p>';
    elements.quizFeedback.textContent = 'Дані не завантажені. Перевірте шляхи до JSON-файлів.';
    elements.quizFeedback.className = 'quiz-feedback warning';
  }
}

function bindEvents() {
  elements.authForm.addEventListener('submit', handleAuthSubmit);
  if (elements.teacherLoginButton) elements.teacherLoginButton.addEventListener('click', handleTeacherLogin);
  elements.logoutButton.addEventListener('click', logout);

  elements.roleTabs.forEach((button) => {
    button.addEventListener('click', () => {
      if (state.currentUser?.role === 'student' && button.dataset.role === 'teacher') {
        return;
      }

      state.activeTab = button.dataset.role;
      renderApplication();
    });
  });

  elements.profileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveStudentProfile();
  });

  elements.evaluateButton.addEventListener('click', handleEvaluation);
  elements.quizSubmit.addEventListener('click', handleQuizSubmit);
  if (elements.historyButton) elements.historyButton.addEventListener('click', renderHistory);
  if (elements.exportPassport) elements.exportPassport.addEventListener('click', exportPassportJSON);
  if (elements.taskList) {
    elements.taskList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-task-id]');
      if (btn) {
        if (!state.currentUser) {
          // Ask user to login first
          showAuthMessage('Увійдіть або зареєструйтесь, щоб відкривати модулі.', true);
          elements.authScreen.scrollIntoView({ behavior: 'smooth' });
          return;
        }

        state.currentTaskId = btn.dataset.taskId;
        renderCurrentTask();
        renderTaskList();
      }
    });
  }
  // Listen for clicks on related tests inside the task description
  if (elements.taskDescription) {
    elements.taskDescription.addEventListener('click', (e) => {
      const tbtn = e.target.closest('.open-test-btn');
      if (tbtn) {
        const testId = tbtn.dataset.testId;
        if (testId) {
          renderTestDetail(testId);
        }
      }

      const back = e.target.closest('#back-to-module');
      if (back) {
        renderCurrentTask();
      }
    });
  }
  window.addEventListener('online', setOnlineStatus);
  window.addEventListener('offline', setOnlineStatus);
  setOnlineStatus();
}

async function initApp() {
  // Load users from storage first
  state.users = readStorage(USERS_KEY, []);

  // Load teachers whitelist early so we can sanitize stored users
  // Defensive: remove any legacy teacher-login button from the DOM
  try {
    const legacyBtn = document.querySelector('#teacher-login-button');
    if (legacyBtn) legacyBtn.remove();
  } catch (e) {}
  try {
    state.teachersWhitelist = await loadJson('./data/teachers.json');
  } catch (e) {
    state.teachersWhitelist = ['athletica401@gmail.com'];
  }

  // Remove any stored teacher accounts that are NOT in the whitelist
  const whitelist = Array.isArray(state.teachersWhitelist) ? state.teachersWhitelist.map((e) => e.toLowerCase()) : [];
  state.users = state.users.filter((u) => {
    if (!u || !u.email) return false;
    if (u.role && u.role.toLowerCase() === 'teacher') {
      return whitelist.includes(u.email.toLowerCase());
    }
    return true;
  });

  // Ensure any existing user whose email is whitelisted gets teacher role
  state.users.forEach((u) => {
    try {
      if (u && u.email && whitelist.includes(u.email.toLowerCase())) {
        u.role = 'teacher';
      }
    } catch (e) {}
  });

  // If no users remain, seed demo students only
  if (!state.users.length) {
    ensureDemoUsers();
  }

  loadCurrentUser();
  bindEvents();
  // initialize Google Sign-In (if client id provided)
  initGoogleSignIn(GOOGLE_CLIENT_ID);
  await loadAppData();
  renderApplication();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  }
}

document.addEventListener('DOMContentLoaded', initApp);
