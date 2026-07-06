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
- `MODEL-BOUNDARY-PRIVACY.md` — opt-in secret swap + PII pseudonymization that keep secrets and personal data out of the LLM provider.

## Package-specific security docs

- KMS / secrets package: [`../../security/docs/`](../../security/docs/)
- Security reporting workflow: [`../../../CONTRIBUTING.md`](../../../CONTRIBUTING.md#security-reporting)
