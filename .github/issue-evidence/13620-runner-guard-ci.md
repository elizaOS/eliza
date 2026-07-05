# 13620 runner guard CI wiring

## Scope

- Wired `packages/scripts/__tests__/run-all-tests-vacuous-green-guard.test.ts`
  into `.github/workflows/scenario-pr.yml` next to the other explicit
  `packages/scripts/__tests__` contracts.
- Wired the same guard into `.github/workflows/test.yml` as an always-on
  ordinary PR job required by the `ci-ok` aggregate, so the guard no longer
  depends on the opt-in `ci:full` heavy scenario family.
- Hardened the guard's "valid min-tasks floor succeeds" case to use a
  self-contained temporary workspace fixture instead of depending on
  `@elizaos/agent` being present in sparse worktrees.

Out of scope: the larger #13620 coverage-gate allowlist / changed-source
coverage tasks remain open.

## Verification

Passed:

```bash
bun test packages/scripts/__tests__/run-all-tests-vacuous-green-guard.test.ts
bunx @biomejs/biome check \
  .github/workflows/test.yml \
  .github/workflows/scenario-pr.yml \
  .github/issue-evidence/13620-runner-guard-ci.md \
  packages/scripts/__tests__/run-all-tests-vacuous-green-guard.test.ts
bunx yaml-lint .github/workflows/test.yml .github/workflows/scenario-pr.yml
git diff --check
```

Result: 11 tests passed, 0 failed, 27 assertions.

N/A:

- Screenshots/video: workflow/test-runner contract only; no UI changed.
- Live model trajectory: no model/action/provider behavior changed.
