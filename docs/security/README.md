# Security Documentation (eliza submodule mirror)

> **Authoritative copies live in the outer `milady` monorepo.** This directory holds in-tree mirrors of the documents most useful when working inside the `eliza/` submodule. Cross-references in the mirrored files use paths that resolve in the outer monorepo (`milady/POLICIES/`, `milady/docs/security/`, `milady/deploy/observability/`); consult them there for full context.

## Mirrored documents

- `SOC2-CONTROL-MATRIX.md` — full TSC → policy → code → evidence matrix.
- `THREAT-MODEL.md` — Eliza-specific threats.
- `INCIDENT-RUNBOOK.md` — per-scenario playbooks.
- `KEY-LIFECYCLE.md` — per-class key lifecycle.
- `AUDIT-EVIDENCE-INVENTORY.md` — what the auditor will request.
- `ai-pr-review-policy.md` — existing eliza-side policy.

## Authoritative locations (in the outer `milady` monorepo)

- Policy library: `milady/POLICIES/` (24 numbered policies)
- Security docs: `milady/docs/security/`
- Observability config: `milady/deploy/observability/`
- Top-level entry: `milady/SOC2.md`
- Responsible disclosure: `milady/SECURITY.md`

## Eliza-package-specific security docs

- KMS package: [`../../packages/security/docs/`](../../packages/security/docs/)
