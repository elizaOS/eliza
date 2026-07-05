# #13580 Android scheduled failure signal

## Scope

This follow-up covers only the visible failure-signal gap from #13580 after the
weekly host-backed Android emulator cadence landed.

## Change

- `.github/workflows/android-device-e2e.yml` now grants `issues: write` only to
  a hosted Ubuntu notifier job.
- Scheduled failures run an `actions/github-script` step in
  `notify-scheduled-failure`, which depends on `android-e2e` and uses
  `always()` so timeout/cancelled/runner-loss results still trigger the signal.
- The step creates or updates one open issue titled
  `Scheduled Android device e2e is failing (#13580)` with the failed run URL,
  artifact link, workflow name, Android job result, backend, timestamp, and the
  remaining #13580 residuals.
- Repeated scheduled failures update that issue body and add a fresh comment, so
  regressions are visible outside Actions history and artifact discovery.

## Verification

- `actionlint .github/workflows/android-device-e2e.yml`
  - Result: pass
- `git diff --check`
  - Result: pass
- `GOBIN=/tmp/codex-go-bin go install github.com/rhysd/actionlint/cmd/actionlint@latest && /tmp/codex-go-bin/actionlint .github/workflows/android-device-e2e.yml`
  - Result: pass
- `bun install`
  - Result: blocked by host storage while expanding this isolated sparse
    worktree: `No space left on device` creating files under
    `packages/research/robot/examples/robot-mujoco-demo/evidence/...`

## N/A

- Real scheduled failure creation is N/A locally; it requires the GitHub Actions
  `schedule` event and `GITHUB_TOKEN` issue-write context.
- LOCAL arm64 runner and signal-only PR leg promotion are explicitly outside
  this slice.
