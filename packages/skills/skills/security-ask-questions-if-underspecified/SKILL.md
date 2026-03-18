---
name: security-ask-questions-if-underspecified
description: "Ensure thorough security analysis by identifying and asking clarifying questions when requirements, threat models, or context are underspecified. Use when a security task lacks sufficient context, when threat boundaries are unclear, or when assumptions need to be validated before proceeding."
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
---

# Ask Questions When Underspecified

## When to Use

- A security review request lacks context about the threat model
- The scope of an audit or assessment is ambiguous
- Assumptions about trust boundaries need validation
- The deployment environment or architecture is unclear
- Risk tolerance or compliance requirements are not stated

## When NOT to Use

- Context is already sufficient to proceed with analysis
- The task is purely mechanical (run a scan, parse output)
- Questions would block urgent incident response

## Key Questions to Ask

### Before Any Security Review
1. What is the threat model? Who are the adversaries?
2. What are the trust boundaries? What input is untrusted?
3. What is the deployment environment (cloud, on-prem, edge)?
4. What compliance requirements apply (PCI, HIPAA, SOC2)?
5. What is the risk tolerance? (startup MVP vs. banking app)

### Before Code Audit
1. What changed recently? What is the scope of review?
2. Are there known vulnerabilities or areas of concern?
3. What authentication/authorization model is used?
4. What sensitive data does the application handle?
5. Has there been a previous audit? What was found?

### Before Architecture Review
1. What are the data flow paths for sensitive information?
2. Where are secrets stored and how are they rotated?
3. What is the blast radius if a single component is compromised?
4. What monitoring and alerting is in place?

## Why This Matters

Security analysis with wrong assumptions is worse than no analysis — it creates false confidence. A SQL injection review is useless if the real risk is an exposed admin panel. Asking the right questions up front ensures effort is directed at actual risks.

## Anti-Patterns to Avoid

| Anti-Pattern | Problem |
|-------------|---------|
| Assuming scope | Missing critical attack surface |
| Skipping threat model | Defending against wrong adversary |
| Not asking about data sensitivity | Misjudging impact severity |
| Assuming deployment environment | Missing environment-specific risks |
| Not clarifying "secure enough" | Over- or under-engineering defenses |
