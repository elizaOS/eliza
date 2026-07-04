# Develop Merge Queue

This document defines the agent-owned workflow contract for enabling GitHub
merge queue on `develop`. Repository administrators still own the branch ruleset
and queue enablement; see the `needs-human` admin issue linked from #12339.

## Required Status Check

Require exactly this aggregate check in the `develop` ruleset:

- `ci-ok`

`ci-ok` is the final job in `.github/workflows/test.yml`. It depends on every
required job in the Tests workflow and fails when any required job result is not
`success`, except for explicitly allowed PR-only path-gated skips.

## Merge-Group Suite

`merge_group` runs validate the synthesized queue SHA, not an individual PR
diff. For that reason the Tests workflow deliberately ignores PR path-gating on
`merge_group` and runs the full required suite:

- Server Tests
- Client Tests
- XR harness e2e
- Plugin Tests
- Integration Lane (personal-assistant)
- Electrobun Desktop Contract
- Zero-Key deterministic E2E aggregate
- Cloud Live E2E, when its configured secrets are present
- Remote Capability Provider Live E2E, when its configured secrets are present

Pull requests still use `packages/scripts/ci-path-gate.mjs` so small PRs can
skip unrelated lanes, but queue entries do not.

The Remote Capability GitHub Live Artifact Validator is deliberately observed
only on `workflow_dispatch` and `schedule`, where the report-producing live
smokes run. `ci-ok` allows that validator to be skipped on `pull_request`,
`push`, and `merge_group` events.

## Runtime Budget

Initial queue target:

- p95 `merge_group` runtime for `ci-ok`: 90 minutes or less
- measurement window: 10 consecutive merge-group runs
- if p95 exceeds the target, file follow-up issues for the longest jobs before
  tightening the ruleset further

The admin closeout evidence should include the 10-run timing report and any
long-pole follow-ups.

## Flake Policy

Do not bypass `ci-ok` for a flaky job without preserving a public trail.

When a merge-group run fails:

1. Re-run only failed jobs once if the failure is infrastructure-shaped
   (network reset, runner loss, package registry outage, or clearly unrelated
   service timeout).
2. If the rerun passes, comment on the PR or queue evidence with the failed run,
   rerun link, and suspected external cause.
3. If the same job flakes twice in a 24-hour window, open a focused flake issue
   with logs and mark the job owner.
4. If the failure is product/test logic, fix it in a PR. Do not quarantine it as
   a flake.

Temporary quarantines must include:

- the tracking issue
- the exact skipped assertion/job/lane
- the removal condition
- a due date or run-count limit

## Admin Ruleset Checklist

After the workflow PR lands, a repository admin should:

1. Enable merge queue for `develop`.
2. Require the `ci-ok` status check.
3. Keep required-up-to-date disabled if merge queue owns the queue SHA.
4. Use queue settings from the admin issue unless updated by measured evidence.
5. Attach ruleset JSON, a queue-merged canary PR, a blocked red PR, and the
   10-run timing report to the admin issue.
