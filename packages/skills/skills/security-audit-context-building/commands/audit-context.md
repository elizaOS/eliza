---
name: trailofbits:audit-context
description: Builds deep architectural context before vulnerability hunting
argument-hint: "<codebase-path> [--focus <module>]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Task
---

# Build Audit Context

**Arguments:** $ARGUMENTS

Parse arguments:
1. **Codebase path** (required): Path to codebase to analyze
2. **Focus** (optional): `--focus <module>` for specific module analysis

Invoke the `audit-context-building` skill with these arguments for the full workflow.
