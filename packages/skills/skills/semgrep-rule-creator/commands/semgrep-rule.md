---
name: trailofbits:semgrep-rule
description: Creates Semgrep rules with test-first methodology
argument-hint: "(uses conversation context for detection pattern)"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - WebFetch
---

# Create Semgrep Rule

**Arguments:** $ARGUMENTS

This command is context-driven. Use conversation context to understand:
1. The vulnerability or pattern to detect
2. The target language
3. Whether taint mode is appropriate

If context is unclear, ask for a description of the pattern to detect.

Invoke the `semgrep-rule-creator` skill for the full workflow.
