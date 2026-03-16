# Firebase APK Security Scanner

Scan Android APKs for Firebase security misconfigurations including open databases, exposed storage buckets, and authentication bypasses.

## When to Use

Use this skill when you need to:
- Audit Android applications for Firebase misconfigurations
- Test Firebase endpoints extracted from APKs (Realtime Database, Firestore, Storage)
- Check authentication security (open signup, anonymous auth, email enumeration)
- Enumerate Cloud Functions and test for unauthenticated access
- Perform mobile app security assessments involving Firebase backends

## When NOT to Use

- Scanning apps you do not have explicit authorization to test
- Testing production Firebase projects without written permission
- When you only need to extract Firebase config without testing (use manual grep/strings instead)
- For non-Android targets (iOS, web apps) - this skill is APK-specific
- When the target app does not use Firebase

## What It Does

This skill automates Firebase security testing for Android applications. When invoked, Claude will:

- **Decompile** the APK using apktool
- **Extract** Firebase configuration from all sources (google-services.json, XML resources, assets, smali code, DEX strings)
- **Test** authentication endpoints for misconfigurations
- **Probe** Realtime Database and Firestore for open read/write access
- **Check** Storage buckets for public listing and upload vulnerabilities
- **Enumerate** Cloud Functions and test accessibility
- **Generate** detailed reports with findings and remediation guidance

## Key Features

- Supports native Android, React Native, Flutter, and Cordova apps
- Extracts config from 7+ sources including raw DEX binary strings
- Tests 14 distinct vulnerability categories
- Automatic cleanup of test data created during scans
- Detailed vulnerability reference documentation included

## Installation

```
/plugin install trailofbits/skills/plugins/firebase-apk-scanner
```

## Prerequisites

Install required dependencies before use:

**macOS:**
```bash
brew install apktool curl jq binutils
```

**Ubuntu/Debian:**
```bash
sudo apt install apktool curl jq unzip binutils
```

## Usage

```
/firebase-scan ./app.apk
/firebase-scan ./apks/
```

Or run the standalone script directly:

```bash
./scanner.sh app.apk
./scanner.sh ./apks/ --no-cleanup
```

## Vulnerability Categories

| Category | Tests | Severity |
|----------|-------|----------|
| **Authentication** | Open signup, anonymous auth, email enumeration | Critical/High/Medium |
| **Realtime Database** | Unauthenticated read/write, auth token bypass | Critical/High |
| **Firestore** | Document access, collection enumeration | Critical/High |
| **Storage** | Bucket listing, unauthenticated upload | Critical/High |
| **Cloud Functions** | Unauthenticated access, function enumeration | Medium/Low |
| **Remote Config** | Public parameter exposure | Medium |
