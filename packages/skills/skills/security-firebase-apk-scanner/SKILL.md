---
name: security-firebase-apk-scanner
description: "Scan Android APKs for Firebase misconfigurations and exposed credentials. Use when analyzing Android applications for insecure Firebase configurations, leaked API keys, open Realtime Database or Firestore instances, exposed Cloud Storage buckets, or misconfigured authentication settings."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Firebase APK Security Scanner

## When to Use

- Analyzing Android APKs for Firebase configuration issues
- Checking for exposed Firebase API keys and project IDs
- Testing Firebase Realtime Database and Firestore access controls
- Identifying misconfigured Firebase Storage buckets
- Assessing Firebase Authentication settings

## When NOT to Use

- iOS app analysis (different extraction method)
- General Android reverse engineering (use dedicated RE tools)
- Non-Firebase backend security testing

## APK Analysis Workflow

### 1. Extract Firebase Config

```bash
# Decompile APK
apktool d app.apk -o app_decoded/

# Find google-services.json or Firebase config
find app_decoded/ -name "google-services.json" -o -name "*.xml" | xargs grep -l "firebase"

# Extract from strings.xml
grep -r "firebase_database_url\|google_api_key\|google_app_id\|project_id\|storage_bucket" app_decoded/
```

### 2. Key Configuration Values

| Value | Location | Risk if Exposed |
|-------|----------|----------------|
| `firebase_database_url` | strings.xml / google-services.json | Direct database access if rules are open |
| `google_api_key` | strings.xml | API abuse, quota theft |
| `google_storage_bucket` | strings.xml | File access if rules are open |
| `project_id` | google-services.json | Enumeration, targeted attacks |
| `gcm_defaultSenderId` | google-services.json | Push notification abuse |

### 3. Test Database Access

```bash
# Test Realtime Database (unauthenticated read)
curl -s "https://<project-id>-default-rtdb.firebaseio.com/.json"

# Test specific paths
curl -s "https://<project-id>-default-rtdb.firebaseio.com/users.json"

# Test write access
curl -X PUT -d '{"test":"probe"}' "https://<project-id>-default-rtdb.firebaseio.com/test.json"
```

### 4. Test Storage Access

```bash
# List storage bucket contents
gsutil ls gs://<bucket-name>/ 2>/dev/null

# Or via REST API
curl -s "https://firebasestorage.googleapis.com/v0/b/<bucket-name>/o"
```

### 5. Check Firestore Rules

```bash
# Test Firestore read (unauthenticated)
curl -s "https://firestore.googleapis.com/v1/projects/<project-id>/databases/(default)/documents/<collection>"
```

## Common Misconfigurations

| Misconfiguration | Impact | Fix |
|-----------------|--------|-----|
| Database rules: `".read": true` | Anyone can read all data | Use authenticated rules |
| Storage rules: `allow read, write` | Public file access | Require authentication |
| No Firestore rules | Default deny (safe) | Explicitly set rules |
| API key unrestricted | API abuse and billing | Restrict by app/IP/referrer |
| Auth sign-up unrestricted | Account enumeration | Rate limit; restrict domains |

## Remediation

1. Apply least-privilege Firebase Security Rules
2. Restrict API keys to specific apps and APIs
3. Enable App Check for additional verification
4. Monitor Firebase usage for anomalies
5. Use Firebase Auth for all data access
