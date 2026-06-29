# Issue 10096 — CI workflow dedup evidence

Scope: removes the automatic `main` trigger from the broad `Tests` workflow so
`ci.yaml` owns main-branch CI while `test.yml` owns develop/manual/scheduled
coverage. Keeps `scenario-pr.yml` as the zero-key deterministic PR E2E gate for
both `main` and `develop`. Adds a contract script to prevent the workflow split
and release-cache env from drifting.

Manual review:

- Confirmed `ci.yaml` still triggers automatically on push/PR to `main`.
- Confirmed `test.yml` now triggers automatically on push/PR to `develop`, plus
  manual and scheduled runs.
- Confirmed `scenario-pr.yml` still triggers on PRs to both `main` and
  `develop`, preserving zero-key deterministic PR E2E for main.
- Confirmed `nightly.yml` and `release.yaml` both keep `TURBO_TOKEN`,
  `TURBO_TEAM`, and `TURBO_CACHE: remote:rw`.

Verification:

```bash
node --check packages/scripts/ci-workflow-dedup-contract.mjs

node packages/scripts/ci-workflow-dedup-contract.mjs
# ci workflow dedup contract passed

actionlint -config-file .github/actionlint.yaml .github/workflows/test.yml .github/workflows/ci.yaml .github/workflows/scenario-pr.yml .github/workflows/nightly.yml .github/workflows/release.yaml
# no output, exit 0

node packages/scripts/ci-path-gate.self-test.mjs
# ci-path-gate self-test passed

git diff --check
# no whitespace errors
```

Evidence marked N/A:

- UI screenshots/video: N/A, no UI change.
- Live LLM trajectory: N/A, no prompt/model/agent behavior change.
- Native/device capture: N/A, workflow-policy change only.
