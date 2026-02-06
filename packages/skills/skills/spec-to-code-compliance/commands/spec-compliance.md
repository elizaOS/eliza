---
name: trailofbits:spec-compliance
description: Verifies code implements specification requirements
argument-hint: "<spec-document> <codebase-path>"
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - WebFetch
---

# Verify Spec-to-Code Compliance

**Arguments:** $ARGUMENTS

Parse arguments:
1. **Spec document** (required): Path to specification (PDF, MD, DOCX, HTML, TXT, or URL)
2. **Codebase path** (required): Path to codebase to verify

Invoke the `spec-to-code-compliance` skill with these arguments for the full workflow.
