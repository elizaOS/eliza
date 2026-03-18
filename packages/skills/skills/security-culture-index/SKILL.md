---
name: security-culture-index
description: "Assess and improve an organization's security engineering culture by evaluating codebase practices, CI/CD security hygiene, dependency management, and security testing integration. Use when auditing security maturity, evaluating security posture of a project, or recommending security process improvements."
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
---

# Security Culture Index

## When to Use

- Evaluating the security maturity of a codebase or project
- Assessing whether security practices are embedded in development workflows
- Identifying gaps in security tooling, testing, and processes
- Recommending improvements to security engineering practices
- Benchmarking security posture before and after improvements

## When NOT to Use

- Finding specific vulnerabilities (use static analysis or audit skills)
- Penetration testing or active exploitation
- Compliance audits against specific standards (SOC2, ISO27001)

## Assessment Dimensions

### 1. Dependency Management
- Are dependencies pinned to exact versions?
- Is there automated dependency scanning (Dependabot, Snyk, Renovate)?
- How quickly are security patches applied?
- Are lockfiles committed and reviewed?

### 2. CI/CD Security
- Are secrets managed via secret stores (not env vars or hardcoded)?
- Is SAST (Semgrep, CodeQL) integrated in CI?
- Are container images scanned?
- Is there branch protection requiring security checks to pass?

### 3. Code Review Practices
- Do PRs require security-focused review for sensitive areas?
- Are security-relevant changes flagged automatically?
- Is there a CODEOWNERS file for security-sensitive paths?

### 4. Testing Maturity
- Are there security-specific test cases?
- Is fuzzing integrated for parsing/input handling code?
- Are auth/authz boundaries tested explicitly?

### 5. Incident Readiness
- Is there a security incident response plan?
- Are logs sufficient for forensic investigation?
- Can deployments be rolled back quickly?

## Quick Assessment Commands

```bash
# Check for security scanning in CI
find . -name "*.yml" -path "*/.github/*" | xargs grep -l "semgrep\|codeql\|snyk\|trivy\|dependabot"

# Check for secrets in code
grep -rn "password\|secret\|api_key\|token" --include="*.env*" --include="*.yaml" .

# Check for pinned dependencies
grep -c "==" requirements.txt 2>/dev/null || echo "No requirements.txt"
```

## Scoring Framework

| Dimension | 0 (None) | 1 (Ad-hoc) | 2 (Integrated) | 3 (Mature) |
|-----------|----------|------------|-----------------|------------|
| SAST | No scanning | Manual runs | CI-integrated | Custom rules + triage |
| Dependencies | No management | Manual updates | Automated scanning | Auto-merge for patches |
| Code Review | No security focus | Informal | Checklists | CODEOWNERS + auto-flag |
| Testing | No security tests | Some unit tests | Fuzz + property tests | Continuous fuzzing |
| Incident Response | No plan | Basic runbook | Tested playbooks | Regular game days |
