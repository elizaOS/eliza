# #11506 — durable onboarding-completion persistence (regression guard + client hardening)

## Context / adjudication

Issue #11506 ("onboarding never persists; agent restarts every ~1–2 min") was
**closed COMPLETED** after on-device forensics (Pixel 6a, evidence branch
`evidence/11506-restart-repro`) attributed the observed re-onboarding to the
process being killed, NOT to a defect in the persistence mechanism:

- **Primary:** Android LowMemoryKiller — 5 `reason=3 (LOW_MEMORY)` kills at
  RSS ~3.2–3.3 GB (Vulkan inference host) on a 5.7 GB device.
- **Secondary:** post-kill FGS restart crash cascade
  (`ForegroundServiceStartNotAllowedException`) — **fixed in #11738** (clean
  stop + `START_NOT_STICKY`), watchdog diagnostics in #11560. JNI guard in
  **#11713**.
- The completion write itself was verified atomic and present on-device.
- Residual memory-**policy** question split to **#11760**.

This change does not reopen #11506. It **locks the persistence contract** so a
future regression that drops a completed onboarding fails CI instead of only
surfacing as a hard-to-repro on-device symptom, and **hardens the client** for
the one durability gap the closeout did not cover: an OS WebView-storage wipe
that drops the client's `eliza:first-run-complete` flag while the app's native
store survives.

## What changed

Server (persistence contract — regression guard):
- `packages/app-core/src/api/first-run-persistence.restart.test.ts` — drives the
  REAL `saveElizaConfig` → `loadElizaConfig` → `hasCompatPersistedFirstRunState`
  path (the exact production functions the `/api/first-run` completion handler
  and `GET /api/first-run/status` use) across a fresh-temp-`ELIZA_STATE_DIR`
  "restart" for local / Eliza Cloud / remote onboarding, many consecutive
  restarts, and a byte-for-byte flag round-trip.

Client (durability hardening):
- `packages/ui/src/state/persistence.ts` — mirror the `eliza:first-run-complete`
  flag into Capacitor Preferences (Android SharedPreferences / iOS UserDefaults),
  matching the existing mobile-runtime-mode dual-write; add
  `hydratePersistedFirstRunCompleteFromNativeStore()` to restore the localStorage
  flag from the durable native store at boot.
- `packages/ui/src/state/useFirstRunState.ts` — seed `completionCommittedRef`
  from `loadPersistedFirstRunComplete()` so a fresh process starts committed
  (previously `useRef(false)`, lost on every restart).
- `packages/ui/src/state/startup-phase-restore.ts` — `await` the native-store
  hydration before reading `hadPrior`, so an already set-up install is not
  re-onboarded on the boot after a WebView-storage wipe.
- Client tests: `first-run-completion-persist.test.tsx` (durable-flag round-trip
  across a simulated fresh read, `useFirstRunState` ref seeding, boot-safe native
  hydration) and a new case in `useStartupCoordinator.recovery.test.ts` (a
  rehydrated committed ref routes a fresh boot **home** even when the server
  status transiently reports incomplete — the exact "does NOT return
  first-run-required" outcome the task requires).

## Verification (local; CI backlogged)

- `bun run --cwd packages/app-core vitest run src/api/first-run-persistence.restart.test.ts` — **7/7 passed**
- `bun run --cwd packages/ui vitest run src/state/first-run-completion-persist.test.tsx src/state/useStartupCoordinator.recovery.test.ts src/state/startup-phase-restore.desktop-rpc.test.ts src/state/startup-phase-poll.test.ts` — **60/60 passed**
- `bun run --cwd packages/ui typecheck` — clean
- `biome check` on all 6 touched files — clean

No UI pixels changed (persistence/coordinator logic only), so `audit:app` is
N/A — the user-visible outcome (boot goes straight home for a completed
install) is asserted by the coordinator test rather than a screenshot.
