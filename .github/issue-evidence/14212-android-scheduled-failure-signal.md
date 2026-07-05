# #14212 Android scheduled failure signal

## Scope

This draft-PR follow-up covers only the visible failure-signal gap from #13580
after the weekly host-backed Android emulator cadence landed.

## Change

- `.github/workflows/android-device-e2e.yml` now grants `issues: write` only to
  a hosted Ubuntu notifier job.
- Scheduled failures run an `actions/github-script` step in
  `notify-scheduled-failure`, which depends on `android-e2e` and uses
  `always()` plus the `schedule` event guard so timeout/cancelled/runner-loss
  results still trigger the signal outside the timed Android job.
- The step creates or updates one open issue titled
  `Scheduled Android device e2e is failing (#13580)` with the failed run URL,
  artifact link, workflow name, Android job result, backend, timestamp, and the
  remaining #13580 residuals.
- Repeated scheduled failures update that issue body and add a fresh comment, so
  regressions are visible outside Actions history and artifact discovery.

## Verification

- `actionlint .github/workflows/android-device-e2e.yml`
  - Result: pass
- `ruby -e 'require "psych"; Psych.parse_file(ARGV.fetch(0)); puts "YAML parse: ok"' .github/workflows/android-device-e2e.yml`
  - Result: pass (`YAML parse: ok`)
- `rg -n "notify-scheduled-failure|needs: android-e2e|always\\(\\).*github.event_name == 'schedule'.*needs.android-e2e.result != 'success'|runs-on: ubuntu-24.04|issues: write|actions/github-script" .github/workflows/android-device-e2e.yml`
  - Result: pass; matched the notifier job, `needs: android-e2e`, scheduled
    `always()` guard, hosted runner, `issues: write`, and `github-script` step.
- `git diff --check`
  - Result: pass

## N/A

- Real scheduled failure creation is N/A locally; it requires the GitHub Actions
  `schedule` event and `GITHUB_TOKEN` issue-write context.
- LOCAL arm64 runner and signal-only PR leg promotion are explicitly outside
  this slice.
