---
name: security-audit-context-building
description: "Build comprehensive context before performing a security audit by mapping architecture, identifying trust boundaries, cataloging sensitive data flows, and understanding the threat model. Use when preparing for a security review, onboarding to a new codebase for audit, or establishing the scope and context for security testing."
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
---

# Security Audit Context Building

## When to Use

- Starting a security audit of an unfamiliar codebase
- Building a threat model before deep technical review
- Mapping data flows to identify sensitive paths
- Establishing audit scope and priorities
- Documenting architecture for security assessment

## When NOT to Use

- You already have full context and are ready to audit
- Quick spot-check of a specific code change (use fix-review)
- Automated scanning (use static analysis tools)

## Context Building Phases

### Phase 1: Architecture Overview
1. Identify the tech stack (languages, frameworks, databases)
2. Map service boundaries and communication patterns
3. Identify external dependencies and third-party integrations
4. Understand deployment topology (cloud, containers, serverless)

```bash
# Tech stack discovery
find . -name "package.json" -o -name "requirements.txt" -o -name "go.mod" -o -name "Cargo.toml" | head -20
cat package.json 2>/dev/null | grep -A5 '"dependencies"'
```

### Phase 2: Trust Boundaries
1. Where does untrusted input enter the system?
2. What authentication/authorization mechanisms are used?
3. Where are privilege escalation boundaries?
4. What services communicate and with what trust level?

```bash
# Find auth mechanisms
grep -rn "auth\|jwt\|session\|token\|middleware" --include="*.ts" --include="*.py" -l .
```

### Phase 3: Sensitive Data Flows
1. What sensitive data does the system handle? (PII, credentials, financial)
2. How is sensitive data stored? (encrypted at rest?)
3. How does sensitive data move between components? (encrypted in transit?)
4. Where are secrets stored and how are they accessed?

```bash
# Find potential secret handling
grep -rn "password\|secret\|key\|token\|credential" --include="*.env*" --include="*.yaml" --include="*.json" -l .
```

### Phase 4: Attack Surface Catalog
1. List all external-facing endpoints
2. Identify file upload/download capabilities
3. Map administrative interfaces
4. Catalog webhook and callback URLs

### Phase 5: Historical Context
1. Review recent security-related commits
2. Check for past vulnerability reports or advisories
3. Identify previously audited areas
4. Note known tech debt or deferred security work

```bash
# Security-related git history
git log --oneline --all --grep="security\|vulnerability\|CVE\|fix\|patch" | head -20
```

## Output: Audit Context Document

Produce a structured document covering:
- Architecture diagram (text-based)
- Trust boundary map
- Sensitive data inventory
- Attack surface catalog
- Prioritized review areas
- Known risks and assumptions
