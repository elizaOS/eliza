# #13371 / #13405 — iOS cold-relaunch lands on Character Select (before) vs home (after)

On-simulator proof for the #13396 fix: after first-run completes, a cold
relaunch must land on the default home/chat tab, not replay Character Select.

## Environment

- Simulator: iPhone 16 Pro, iOS 18.1, UDID `F165C3A3-5069-4174-A40C-89F0BCC4B9FB`
- Host agent: `ELIZA_API_PORT=31338 ELIZA_PAIRING_DISABLED=1 node packages/app-core/scripts/run-node-tsx.mjs packages/app-core/scripts/serve-real-local-agent.ts` (same recipe as `.github/workflows/mobile-build-smoke.yml`)
- Build command (both legs): `ELIZA_IOS_FULL_BUN_ENGINE=1 ELIZA_IOS_BUILD_DESTINATION='generic/platform=iOS Simulator' ELIZA_IOS_BUILD_SDK=iphonesimulator node packages/app-core/scripts/run-mobile-build.mjs ios-local`
- Onboarding driver: `node packages/app/scripts/ios-onboarding-smoke.mjs --api-base http://127.0.0.1:31338 --app-path <freshly built App.app>` — fresh install, cleared first-run state, in-app verifier completes first-run remote connect and proves home landed.
- Relaunch leg: `xcrun simctl terminate` → `xcrun simctl launch` → 18 s settle → `simctl io screenshot`.

## BEFORE — develop tip `a068344d0c1` (no fix); renderer stamp `builtAt 2026-07-04T19:50:47.835Z, commit a068344d0c1bc306ca775a6bc28b42cf2603b9ac`

- `before-fresh-onboarding.png` — first boot of the fresh install.
- `before-home-landing.png` — post-onboarding home ("Connected to remote backend", composer visible). Smoke PASS (`before-result.json`: `homeVisible/composerVisible/onboardingHidden` all true).
- `before-onboarding-to-home.mp4` — full first-run recording.
- `before-relaunch-landing.png` — **BUG**: terminate + cold relaunch lands on the character view (About Me / Style Rules, back arrow), not home.

## AFTER — `47f648b09a4` = develop tip + cherry-pick of #13396 (`536c84b74f8`); renderer stamp `builtAt 2026-07-04T19:53:32.380Z, commit 47f648b09a40660c7fab9cfad87b29b8a5f05320`

- `after-fresh-onboarding.png`, `after-home-landing.png`, `after-onboarding-to-home.mp4`, `after-result.json` — first-run leg still passes identically (character-select handoff still fires once during onboarding).
- `after-relaunch-landing.png` — **FIXED**: terminate + cold relaunch lands on home (clock/greeting, "Ask me anything to get started", Ask Eliza composer). No Character Select.

The transient "Reconnecting…" banner in both relaunch screenshots is the app
re-establishing its WebSocket to the host agent after the cold start; the
landing-tab decision under test is independent of it.

## Unit evidence (same tree as the AFTER build)

- `bun run --cwd packages/ui test src/state/startup-phase-hydrate.character-select.test.ts src/state/first-run-completion-persist.test.tsx` — 2 files, 9 tests passed.
- `bun run --cwd packages/ui test src/state/startup-phase-hydrate.switch.test.ts src/state/startup-phase-hydrate.navigate-frame.test.ts src/state/startup-phase-hydrate.view-interact.test.ts src/state/startup-phase-hydrate.voice-control.test.ts` — 4 files, 29 tests passed.
