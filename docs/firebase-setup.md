Firebase setup for MotorTestingPWA

Overview
- This document describes a minimal Firebase configuration to enable centralized users storage (Auth + Firestore).

Steps
1. Create project
   - Visit https://console.firebase.google.com and create a new project.

2. Enable Authentication
   - In the console, go to "Authentication" → "Sign-in method".
   - Enable "Google" provider and save.

3. Create Firestore
   - In the console, go to "Firestore Database" and create a database in production or test mode (start test and tighten rules later).

4. Add web app and get config
   - In Project Settings → SDK setup and config, register a new Web app and copy the config object (apiKey, authDomain, projectId, etc.).
   - Create a file `data/firebase-config.json` in the project with that JSON object. Example:

```json
{
  "apiKey": "...",
  "authDomain": "your-project.firebaseapp.com",
  "projectId": "your-project-id",
  "storageBucket": "your-project.appspot.com",
  "messagingSenderId": "...",
  "appId": "1:...:web:..."
}
```

5. Secure Firestore rules (suggestion)
- Example rules to allow authenticated users to write their own document under `users/{uid}` and allow only teacher emails to read list:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if request.auth != null && (request.auth.token.email == 'athletica401@gmail.com' || request.auth.uid == userId);
      allow write: if request.auth != null && request.auth.token.email == request.resource.data.email;
    }
  }
}
```

Notes
- The client code auto-detects `data/firebase-config.json`. If present, it initializes Firebase and keeps Firestore in sync with local `motor-testing-users`.
- For production, prefer using server-side verification or Firebase custom claims to assign `teacher` roles securely.

Testing
- After adding `data/firebase-config.json`, open the app; if you sign in as a student and save profile, the user's document should appear in Firestore under `users`.
- If you sign in as the teacher email and open the teacher panel, the list should populate from Firestore in realtime.

If you want, I can generate `data/firebase-config.json` sample (without real keys) and add step-by-step screenshots.