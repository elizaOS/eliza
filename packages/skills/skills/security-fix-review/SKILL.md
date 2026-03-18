---
name: security-fix-review
description: "Review security patches and fixes for completeness and correctness. Use when evaluating whether a security fix actually addresses the root cause, checking for fix bypasses, verifying regression tests cover the vulnerability, and ensuring the fix doesn't introduce new issues."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Security Fix Review

## When to Use

- Reviewing a proposed patch for a security vulnerability
- Verifying a fix addresses the root cause, not just a symptom
- Checking for variant vulnerabilities the fix might miss
- Ensuring regression tests adequately cover the vulnerability
- Validating that a fix doesn't introduce new attack surface

## When NOT to Use

- Initial vulnerability discovery (use audit or static analysis skills)
- General code review without security context
- Performance optimization reviews

## Review Checklist

### 1. Root Cause Analysis
- Does the fix address the root cause or just block one exploit path?
- Could an attacker reach the same vulnerable code via a different path?
- Are there other instances of the same bug pattern in the codebase?

### 2. Fix Completeness
- Does the fix handle all input variations (encoding, normalization, edge cases)?
- Are error paths also patched?
- Does the fix work across all supported platforms/configurations?

### 3. Bypass Analysis
- Can the fix be circumvented with different input encoding?
- Does the fix rely on client-side validation that can be skipped?
- Are there TOCTOU (time-of-check-time-of-use) windows?

### 4. Regression Testing
- Do tests exercise the exact vulnerability trigger?
- Do tests cover bypass attempts?
- Are negative tests included (ensure safe inputs still work)?

### 5. Side Effects
- Does the fix change any public API behavior?
- Could the fix cause denial of service (overly strict validation)?
- Does the fix introduce new dependencies with their own attack surface?

## Common Fix Anti-Patterns

| Anti-Pattern | Problem |
|-------------|---------|
| Blocklist approach | Attacker finds unlisted variant |
| Input length check only | Doesn't prevent malicious short inputs |
| Error suppression | Hides the symptom, not the cause |
| Single-layer defense | One bypass defeats entire mitigation |
| Fix in wrong layer | Vulnerability remains reachable via other callers |

## Workflow

1. Read the vulnerability report / advisory
2. Understand the root cause and attack vector
3. Review the diff with security lens
4. Search for variant instances (`grep`, CodeQL, Semgrep)
5. Verify test coverage of the vulnerability
6. Check for bypass opportunities
7. Document findings with severity assessment
