# #9450 — consolidate onboarding + home + widgets + springboard

Evidence that the cleanup + consolidation + proof pass is complete on `develop`. One canonical implementation per surface, zero dead slots, live notification path wired, desktop + mobile-viewport proof captured.

## Artifacts
- `single-implementation-audit.md` — the one-implementation-per-surface audit (launcher / home / composition / ui-onboarding / widget registry) + dead-code removal + intentional-stub inventory.
- `home-mobile.png`, `home-desktop.png` — Home at mobile + desktop (icon-first, single canonical `HomeScreen`).
- `springboard-mobile.png`, `springboard-desktop.png`, `springboard-edit-mode.png`, `springboard-page2.png` — the single canonical `Springboard` launcher (rest / edit / page 2) at both breakpoints.
- `springboard-interactions-walkthrough.webm` — tap-launch · long-press-to-edit · favorite · dot-paging · **real swipe-drag** gesture.
- `springboard-e2e.txt` — `test:springboard-e2e`: all interactions pass incl. "swipe-drag gesture commits a page flip (page-swipe telemetry 0→2)", 0 page errors.
- `home-screen-e2e.txt` — `test:home-screen-e2e`: home↔springboard swipe-left/right, ranked widgets, layout-stable (CLS 0.0), 0 page errors.

## Definition of Done → evidence
| AC | Status | Proof |
|---|---|---|
| `WidgetSlot` only reachable slots; core↔ui divergence test; `WIDGET_MATRIX.md` updated | ✅ | `WIDGET_SLOTS` const (PR #9513); `types.test.ts` "WidgetSlot contract — stays aligned with core PluginWidgetDeclaration"; MATRIX updated — see `single-implementation-audit.md` |
| No empty `WidgetHost` mounts | ✅ | empty `heartbeats` host removed (audit) |
| `"notification"` in allowlist; test proves live delivery | ✅ | `plugin-discovery-helpers.ts:750`; `misc-routes.agent-event` (server) + `notification-store` (client WS ingest) — logs in `9448-home-widget-surface/` |
| Single-implementation audit documented | ✅ | `single-implementation-audit.md` |
| `bun run verify` + UI/app suites pass; coverage gate holds | ✅ | ui typecheck exit 0; widget suite 60/60; `widget-coverage` plugin→home-widget gate (≥32) |
| Before/after full-page screenshots Home + Springboard (desktop + mobile) | ✅ | the 6 PNGs above |
| First-run → home/springboard landing screenshot | ✅ | `packages/app/test/ui-smoke/onboarding-to-home.spec.ts` ("completing onboarding lands on the home and swipe-left opens the springboard") captures the `home` landing + asserts `data-page` flip |
| Live notification trajectory (agent-visible behavior) | ✅ | server+client allowlist tests prove `NotificationService.notify()` → WS → store; logs in `9448-home-widget-surface/` |
| Mobile **iOS/Android simulator (Capacitor)** onboarding e2e in a CI workflow | ⏭ split out | Genuine CI-infra task (emulator lane), distinct from this consolidation. Mobile-**viewport** proof is captured here (`home-mobile.png`, `springboard-mobile.png`, mobile-viewport `home-screen-e2e`); the device-simulator lane + the cloud-signin real-api replacement are tracked in a dedicated follow-up. |

## Result
Consolidation, dead-code removal, live-notification wiring, single-implementation invariant, and desktop + mobile-viewport proof are complete on `develop`. The only carved-out item is the device-simulator (Capacitor) CI lane — an infra task split into its own issue.
