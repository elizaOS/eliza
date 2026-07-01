# Android on-device QA coverage (emulator + physical device)

Run on this Linux host against a live Android environment: **1 physical device
(`27051JEGR10034`) + 2 emulators**, the shipping app `ai.elizaos.app` installed on
all three, driven via CDP-over-adb (`packages/app/playwright.android.config.ts`,
the harness foregrounds the app and connects Playwright to the on-device WebView).

## Route coverage — every app view renders render-safe on the real WebView
`route-coverage.android.spec.ts` navigates all `DIRECT_ROUTE_CASES` +
`MANAGER_VISIBLE_VIEW_TILE_CASES` against the **real on-device agent** and asserts
each mounts its React root without tripping the error boundary:

| target | result |
| --- | --- |
| Android emulator (`emulator-5554`) | **47 / 47 passed** (36.6s) |
| Physical device (`27051JEGR10034`) | **47 / 47 passed** (46.1s) |

Views covered: chat, home/launcher, apps, views, settings, character, wallet,
browser, automations, background, calendar, contacts, documents, feed, finances,
focus, goals, health, inbox, messages, phone, relationships, screenshare,
social-alpha, task-coordinator, todos, trajectory-logger, orchestrator (+tui),
facewear/smartglasses (tui), model-tester, vector-browser, …

> The physical device's first pass failed once on a transient agent-warmup timing
> (`on-device agent healthy` only after ~30s uptime); it passed cleanly once warm.

## Console-error sweep — zero console errors on every shipping view (on-device)
`console-sweep.android.spec.ts` on `emulator-5554`: **47 views walked — CLEAN, no
console errors / exceptions on any shipping view** (1.3m). Confirms the prior
`#10196` permission-gate fixes hold (contacts/messages/phone no longer log
Capacitor permission rejections on-device).

## Host-backend CI-lane specs (env-blocked here, not bugs)
`touch-gesture` (real finger-swipe → launcher) and `view-runtime-soak` are
designed for the **host-backend lane**: they clear app data + re-onboard via a
remote deep-link to a real agent on `:31337` (`adb reverse`). Run without that
lane the app sits on the onboarding screen ("How should Eliza run?"), so the
`home-launcher-surface` swipe target / view-churn telemetry never materialize
(env, not a UI defect — the recorded video shows the onboarding screen). Real-touch
gesture behaviour is covered on web by the merged `#10722` real-touch CDP helper +
de-larped conversation-swipe e2e.
