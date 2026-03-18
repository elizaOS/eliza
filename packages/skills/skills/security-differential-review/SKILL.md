---
name: security-differential-review
description: "Perform security-focused differential code review on changesets, pull requests, and commits. Use when reviewing diffs for security implications, assessing whether code changes introduce vulnerabilities, or comparing before/after states of security-sensitive code."
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
---

# Security Differential Review

## When to Use

- Reviewing pull requests or commits for security implications
- Assessing whether a code change introduces new vulnerabilities
- Comparing before/after states of security-sensitive code
- Evaluating dependency updates for security impact
- Reviewing infrastructure-as-code changes for security regressions

## When NOT to Use

- Full codebase security audits (use audit-context-building first)
- Reviewing code without access to the diff
- Performance or feature reviews without security focus

## Review Methodology

### 1. Understand the Change Context
```bash
# View the full diff
git diff main..feature-branch

# See changed files
git diff --name-only main..feature-branch

# Check commit messages for security context
git log --oneline main..feature-branch
```

### 2. Categorize Changed Files by Risk

| Category | Examples | Review Priority |
|----------|----------|----------------|
| Auth/authz | Login, middleware, RBAC | Critical |
| Input handling | Parsers, validators, API handlers | High |
| Crypto/secrets | Key management, encryption, hashing | Critical |
| Data access | Database queries, ORM models | High |
| Configuration | Env config, security headers, CORS | High |
| Dependencies | package.json, go.mod, requirements.txt | Medium |
| Tests | Test files, fixtures | Low (but check for removed security tests) |
| UI/frontend | Templates, React components | Medium (XSS risk) |

### 3. Security-Focused Diff Analysis

**Look for:**
- Removed security checks (auth, validation, sanitization)
- New input handling without validation
- Changed trust boundaries
- Weakened cryptographic operations
- New dependencies with known vulnerabilities
- Hardcoded secrets or credentials
- Disabled security features (CSRF, CSP, rate limiting)
- Error handling changes that leak information

### 4. Dependency Change Review

```bash
# Compare dependency changes
diff <(git show main:package.json | jq '.dependencies') <(cat package.json | jq '.dependencies')

# Check new dependencies for vulnerabilities
npm audit
```

## Red Flags in Diffs

| Pattern | Risk |
|---------|------|
| `-if (user.isAdmin())` | Removed authorization check |
| `+// TODO: add auth later` | Security debt introduced |
| `-sanitize(input)` | Removed input sanitization |
| `+eval(userInput)` | Code injection |
| `-helmet()` | Removed security headers middleware |
| `+CORS: { origin: '*' }` | Overly permissive CORS |
| Deleted test files | Removed security regression tests |

## Output Format

For each finding:
1. **File and line** — exact location in the diff
2. **Issue** — what the security concern is
3. **Severity** — Critical / High / Medium / Low
4. **Recommendation** — specific fix or mitigation
