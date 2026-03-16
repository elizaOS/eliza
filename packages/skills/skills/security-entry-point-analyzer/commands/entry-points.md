---
name: trailofbits:entry-points
description: Identifies state-changing entry points in smart contracts
argument-hint: "[directory-path]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
---

# Analyze Smart Contract Entry Points

**Arguments:** $ARGUMENTS

Parse the directory path from arguments. If empty, use current directory.

Invoke the `entry-point-analyzer` skill with the directory path for the full workflow.
