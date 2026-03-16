---
name: trailofbits:fix-review
description: Reviews commits for bug introduction and verifies audit finding remediation
argument-hint: "<source-commit> <target-commit(s)> [--report <path-or-url>]"
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
  - WebFetch
  - Task
---

# Fix Review

**Arguments:** $ARGUMENTS

Parse arguments:
1. **Source commit** (required): Baseline commit before fixes
2. **Target commit(s)** (required): One or more commits to analyze
3. **Report** (optional): `--report <path-or-url>` for security audit report

Invoke the `fix-review` skill with these arguments for the full workflow.
