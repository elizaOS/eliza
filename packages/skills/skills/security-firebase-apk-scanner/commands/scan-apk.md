---
name: trailofbits:scan-apk
description: Scans Android APKs for Firebase security misconfigurations
argument-hint: "<apk-file-or-directory>"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Scan APK for Firebase Misconfigurations

**Arguments:** $ARGUMENTS

Parse the APK path from arguments. If empty, ask for the path.

Invoke the `firebase-apk-scanner` skill with the APK path for the full workflow.
