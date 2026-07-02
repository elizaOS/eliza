# Confused-user onboarding hardening — evidence (#10722)

Onboarding is fully in-chat (no standalone runtime/provider screens — negative
assertions for the removed `first-run-runtime-chooser` / `first-run-chat` /
`startup-first-run-background` testids run in every spec). This bundle proves
the confused-user hardening: spam taps, wrong-order picks, mid-flow reloads,
and a failing backend all converge to a completed onboarding with exactly one
`POST /api/first-run` and zero `__first_run__:` sentinels leaking to the
server as chat messages.

All captures are from the real shell (`packages/app` ui-smoke stack, network
mocked at the route boundary only) on this branch.

## Videos (real-shell walkthroughs, Chromium)

- `video-double-click-spam-one-post.webm` — every choice double-clicked;
  exactly one POST, no sentinel leaks, lands on home.
- `video-post-500-retry-completes.webm` — POST /api/first-run 500s; error
  turn re-offers an UNLOCKED runtime choice; retry seeds a FRESH provider turn
  and completes (one successful POST).
- `video-reload-mid-onboarding.webm` — reload after picking a runtime;
  fresh flow re-seeds and completes exactly once.
- `video-local-onboarding-to-home-launcher.webm` — full local happy path
  (greeting → runtime → provider → tutorial-skip → home → swipe-left launcher).
- `video-mobile-touch-onboarding-to-home.webm` — mobile viewport with REAL
  CDP touch input, onboarding → home → launcher.

## Screenshots

- `first-run-post-failed.png` — the injected failure state: picked rows locked
  (checkmarks), error turn ("disk full") with a fresh unlocked runtime row,
  composer still locked ("Choose an option to continue").
- `retry-after-failure-home.png` — home after the retry (sheet auto-collapsed,
  composer unlocked "Ask Eliza").
- `double-click-home.png`, `after-reload-fresh-onboarding.png`,
  `after-reload-home.png` — the other two specs' landings.

## Logs

- `unit-fuzz-test-run.log` — packages/ui first-run + cloud/handoff suites:
  20 files / 201 tests green, including the five seeded 250-step fuzz storms
  (`use-first-run-conductor.fuzz.test.ts`) asserting the exactly-once
  invariants (≤1 POST, ≤1 cloud provision, ≤1 completeFirstRun, bounded
  transcript, all sentinel values consumed) and the 9 reload-resume cases for
  the shared→dedicated handoff (`resume-pending-handoff.test.ts`).

## How to reproduce

```bash
bun run --cwd packages/app test:e2e -- onboarding-confused-user onboarding-to-home
bun run --cwd packages/ui test -- run src/first-run/ src/cloud/handoff/
```
