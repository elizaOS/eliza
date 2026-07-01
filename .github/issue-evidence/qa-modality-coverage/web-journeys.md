# Web major-journey e2e — onboarding pathways + per-view interaction

Run against the **built app + live-stack** (`bun run --cwd packages/app test:e2e
-- <spec> --project=chromium`), video recordings under `e2e-recordings/app/`.

## Onboarding — all six first-run pathways pass (video-recorded)
`onboarding-to-home.spec.ts` (in-chat onboarding → home → launcher):

| pathway | result |
| --- | --- |
| Local onboarding lands on home; swipe-left opens the launcher | ✅ |
| **Cloud** onboarding connects, binds an agent, lands on home | ✅ |
| Local **cloud-inference** onboarding completes in chat | ✅ |
| **Other provider** completes in chat and hands off to Settings (no model download) | ✅ |
| **Remote connect** adopts a host and replaces onboarding without the old screen | ✅ |
| Tutorial CHOICE "Take the tutorial" completes onboarding and launches the tour | ✅ |

Plus `conversation-management.spec.ts`: a sent message persists across a full
page reload ✅. Each records `video.webm` + a `test-finished` screenshot.

## Per-view interaction — every control on all 33 views (#10719)
`all-views-interaction.spec.ts` ("exercise every control, no crash") drives every
input/button/toggle on all 33 default views: **33 / 33 pass** (was 0/33 before the
test-infra fixes in the accompanying PR — three zero-key stub 501 pollers
answered as zero-state, and a `type="color"` fill handler). Records video per view.

## Full journey walkthrough
`full-walkthrough.spec.ts` drives the complete desktop + mobile journey
(cold-launch → onboarding-runtime → provisioning-ready → tutorial → help →
settings → wallet → chat round-trip → character-edit → new-chat → home-from-chat
→ restore-chat → launcher → dashboard), capturing a step-labeled screenshot +
recording at each stage. (Its strict console gate additionally flags the stub's
`501` responses in the mock lane; the same `installDefaultAppRoutes` interceptors
that greened the per-view suite reduce those.)
