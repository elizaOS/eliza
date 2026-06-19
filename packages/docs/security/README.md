# Security Documentation

Security, SOC2, and compliance reference for the elizaOS repository. These
documents describe the threat model, controls, key lifecycle, and incident
response for the runtime, Cloud, and agent surfaces in this repo.

## Documents

- `SOC2-CONTROL-MATRIX.md` — full TSC → policy → code → evidence matrix.
- `THREAT-MODEL.md` — Eliza-specific threats.
- `INCIDENT-RUNBOOK.md` — per-scenario playbooks.
- `KEY-LIFECYCLE.md` — per-class key lifecycle.
- `AUDIT-EVIDENCE-INVENTORY.md` — what the auditor will request.
- `ai-pr-review-policy.md` — AI-assisted PR review policy.

## Package-specific security docs

- KMS / secrets package: [`../../packages/security/docs/`](../../packages/security/docs/)
- Repo-wide security policy: [`../../SECURITY.md`](../../SECURITY.md)
