# #12365 — Unlock onboarding composer with deterministic conductor replies (#12178 WI-3)

## Summary

The composer-unlock feature (unlocked composer during onboarding + deterministic
in-chat conductor replies + the "no server send pre-completion" invariant) landed
on develop in commit `5121d5f84ae` ("feat(ui): opaque full-screen onboarding +
unlocked composer (#12178 WI-2/WI-3) (#12437)"). Verified every "Done when" and
Verification bullet against develop; all are satisfied EXCEPT the
`onboarding-confused-user e2e typed-message step`, which was never added. This PR
adds that missing e2e coverage and corrects a stale "locked composer" comment.

## What each Done-when bullet maps to (on develop)

- **Typing during onboarding always yields an in-transcript reply within one
  frame** — `packages/ui/src/first-run/use-first-run-conductor.ts`
  `handleFirstRunText` seeds a local user turn + a deterministic assistant reply
  (`FIRST_RUN_TEXT_REPLY`, no clocks/RNG), keyed on flow position
  (choosing/provisioning/wrapUp/error). Monotonic `textTurnSeqRef` ids prevent
  same-millisecond dedup.
- **Network sends blocked before completion except intended first-run actions** —
  `packages/ui/src/state/AppContext.tsx` `sendActionMessage`: the `"conductor"`
  case (free text while `firstRunComplete !== true`) calls `tryHandleFirstRunText`
  and returns `Promise.resolve()`, never `rawSendActionMessage`. Reserved
  `__first_run__:` prefix is dropped unconditionally
  (`classifyActionMessage` → `"first-run"`).
- **Confused-user + fuzz tests cover interleaved free-text and choice picks** —
  `use-first-run-conductor.fuzz.test.ts` + `use-first-run-conductor.test.ts` +
  `first-run-action-channel.test.ts`, plus (added here) the confused-user e2e
  typed-message step.

## This PR's change

`packages/app/test/ui-smoke/onboarding-confused-user.spec.ts`:
- New spec `typing free text during onboarding gets an in-transcript reply and
  never reaches the server`: types free text into the unlocked composer BEFORE
  picking a runtime, asserts the local user turn + the conductor's "choosing"
  reply both render, asserts a second impatient send is also acknowledged
  (monotonic ids), asserts `firstRunPosts.length === 0` and zero typed text
  reaching the server, then finishes by tapping through (one POST, zero leaks).
- Corrected a stale "locked composer" comment (composer is now unlocked).

## Evidence

### Unit + fuzz tests (real vitest, jsdom) — PASS

```
bun run --cwd packages/ui test \
  src/first-run/use-first-run-conductor.test.ts \
  src/first-run/use-first-run-conductor.fuzz.test.ts \
  src/first-run/first-run-action-channel.test.ts \
  src/components/shell/ContinuousChatOverlay.firstrun.test.tsx

Test Files  4 passed (4)
     Tests  59 passed (59)
```

### Playwright discovery of the new e2e — PASS

```
CI=true npx playwright test --config playwright.ui-smoke.config.ts \
  onboarding-confused-user --list

[chromium] › onboarding-confused-user.spec.ts:73:3 › confused-user onboarding ›
  typing free text during onboarding gets an in-transcript reply and never reaches the server
[chromium] › ... double-clicking every choice ...
[chromium] › ... a failing first-run POST re-offers UNLOCKED choices ...
[chromium] › ... reloading mid-onboarding re-seeds ...
Total: 4 tests in 1 file
```

Spec compiles + is discovered; `biome check` clean.

### e2e live run — N/A (worktree cannot boot the renderer stack)

The full `test:e2e` webServer builds the app renderer (`packages/app build:web`),
which requires the complete workspace install layout. This isolated agent
worktree shares the parent clone's `node_modules` by directory walk-up and lacks
per-package installs; the renderer vite build fails at
`core/src/features/documents/utils.ts` (`"Buffer" is not exported by
"__vite-browser-external"`) — a browser-externalization issue in the shared-tree
build environment that is orthogonal to this change and would break every e2e
spec equally. The spec runs in CI, which has a full install. See
`reference_worktree_shares_parent_node_modules.md`.
