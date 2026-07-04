# CI baseline — #12191 / phase 1 (#12337)

Snapshot of `develop` post-merge CI health **before** the phase-1 concurrency
restoration, so phases 2/4/5 have a fixed before/after reference. Measured on
`develop` at the time the phase-1 branch (`fix/12337-ci-concurrency-restore`)
was cut.

## Method

```bash
gh run list --repo elizaos/eliza --workflow <wf> --branch develop --event push \
  --limit <N> --json conclusion,createdAt
```

## Headline: develop post-merge CI does not complete

Every push to `develop` shared one concurrency group keyed by
`${{ github.ref }}` (constant `refs/heads/develop`). GitHub keeps at most one
running + one pending run per group and cancels the older pending run when a
newer one arrives — regardless of `cancel-in-progress` — so under ~300–400
pushes/day only the newest push's run survives, and it is itself superseded
seconds later. Result: coverage runs are cancelled before they finish.

| Workflow (develop, event=push) | Window | Runs sampled | cancelled | success/failure | in‑progress |
| --- | --- | --- | --- | --- | --- |
| `test.yml` (Tests) | last 100 | 100 | 99 | **0** | 1 |
| `test.yml` (Tests) | last 200 | 200 | 199 | **0** | 1 |
| `quality.yml` (Quality Extended) | last 100 | 100 | 99 | **0** | 1 |

- The 100 sampled `test.yml` runs span **2026-07-04T07:20:25Z →
  2026-07-04T15:19:30Z** (~8 h) — ≈12.5 push runs/hour on `test.yml` alone
  (≈300/day).
- **0 completed** `test.yml` develop-push runs in the last 200 (≈16 h of pure
  cancellation). Matches the epic-#12191 research finding (last completed
  develop push run 2026‑06‑18; 398/400 cancelled).
- Scheduled `test.yml` (cron `17 9 * * *`) shared the same
  `test-refs/heads/develop` group as push traffic, so the nightly smoke was
  cancelled by pushes too.

## Skipped-as-pass gap

`test.yml`'s `ci-ok` aggregate treated only `merge_group`,
`workflow_dispatch`, and `schedule` as strict events — a real lane that came
back `skipped` on **`push`** counted as pass. Lane `if:` guards
(`github.event_name != 'pull_request' || …`) already force every deterministic
lane to *run* on push, so a `skipped` there signals a real misconfiguration,
not a path-gate.

## Scope of concurrency groups affected

66 workflows trigger on `push: develop` or `schedule`; the deterministic
coverage/gate lanes among them were ref-keyed and thus mutually cancelling.
Deploy/publish, singleton janitors, native-artifact builds, and scheduled-only
heavy benchmark/live lanes are intentionally excluded (they carry deliberate
serialization or latest-only semantics and are not develop coverage).

## Fix applied (phase 1)

- Coverage/gate lanes re-keyed to
  `group: <prefix>-${{ github.event.pull_request.number || github.run_id }}`
  with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`, so each
  develop push and each scheduled run gets its own group and completes, while
  PRs still cancel superseded runs.
- `ci-ok` `strict_results` now includes `push`, so a skipped real lane on
  `develop` fails the aggregate instead of passing silently.

## After metrics (to be filled by phase 5, #12342)

Re-run the same `gh run list` census once the change has been on `develop` long
enough to accumulate completed push runs; record completion rate, cancel rate,
wall-clock p50/p95, and billable-minute deltas against this baseline.
