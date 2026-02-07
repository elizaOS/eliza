---
name: trailofbits:variants
description: Finds similar vulnerabilities using pattern-based analysis
argument-hint: "(uses conversation context for bug pattern)"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Task
---

# Find Vulnerability Variants

**Arguments:** $ARGUMENTS

This command is context-driven. Use conversation context to understand:
1. The original bug/vulnerability that was found
2. The codebase to search

If context is unclear, ask for a description of the original vulnerability.

Invoke the `variant-analysis` skill for the full workflow.
