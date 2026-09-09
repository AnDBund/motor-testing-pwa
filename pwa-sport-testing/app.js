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
const GOOGLE_CLIENT_ID = '695502870988-k877167dvdd1kdd2dsk6ebc1k0c7st4u.apps.googleusercontent.com';

const elements = {
  authScreen: document.querySelector('#auth-screen'),
  authForm: document.querySelector('#auth-form'),
  authName: document.querySelector('#auth-name'),
  authEmail: document.querySelector('#auth-email'),
  authPassword: document.querySelector('#auth-password'),
  authTeacherId: document.querySelector('#auth-teacher-id'),
  authMessage: document.querySelector('#auth-message'),
  googleSignInContainer: document.querySelector('#googleSignIn'),
  googleLoginButton: document.querySelector('#google-login-button'),
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

// Firebase runtime handles (optional)
let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let firebaseUnsubscribeUsers = null;

// Firebase helper implementations (mirror main app)
async function initFirebaseIfConfigured() {
  try {
    const fbConfig = await loadJson('./data/firebase-config.json');
    if (!fbConfig || !fbConfig.apiKey) throw new Error('No firebase config');
    const [{ initializeApp }, { getAuth }, { getFirestore, collection, onSnapshot, doc, setDoc } ] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/9.22.1/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js'),
    ]);
    firebaseApp = initializeApp(fbConfig);
    firebaseAuth = getAuth(firebaseApp);
    firebaseDb = getFirestore(firebaseApp);

    // Debug helper: expose internal Firebase handles for easy inspection in DevTools
    try {
      window._mt = window._mt || {};
      window._mt.firebase = { app: firebaseApp, auth: firebaseAuth, db: firebaseDb };
      console.log('Firebase initialized:', { projectId: fbConfig.projectId, authDomain: fbConfig.authDomain });
    } catch (e) {}

    // If current user exists and has a valid Firebase UID, push to Firestore
    if (state.currentUser && state.currentUser.uid && !state.currentUser.uid.startsWith('user-')) {
      if (state.currentUser.email && state.currentUser.password) {
        syncUserWithFirebaseAuth(state.currentUser.email, state.currentUser.password, false).then(() => {
          saveUserToFirestore(state.currentUser).catch((err) => {
            console.warn('Failed to push current user to Firestore after sync:', err);
          });
        }).catch(() => {});
      } else {
        saveUserToFirestore(state.currentUser).catch((err) => {
          console.warn('Failed to push current user to Firestore on init:', err);
        });
      }
    }

    const origSaveUsers = saveUsers;
    saveUsers = function () {
      origSaveUsers();
      try {
        // Only push the CURRENT authenticated user's data to Firestore.
        if (state.currentUser && state.currentUser.uid && state.currentUser.email) {
          saveUserToFirestore(state.currentUser).catch((err) => {
            console.warn('Failed to push current user to Firestore on saveUsers:', err);
          });
        }
      } catch (e) {}
    };

    if (state.currentUser && (state.currentUser.role || '').toLowerCase() === 'teacher') subscribeToFirestoreUsers();
    return true;
  } catch (err) {
    throw err;
  }
}

async function syncUserWithFirebaseAuth(email, password, isNewRegistration) {
  // Wait up to 3 seconds for firebaseAuth to initialize if needed
  for (let i = 0; i < 10; i++) {
    if (firebaseAuth) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!firebaseAuth) {
    console.warn('Firebase Auth is not initialized yet.');
    return;
  }
  try {
    const { createUserWithEmailAndPassword, signInWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/9.22.1/firebase-auth.js');
    if (isNewRegistration) {
      try {
        await createUserWithEmailAndPassword(firebaseAuth, email, password);
        console.log('Firebase Auth: registered new user', email);
      } catch (err) {
        if (err.code === 'auth/email-already-in-use') {
          await signInWithEmailAndPassword(firebaseAuth, email, password);
          console.log('Firebase Auth: user already exists, signed in', email);
        } else {
          throw err;
        }
      }
    } else {
      try {
        await signInWithEmailAndPassword(firebaseAuth, email, password);
        console.log('Firebase Auth: signed in existing user', email);
      } catch (err) {
        if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
          try {
            await createUserWithEmailAndPassword(firebaseAuth, email, password);
            console.log('Firebase Auth: user not found in auth db, created on-demand', email);
          } catch (createErr) {
            console.warn('Firebase Auth: on-demand creation failed', createErr);
          }
        } else {
          throw err;
        }
      }
    }
  } catch (e) {
    console.warn('Firebase Auth sync failed:', e);
  }
}

async function saveUserToFirestore(user) {
  if (!firebaseDb || !user || !user.email) return;
  // Use Firebase Auth UID as the document ID; if user has no real Firebase UID, skip
  const uid = user.uid || (firebaseAuth && firebaseAuth.currentUser && firebaseAuth.currentUser.uid);
  if (!uid) return;

  try {
    const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js');
    await setDoc(doc(firebaseDb, 'users', uid), normalizeUserForFirestore(user), { merge: true });
    console.log('Saved user to Firestore at users/' + uid);
  } catch (e) {
    console.warn('Failed to save user to Firestore', e);
  }
}

function normalizeUserForFirestore(u) {
  const uid = u.uid || (firebaseAuth && firebaseAuth.currentUser && firebaseAuth.currentUser.uid) || u.id;
  const email = (u.email || (firebaseAuth && firebaseAuth.currentUser && firebaseAuth.currentUser.email) || '').toLowerCase();
  const displayName = u.displayName || u.name || (firebaseAuth && firebaseAuth.currentUser && firebaseAuth.currentUser.displayName) || (email ? email.split('@')[0] : '');
  const role = u.role || 'student';
  // teacherId MUST come explicitly from the user object (set via form/URL in registration)
  const teacherId = (role === 'student' ? (u.teacherId || '') : (u.teacherId || ''));
  const createdAt = u.createdAt || new Date().toISOString();

  return {
    uid: uid,
    email: email,
    displayName: displayName,
    role: role,
    teacherId: teacherId,
    createdAt: createdAt,
    id: uid,
    name: displayName,
    profile: u.profile || { gender: 'male', specialization: '' },
    quizAnswers: u.quizAnswers || [],
    results: u.results || [],
    updatedAt: new Date().toISOString(),
  };
}

async function subscribeToFirestoreUsers() {
  if (!firebaseDb) return;
  if (firebaseUnsubscribeUsers) {
    try { firebaseUnsubscribeUsers(); } catch (e) {}
    firebaseUnsubscribeUsers = null;
  }

  const currentTeacherUid = firebaseAuth?.currentUser?.uid || state.currentUser?.uid || state.currentUser?.id;
  const currentTeacherEmail = (firebaseAuth?.currentUser?.email || state.currentUser?.email || '').toLowerCase();
  if (!currentTeacherUid && !currentTeacherEmail) return;

  try {
    const { collection, query, where, onSnapshot } = await import('https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js');
    const usersCol = collection(firebaseDb, 'users');

    const handleSnapshot = (snapshot) => {
      const incoming = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (data) {
          incoming.push({
            id: data.uid || docSnap.id,
            uid: data.uid || docSnap.id,
            name: data.displayName || data.name || data.email,
            displayName: data.displayName || data.name || data.email,
            ...data,
          });
        }
      });

      const raw = localStorage.getItem(USERS_KEY) || '[]';
      const stored = JSON.parse(raw);
      const byId = {};
      stored.forEach((s) => {
        if (s && (s.uid || s.id || s.email)) {
          const key = (s.uid || s.id || s.email).toLowerCase();
          byId[key] = s;
        }
      });
      incoming.forEach((i) => {
        if (i && (i.uid || i.id || i.email)) {
          const key = (i.uid || i.id || i.email).toLowerCase();
          byId[key] = Object.assign({}, byId[key] || {}, i);
        }
      });
      const merged = Object.values(byId);
      localStorage.setItem(USERS_KEY, JSON.stringify(merged));
      state.users = merged;
      if (typeof renderTeacherDashboard === 'function') renderTeacherDashboard();
    };

    // Query by teacher's Firebase UID (primary method)
    if (currentTeacherUid) {
      const qUid = query(usersCol, where('teacherId', '==', currentTeacherUid));
      firebaseUnsubscribeUsers = onSnapshot(qUid, handleSnapshot, (err) => {
        console.warn('Firestore snapshot UID listener error:', err);
      });
    }

    // Also query by teacher's email (fallback for backward compatibility)
    if (currentTeacherEmail && currentTeacherEmail !== currentTeacherUid) {
      const qEmail = query(usersCol, where('teacherId', '==', currentTeacherEmail));
      const emailUnsub = onSnapshot(qEmail, handleSnapshot, (err) => {
        console.warn('Firestore snapshot email listener error:', err);
      });
      if (!window._mt) window._mt = {};
      window._mt._firestoreEmailUnsub = emailUnsub;
    }
  } catch (e) {
    console.warn('subscribeToFirestoreUsers failed', e);
  }
}

function setOnlineStatus() {
  if (!elements.onlineStatus) return;
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
  try {
    if (firebaseDb && user && (user.role || '').toLowerCase() === 'teacher') {
      subscribeToFirestoreUsers();
    }
  } catch (e) {}
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
  const explicitTeacherId = elements.authTeacherId?.value?.trim() || '';

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

  // Run Firebase Auth sync first to get a real UID
  (async () => {
    try {
      if (firebaseAuth) {
        const { createUserWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/9.22.1/firebase-auth.js');
        try {
          await createUserWithEmailAndPassword(firebaseAuth, normalizedEmail, password);
        } catch (authErr) {
          if (authErr.code === 'auth/email-already-in-use') {
            await syncUserWithFirebaseAuth(normalizedEmail, password, false);
          } else {
            console.warn('Firebase Auth create error:', authErr);
          }
        }
      }
    } catch (e) {
      console.warn('Firebase Auth sync during handleAuthSubmit:', e);
    }

    const authUser = firebaseAuth?.currentUser;
    const uid = authUser ? authUser.uid : `user-${Date.now()}`;

    let existingUser = state.users.find((user) => user.email.toLowerCase() === normalizedEmail);

    if (existingUser) {
      if (existingUser.password !== password) {
        showAuthMessage('Пароль не співпадає. Спробуйте ще раз.', true);
        return;
      }

      if (authUser) {
        existingUser.uid = authUser.uid;
        existingUser.id = authUser.uid;
        existingUser.displayName = existingUser.name;
        if ((existingUser.role || 'student') === 'student') {
          existingUser.teacherId = explicitTeacherId || existingUser.teacherId || '';
        }
      }

      setCurrentUser(existingUser);
      showAuthMessage(`Ласкаво просимо, ${existingUser.name}!`);

      if (firebaseDb) {
        saveUserToFirestore(existingUser).catch((err) => {
          console.warn('Failed to save existing user to Firestore:', err);
        });
      }
      return;
    }

    // New registrations are always students
    const newUser = {
      id: uid,
      uid: uid,
      name,
      displayName: name,
      email: normalizedEmail,
      password,
      role: 'student',
      teacherId: explicitTeacherId,
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

    if (firebaseDb) {
      await saveUserToFirestore(newUser);
    }
  })();
}
async function handleGoogleSignInPopup() {
  if (!firebaseAuth) {
    showAuthMessage('Firebase Auth ще не ініціалізовано. Спробуйте за мить.', true);
    return;
  }
  try {
    const { GoogleAuthProvider, signInWithPopup } = await import('https://www.gstatic.com/firebasejs/9.22.1/firebase-auth.js');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const userCredential = await signInWithPopup(firebaseAuth, provider);
    if (userCredential && userCredential.user) {
      await processSuccessfulFirebaseAuth(userCredential.user);
    }
  } catch (err) {
    console.warn('Google signInWithPopup error:', err);
    if (err.code !== 'auth/popup-closed-by-user') {
      showAuthMessage(`Помилка входу через Google: ${err.message}`, true);
    }
  }
}

async function processSuccessfulFirebaseAuth(authUser) {
  const email = (authUser.email || '').toLowerCase();
  const displayName = authUser.displayName || email.split('@')[0];
  const uid = authUser.uid;

  // Determine role: teacher if whitelisted, else student
  const teacherWhitelist = Array.isArray(state.teachersWhitelist) ? state.teachersWhitelist : ['athletica401@gmail.com'];
  const normalizedEmail = normalizeGmail(email);
  const normalizedWhitelist = teacherWhitelist.map((e) => normalizeGmail(String(e).toLowerCase()));
  const isTeacher = teacherWhitelist.map((e) => String(e).toLowerCase()).includes(email) || normalizedWhitelist.includes(normalizedEmail);
  const role = isTeacher ? 'teacher' : 'student';
  const explicitTeacherId = elements.authTeacherId?.value?.trim() || '';

  let existing = state.users.find((u) => (u.uid && u.uid === uid) || (u.email && u.email.toLowerCase() === email));
  if (!existing) {
    existing = {
      id: uid,
      uid: uid,
      name: displayName,
      displayName: displayName,
      email: email,
      role: role,
      teacherId: role === 'student' ? explicitTeacherId : '',
      profile: { gender: 'male', specialization: '' },
      quizAnswers: [],
      results: [],
      createdAt: authUser.metadata?.creationTime ? new Date(authUser.metadata.creationTime).toISOString() : new Date().toISOString(),
    };
    state.users.push(existing);
  } else {
    existing.uid = uid;
    existing.id = uid;
    existing.name = displayName || existing.name;
    existing.displayName = existing.name;
    existing.role = role;
    // Always update teacherId for students (explicit from form/URL)
    if (role === 'student') {
      existing.teacherId = explicitTeacherId || existing.teacherId || '';
    }
  }

  saveUsers();

  if (firebaseDb) {
    await saveUserToFirestore(existing);
  }

  setCurrentUser(existing);
  showAuthMessage(`Увійшли як ${existing.name} (${existing.email}) — роль: ${existing.role}`);
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

  const fallbackButton = elements.googleLoginButton;
  const fallbackMessage = 'Google Sign-In працює тільки через http://localhost або HTTPS. Увійдіть через локальний сервер або додайте правильний origin у Google Cloud.';

  if (window.location.protocol === 'file:') {
    showAuthMessage(fallbackMessage, true);
    if (fallbackButton) {
      fallbackButton.hidden = false;
      fallbackButton.disabled = true;
      fallbackButton.title = fallbackMessage;
      fallbackButton.textContent = 'Google Sign-In недоступний у file://';
    }
    return;
  }

  const tryInit = () => {
    if (!window.google || !google.accounts || !google.accounts.id) {
      setTimeout(tryInit, 300);
      return;
    }

    google.accounts.id.initialize({
      client_id: clientId,
      callback: handleCredentialResponse,
    });

const container = document.getElementById('googleSignIn');
    if (container) {
      google.accounts.id.renderButton(container, { 
        theme: 'outline', 
        size: 'large', 
        width: 280 
      });
    }

    const fallbackButton = document.getElementById('google-login-button');
    if (fallbackButton) {
      fallbackButton.hidden = true;
    }
  };

  tryInit();

  if (fallbackButton) {
    fallbackButton.addEventListener('click', async () => {
      if (firebaseAuth) {
        await handleGoogleSignInPopup();
        return;
      }
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.prompt();
        showAuthMessage('Відкривається вікно Google Sign-In.');
        return;
      }
      showAuthMessage(fallbackMessage, true);
    });
  }
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
  const explicitTeacherId = elements.authTeacherId?.value?.trim() || '';

  // Try Firebase sign-in first
  (async () => {
    try {
      if (firebaseAuth) {
        const { GoogleAuthProvider, signInWithCredential } = await import('https://www.gstatic.com/firebasejs/9.22.1/firebase-auth.js');
        const fbCred = GoogleAuthProvider.credential(response.credential);
        const userCredential = await signInWithCredential(firebaseAuth, fbCred);
        if (userCredential && userCredential.user) {
          await processSuccessfulFirebaseAuth(userCredential.user);
          return;
        }
      }
    } catch (e) {
      console.warn('Firebase sign-in with Google credential failed:', e);
    }

    // Fallback: save to local storage + Firestore
    const teacherWhitelist = Array.isArray(state.teachersWhitelist) ? state.teachersWhitelist : ['athletica401@gmail.com'];
    const normalizedEmail = normalizeGmail(email);
    const normalizedWhitelist = teacherWhitelist.map((e) => normalizeGmail(String(e).toLowerCase()));
    const role = teacherWhitelist.map((e) => String(e).toLowerCase()).includes(email) || normalizedWhitelist.includes(normalizedEmail) ? 'teacher' : 'student';

    let existing = state.users.find((u) => u.email.toLowerCase() === email);
    if (!existing) {
      existing = {
        id: `user-google-${payload.sub}`,
        uid: `user-google-${payload.sub}`,
        name,
        displayName: name,
        email,
        role,
        teacherId: role === 'student' ? explicitTeacherId : '',
        profile: { gender: 'male', specialization: '' },
        quizAnswers: [],
        results: [],
        createdAt: new Date().toISOString(),
      };
      state.users.push(existing);
      saveUsers();
      if (firebaseDb) {
        saveUserToFirestore(existing).catch((err) => {
          console.warn('Failed to save Google One-Tap user to Firestore:', err);
        });
      }
    } else {
      existing.role = role;
      saveUsers();
      if (firebaseDb) {
        saveUserToFirestore(existing).catch((err) => {
          console.warn('Failed to update Google One-Tap user in Firestore:', err);
        });
      }
    }

    // Save raw Google payload for debugging
    try {
      localStorage.setItem('motor-testing-last-google', JSON.stringify(payload));
    } catch (e) {}

    setCurrentUser(existing);
    showAuthMessage(`Увійшли як ${existing.name} (${existing.email}) — роль: ${existing.role}`);
  })();
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
  // Add share UI: email + download (simpler for students)
  let shareWrap = document.getElementById('share-with-teacher-wrap');
  if (!shareWrap) {
    shareWrap = document.createElement('div');
    shareWrap.id = 'share-with-teacher-wrap';
    shareWrap.style.marginTop = '8px';
    shareWrap.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button id="share-via-email" class="secondary-btn" type="button">Надіслати електронною поштою</button>
        <button id="download-passport" class="secondary-btn" type="button">Завантажити JSON паспорта</button>
        <small style="color:#6b7280;">Альтернатива: вставте JSON у панель викладача вручну.</small>
      </div>
    `;
    elements.profileSummary.parentElement.appendChild(shareWrap);

    const emailBtn = document.getElementById('share-via-email');
    if (emailBtn) emailBtn.addEventListener('click', () => {
      shareViaEmail(state.currentUser, 'athletica401@gmail.com');
    });

    const dlBtn = document.getElementById('download-passport');
    if (dlBtn) dlBtn.addEventListener('click', () => {
      downloadPassportFile(state.currentUser);
    });
  }
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
  // Determine the current teacher's identifier (UID or email)
  const currentTeacherUid = firebaseAuth?.currentUser?.uid || state.currentUser?.uid || state.currentUser?.id || '';
  const currentTeacherEmail = (firebaseAuth?.currentUser?.email || state.currentUser?.email || '').toLowerCase();

  // Show only students assigned to this teacher (by teacherId).
  const students = state.users.filter((user) => {
    const role = (user && user.role) ? String(user.role).trim().toLowerCase() : '';
    if (role === 'teacher') return false;
    const tId = (user.teacherId || '').toString().toLowerCase().trim();
    return tId === currentTeacherUid.toLowerCase() || (currentTeacherEmail && tId === currentTeacherEmail);
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
      <button id="fetch-shared" class="secondary-btn" type="button">Отримати спільні дані</button>
    </div>
  `;
  // Add import area below export controls
  const importArea = document.createElement('div');
  importArea.style.marginTop = '8px';
  importArea.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;">
      <small>Імпорт дампу студентів (вставте JSON, збережений з іншого браузера)</small>
      <textarea id="import-json-text" placeholder="Вставте JSON тут" style="min-height:80px;min-width:300px;max-width:100%;resize:vertical;"></textarea>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="import-all-json" class="secondary-btn" type="button">Імпортувати студентовий дамп</button>
        <button id="import-paste-clear" class="secondary-btn" type="button">Очистити</button>
      </div>
    </div>
  `;
  elements.teacherDetail.prepend(importArea);
  const importPasteClear = document.getElementById('import-paste-clear');
  if (importPasteClear) importPasteClear.addEventListener('click', () => { const ta = document.getElementById('import-json-text'); if (ta) ta.value = ''; });
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
  const fetchBtn = document.getElementById('fetch-shared');
  if (fetchBtn) {
    fetchBtn.addEventListener('click', async () => {
      const endpoint = document.getElementById('sheets-endpoint')?.value?.trim();
      const res = await fetchSharedStudents(endpoint);
      if (res.ok) showAuthMessage(`Отримано: додано ${res.added || 0}, оновлено ${res.updated || 0}`);
      else showAuthMessage(`Помилка отримання: ${res.error}`, true);
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
      const prev = JSON.parse(raw || '[]');
      const prevEmails = new Set(prev.map(u => (u.email||u.login||'').toLowerCase()));
      const addedCount = merged.filter(u => { const e = (u.email||u.login||'').toLowerCase(); return e && !prevEmails.has(e); }).length;
      const updatedCount = merged.length - addedCount;
      localStorage.setItem('motor-testing-users', JSON.stringify(merged));
      showAuthMessage(`Імпортовано: додано ${addedCount}, оновлено ${updatedCount}.`);
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

  const importBtnInit = document.getElementById('import-all-json');
  if (importBtnInit) importBtnInit.addEventListener('click', window.importStudentsDumpPrompt);

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

      // Attach handlers for controls now that elements exist in DOM
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
      const fetchBtn = document.getElementById('fetch-shared');
      if (fetchBtn) {
        fetchBtn.addEventListener('click', async () => {
          const endpoint = document.getElementById('sheets-endpoint')?.value?.trim();
          const res = await fetchSharedStudents(endpoint);
          if (res.ok) showAuthMessage(`Отримано: додано ${res.added || 0}, оновлено ${res.updated || 0}`);
          else showAuthMessage(`Помилка отримання: ${res.error}`, true);
        });
      }

      const importPasteClear = document.getElementById('import-paste-clear');
      if (importPasteClear) importPasteClear.addEventListener('click', () => { const ta = document.getElementById('import-json-text'); if (ta) ta.value = ''; });
      const importBtnPaste = document.getElementById('import-all-json');
      if (importBtnPaste) importBtnPaste.addEventListener('click', () => {
        const ta = document.getElementById('import-json-text');
        if (ta && ta.value) window.importStudentsDump(ta.value.trim());
      });
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

function downloadPassportFile(user) {
  if (!user) return showAuthMessage('Немає даних для експорту.', true);
  const data = {
    id: user.id,
    name: user.name,
    email: user.email,
    profile: user.profile,
    quizAnswers: user.quizAnswers || [],
    results: user.results || [],
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(user.name||'student').replace(/\s+/g,'_')}_passport.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function shareViaEmail(user, teacherEmail) {
  if (!user) return showAuthMessage('Немає даних для надсилання.', true);
  const payload = {
    id: user.id,
    name: user.name,
    email: user.email,
    profile: user.profile,
    quizAnswers: user.quizAnswers || [],
    results: user.results || [],
    exportedAt: new Date().toISOString(),
  };
  const body = encodeURIComponent(JSON.stringify(payload, null, 2));
  const subject = encodeURIComponent('Паспорт студента — ' + (user.name || 'student'));
  const mailto = `mailto:${teacherEmail}?subject=${subject}&body=${body}`;
  window.location.href = mailto;
}

async function shareCurrentUserToSheets(endpointUrl) {
  if (!endpointUrl) return { ok: false, error: 'No endpoint provided' };
  if (!state.currentUser) return { ok: false, error: 'No current user' };
  const payload = { students: [ { ...state.currentUser } ] };
  try {
    const res = await fetch(endpointUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('Request failed');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function fetchSharedStudents(endpointUrl) {
  if (!endpointUrl) return { ok: false, error: 'No endpoint' };
  try {
    const res = await fetch(endpointUrl);
    if (!res.ok) throw new Error('Request failed');
    const json = await res.json();
    const incoming = Array.isArray(json) ? json : (json.students || []);
    const mergedResult = window.importStudentsDump ? window.importStudentsDump(JSON.stringify(incoming)) : { ok: false, error: 'import helper missing' };
    return mergedResult;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
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
  if (elements.authForm) elements.authForm.addEventListener('submit', handleAuthSubmit);
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

  // Remove any stored teacher accounts that are NOT in the whitelist.
  // Keep all other users (students) even if `email` is missing — do not drop student records.
  const whitelist = Array.isArray(state.teachersWhitelist) ? state.teachersWhitelist.map((e) => e.toLowerCase()) : [];
  state.users = state.users.filter((u) => {
    if (!u) return false;
    const role = (u.role || '').toString().trim().toLowerCase();
    if (role === 'teacher') {
      // teacher must have an email and be whitelisted
      return !!u.email && whitelist.includes(u.email.toLowerCase());
    }
    // keep students and other roles, even when email is absent
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
  // Attempt to initialize Firebase integration if `data/firebase-config.json` exists
  try {
    await initFirebaseIfConfigured();
  } catch (e) {
    console.info('Firebase not configured or failed to initialize:', e && e.message);
  }
  await loadAppData();
  renderApplication();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  }
}

document.addEventListener('DOMContentLoaded', initApp);

// Модуль секундоміра
(function initStopwatch() {
  let startTime = 0;
  let elapsedTime = 0;
  let timerInterval = null;
  let lapCounter = 1;

  const display = document.getElementById('stopwatch-display');
  const startBtn = document.getElementById('stopwatch-start-btn');
  const lapBtn = document.getElementById('stopwatch-lap-btn');
  const resetBtn = document.getElementById('stopwatch-reset-btn');
  const lapsContainer = document.getElementById('stopwatch-laps');

  if (!display || !startBtn) return;

  function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const centiseconds = Math.floor((ms % 1000) / 10);

    const m = String(minutes).padStart(2, '0');
    const s = String(seconds).padStart(2, '0');
    const cs = String(centiseconds).padStart(2, '0');
    return `${m}:${s}.${cs}`;
  }

  function update() {
    const current = Date.now();
    const diff = current - startTime + elapsedTime;
    display.textContent = formatTime(diff);
  }

  startBtn.addEventListener('click', () => {
    if (!timerInterval) {
      startTime = Date.now();
      timerInterval = setInterval(update, 20);
      startBtn.textContent = 'Пауза';
      startBtn.classList.replace('primary-btn', 'secondary-btn');
      lapBtn.disabled = false;
      resetBtn.disabled = false;
    } else {
      clearInterval(timerInterval);
      timerInterval = null;
      elapsedTime += Date.now() - startTime;
      startBtn.textContent = 'Продовжити';
      startBtn.classList.replace('secondary-btn', 'primary-btn');
      lapBtn.disabled = true;
    }
  });

  lapBtn.addEventListener('click', () => {
    if (!timerInterval) return;
    const current = Date.now();
    const diff = current - startTime + elapsedTime;
    const lapItem = document.createElement('li');
    lapItem.innerHTML = `<span>Коло ${lapCounter++}</span><span>${formatTime(diff)}</span>`;
    lapsContainer.prepend(lapItem);
  });

  resetBtn.addEventListener('click', () => {
    clearInterval(timerInterval);
    timerInterval = null;
    startTime = 0;
    elapsedTime = 0;
    lapCounter = 1;
    display.textContent = '00:00.00';
    startBtn.textContent = 'Старт';
    startBtn.classList.replace('secondary-btn', 'primary-btn');
    lapBtn.disabled = true;
    resetBtn.disabled = true;
    lapsContainer.innerHTML = '';
  });
})();