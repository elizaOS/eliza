# Launch Readiness 01: Onboarding And Setup QA

## Second-Pass Status (2026-05-05)

- Superseded: Android local runtime pre-seed is wired through `packages/app/src/main.tsx`, and remote manual onboarding now normalizes invalid URLs with focused launch QA coverage.
- Still open: remote onboarding completes without a live `/api/health` or auth probe, cloud auto-pick can persist the first returned agent without proving a usable API/UI URL, and public onboarding docs remain stale.
- Launch gate: covered by `packages/app-core/test/onboarding/launch-qa-remote-target.test.tsx`, `packages/app-core/test/onboarding/pre-seed-android-local-runtime.test.ts`, and the launchdocs docs gate.

Review date: 2026-05-04
Worker: 01
Scope: onboarding/setup flows, desktop/mobile/cloud support, styling risk, targeted tests.

## Current state

- App startup is coordinated by `StartupCoordinator`. `packages/app-core/src/App.tsx:1118` treats the coordinator as the startup authority and renders `StartupShell` until the phase is `ready`.
- First-run setup is now centered on `RuntimeGate`, not the older multi-step wizard. `packages/app-core/src/components/shell/StartupShell.tsx:252` renders `BootstrapStep` for cloud-provisioned sessions that still need bootstrap, otherwise `RuntimeGate`.
- `RuntimeGate` presents runtime choices by platform: Android probe pending shows no choices, Android with a detected local agent shows only local, iOS/Android otherwise show cloud/remote, and desktop/dev show cloud/local/remote (`packages/app-core/src/components/shell/RuntimeGate.tsx:120`).
- ElizaOS Android is intended to bypass the picker and auto-finish local when the local agent answers `/api/health` (`packages/app-core/src/components/shell/RuntimeGate.tsx:693`). Settings exposes an ElizaOS-only runtime escape hatch that clears persisted runtime choice and reloads with `?runtime=picker` (`packages/app-core/src/components/pages/settings/RuntimeSettingsSection.tsx:2`, `packages/app-core/src/onboarding/reload-into-runtime-picker.ts:2`).
- Cloud onboarding signs in, lists or creates cloud agents, persists the selected active server, and completes onboarding (`packages/app-core/src/components/shell/RuntimeGate.tsx:396`, `packages/app-core/src/components/shell/RuntimeGate.tsx:616`).
- Remote manual onboarding currently persists the raw input URL/token and completes onboarding without first normalizing, probing, or auth-checking the target (`packages/app-core/src/components/shell/RuntimeGate.tsx:517`).
- The legacy wizard model still exists in state helpers as a 3-step flow: `deployment`, `providers`, `features` (`packages/app-core/src/state/types.ts:122`, `packages/app-core/src/onboarding/flow.ts:11`). Some docs still describe a 4-step wizard and files that no longer appear to exist.

## Evidence reviewed with file refs

- App shell and startup: `packages/app-core/src/App.tsx:1118`, `packages/app-core/src/components/shell/StartupShell.tsx:155`, `packages/app-core/src/components/shell/StartupShell.tsx:252`, `packages/app-core/src/state/startup-coordinator.ts:42`, `packages/app-core/src/state/startup-phase-poll.ts:185`.
- Runtime chooser: `packages/app-core/src/components/shell/RuntimeGate.tsx:120`, `packages/app-core/src/components/shell/RuntimeGate.tsx:396`, `packages/app-core/src/components/shell/RuntimeGate.tsx:439`, `packages/app-core/src/components/shell/RuntimeGate.tsx:517`, `packages/app-core/src/components/shell/RuntimeGate.tsx:616`, `packages/app-core/src/components/shell/RuntimeGate.tsx:693`, `packages/app-core/src/components/shell/RuntimeGate.tsx:723`.
- Android local runtime helpers/tests: `packages/app-core/src/onboarding/pre-seed-local-runtime.ts:6`, `packages/app-core/src/onboarding/pre-seed-local-runtime.ts:85`, `packages/app-core/test/onboarding/pre-seed-android-local-runtime.test.ts:4`, `packages/app-core/test/onboarding/should-show-local-option.test.ts:86`.
- App entry and branding: `packages/app/src/main.tsx:166`, `packages/app/src/main.tsx:177`, `packages/app/src/main.tsx:620`, `packages/app-core/src/config/cloud-only.ts:8`, `packages/app-core/src/state/useOnboardingState.ts:196`, `packages/app-core/src/state/AppContext.tsx:662`.
- Settings/runtime switching: `packages/app-core/src/components/pages/SettingsView.tsx:688`, `packages/app-core/src/components/pages/settings/RuntimeSettingsSection.tsx:2`, `packages/app-core/src/onboarding/reload-into-runtime-picker.ts:23`.
- Cloud provisioning and handoff: `packages/app-core/src/components/onboarding/BootstrapStep.tsx:2`, `packages/app-core/src/components/onboarding/BootstrapStep.tsx:161`, `packages/app-core/src/api/server-onboarding-compat.ts:356`, `cloud/apps/api/v1/eliza/agents/[agentId]/pairing-token/route.ts:117`, `cloud/apps/api/v1/eliza/agents/[agentId]/provision/route.ts:73`.
- Homepage/cloud onboarding entry: `packages/homepage/src/pages/get-started.tsx:903`, `cloud/packages/ui/src/components/containers/eliza-connect-button.tsx`, `packages/homepage/src/lib/api/client.ts`.
- Styling surfaces: `packages/app-core/src/components/shell/RuntimeGate.tsx:727`, `packages/app-core/src/components/shell/RuntimeGate.tsx:793`, `packages/app-core/src/components/shell/RuntimeGate.tsx:1116`, `packages/app-core/src/components/shell/RuntimeGate.tsx:1233`, `packages/ui/src/components/ui/button.tsx:24`, `packages/ui/src/styles/theme.css:17`, `packages/app-core/src/styles/onboarding-game.css`.
- Docs: `docs/rest/onboarding.md:13`, `docs/guides/onboarding-ui-flow.md:4`, `docs/guides/onboarding-ui-flow.md:24`, `docs/installation.mdx:13`, `docs/apps/mobile.md:14`, `docs/apps/mobile.md:380`, `docs/apps/desktop.md:91`, `docs/apps/dashboard/settings.md:7`.

## What I could validate

- Ran a bounded onboarding/startup test slice:

```bash
bunx vitest run --config packages/app-core/vitest.config.ts \
  packages/app-core/src/components/shell/RuntimeGate.test.tsx \
  packages/app-core/src/components/shell/StartupShell.test.tsx \
  packages/app-core/src/state/startup-phase-poll.test.ts \
  packages/app-core/test/onboarding/mobile-runtime-mode.test.ts \
  packages/app-core/test/onboarding/pre-seed-android-local-runtime.test.ts \
  packages/app-core/test/onboarding/should-show-local-option.test.ts \
  packages/app-core/test/onboarding/probe-local-agent.test.ts \
  packages/app-core/test/onboarding-config.test.ts
```

Result: 8 test files passed, 43 tests passed.

- Confirmed the RuntimeGate platform choice matrix statically.
- Confirmed the cloud-provisioned bootstrap gate fails closed when a cloud-provisioned session is required but `sessionStorage["eliza_session"]` is missing.
- Confirmed the pre-seed helper and tests exist, and `rg -n "preSeedAndroidLocalRuntimeIfFresh" .` found definitions/tests/comments but no app-entry invocation.
- Confirmed docs drift: current code has a 3-step legacy wizard plus RuntimeGate, while `docs/guides/onboarding-ui-flow.md` still describes a 4-step wizard with `identity` and references stale files.
- Confirmed the root package requires Node `24.15.0`, while installation/mobile docs still tell users Node 22+.

## What I could not validate / confidence gaps

- No live desktop package was launched; Electrobun local-runtime spawn, external-runtime mode, tray reset, and packaged first-run behavior need manual or e2e coverage.
- No iOS or Android device/emulator was run. Loopback HTTP from Capacitor, foreground service timing, safe areas, keyboard behavior, and mobile storage bridge behavior are unvalidated here.
- No ElizaOS Android image was run. The auto-local boot, local-agent cold start, runtime picker override, and reboot persistence need device QA.
- No real Eliza Cloud credentials or dashboard agent inventory were available. I could only inspect frontend/API code, not validate OAuth, pairing-token redirect, provisioning jobs, stopped-agent resume, or expired bootstrap tokens.
- No browser screenshot pass was run for the RuntimeGate, homepage get-started flow, or cloud handoff pages, so color contrast, text overflow, and mobile layout risks are static-review findings.
- No full `bun run test`, `bun run test:server`, desktop e2e, cloud tests, or live-agent e2e were run due to scope/time bounds.

## Bugs/risks prioritized P0-P3

### P0

- No confirmed P0 from this static review plus targeted tests.

### P1

- ElizaOS Android pre-seed boot contract appears unwired. `preSeedAndroidLocalRuntimeIfFresh()` is documented and tested as something the app entry calls before React mounts (`packages/app-core/src/onboarding/pre-seed-local-runtime.ts:6`, `packages/app-core/test/onboarding/pre-seed-android-local-runtime.test.ts:4`), and RuntimeGate comments depend on it (`packages/app-core/src/components/shell/RuntimeGate.tsx:481`). `packages/app/src/main.tsx` does not import or call it. Impact: fresh ElizaOS boot may depend only on RuntimeGate's later probe/finish path, while startup restore, persisted active-server state, and test comments assume pre-render seeding. Confidence: high.
- Manual remote connect can mark onboarding complete with an invalid or unauthenticated target. `finishAsRemote` trims the URL, persists it, sets the token, and completes onboarding (`packages/app-core/src/components/shell/RuntimeGate.tsx:517`). The older callback path has URL normalization/probe logic (`packages/app-core/src/state/useOnboardingCallbacks.ts:107`, `packages/app-core/src/state/useOnboardingCallbacks.ts:1031`) but RuntimeGate does not use it. Impact: users can save `my-mac.local:31337`, an unreachable URL, or a rejected token and land in a broken app state instead of getting setup feedback.
- Cloud auto-pick can complete onboarding on the first returned agent without proving it is running or has a usable UI/API URL. The first agent is selected blindly (`packages/app-core/src/components/shell/RuntimeGate.tsx:641`), and `finishAsCloud` completes even when `apiBase` is absent (`packages/app-core/src/components/shell/RuntimeGate.tsx:400`). The provision route has the running/URL checks (`cloud/apps/api/v1/eliza/agents/[agentId]/provision/route.ts:73`), but this path is only used for auto-created agents or manual list actions. Impact: existing stopped/suspended/broken cloud agents can become the persisted active server and complete first-run setup into a bad target.
- Cloud onboarding docs are materially stale for a security-sensitive path. `docs/rest/onboarding.md:15` says cloud-provisioned containers bypass onboarding when `ELIZA_CLOUD_PROVISIONED=1` and `ELIZA_API_TOKEN` are set. Current code says cloud-provisioning detection is metadata-only and old onboarding skips were removed (`packages/app-core/src/api/server-onboarding-compat.ts:356`), while the frontend now uses bootstrap session gating. Impact: support, launch QA, and security review can validate the wrong flow.

### P2

- Native branding says all mobile is cloud-only even though Android/ElizaOS local runtime paths exist. `shouldUseCloudOnlyBranding` returns true for any native platform with a comment saying no local runtime is available (`packages/app-core/src/config/cloud-only.ts:8`), while RuntimeGate has Android local probing and ElizaOS local auto-start. Impact is unclear because RuntimeGate has its own choice logic, but initial onboarding state and branding can drift from runtime capability.
- RuntimeGate tests are too narrow for the launch-critical flow. Current `RuntimeGate.test.tsx` focuses on the local embeddings checkbox (`packages/app-core/src/components/shell/RuntimeGate.test.tsx:3`). The pre-seed helper is tested in isolation, but there is no test proving `main.tsx` calls it, no test for the runtime choice matrix, no cloud stopped-agent path, and no invalid remote URL path.
- Homepage get-started has a narrow-mobile overflow risk. The first-choice heading is `whitespace-nowrap` inside a `max-w-[400px]` container (`packages/homepage/src/pages/get-started.tsx:903`). At 320px wide, `Anywhere you want her to be.` can overflow or force awkward scaling.
- RuntimeGate and onboarding visuals use many hard-coded black/yellow values, clip paths, uppercase tracking, and custom shadows (`packages/app-core/src/components/shell/RuntimeGate.tsx:727`, `packages/app-core/src/components/shell/RuntimeGate.tsx:793`, `packages/app-core/src/components/shell/RuntimeGate.tsx:1233`). This may be intentional brand styling, but it bypasses most shared button/theme tokens and needs screenshot/contrast QA across light/dark and mobile.
- Bootstrap stores the exchanged session id in `sessionStorage` as a temporary bridge (`packages/app-core/src/components/onboarding/BootstrapStep.tsx:161`). The code comments already mark HttpOnly cookie migration as P1. Impact: private browsing/session restore/reload behavior and XSS blast radius need explicit launch signoff.

### P3

- Installation prerequisites are inconsistent. Root `package.json:6` requires Node `24.15.0`, `packages/app-core/package.json:24` requires `>=24.0.0`, but `docs/installation.mdx:13` and `docs/apps/mobile.md:39` still say Node 22+.
- `docs/guides/onboarding-ui-flow.md` references stale files such as `onboarding/types.ts`, `onboarding/connection-flow.ts`, and `components/onboarding/ConnectionStep.tsx` (`docs/guides/onboarding-ui-flow.md:86`). Static file search did not find those paths under `packages/app-core/src`.
- `packages/app-core/src/styles/onboarding-game.css` still contains old/high-specificity onboarding styles while RuntimeGate uses separate inline Tailwind classes. This increases styling drift and makes it harder to know which onboarding surface owns launch visuals.
- Settings docs describe broad dashboard settings persistence and native sync (`docs/apps/dashboard/settings.md:7`), but the runtime switcher is only rendered for ElizaOS. This is not necessarily wrong, but the docs do not distinguish general settings from the ElizaOS runtime escape hatch.

## Low-risk fixes Codex can do

- Wire `preSeedAndroidLocalRuntimeIfFresh()` into `packages/app/src/main.tsx` before React mounts, gated to the intended ElizaOS Android path, and add an integration-style test or static guard so the boot contract cannot drift again.
- Move or export the existing remote URL normalization/probe logic and reuse it from `RuntimeGate.finishAsRemote`; do not call `completeOnboarding()` until `/api/health` or auth/onboarding status has succeeded.
- Change cloud auto-pick to require a running agent with a usable `web_ui_url`/`webUiUrl`/`bridge_url`, or call `provisionAndConnect(primary.agent_id)` before `finishAsCloud`.
- Add focused RuntimeGate tests for platform choices, ElizaOS auto-local vs `?runtime=picker`, invalid remote URL, cloud no-agent auto-create, existing stopped cloud agent, and missing cloud URL.
- Update stale docs: `docs/rest/onboarding.md`, `docs/guides/onboarding-ui-flow.md`, `docs/installation.mdx`, and mobile setup prerequisites.
- Remove `whitespace-nowrap` from the homepage get-started heading or add responsive wrapping that preserves the intended composition.
- Align `shouldUseCloudOnlyBranding` comments/logic with Android local and ElizaOS capability, or document why branding remains cloud-only while RuntimeGate can still choose local.
- Replace the most critical RuntimeGate hard-coded color/button classes with shared tokens where possible, or add a documented visual QA snapshot baseline if the black/yellow treatment is the launch brand.

## Human/device/cloud QA needed

- ElizaOS Android physical device: fresh install, local agent cold start, first boot with no persisted storage, reboot persistence, settings runtime switch, `?runtime=picker`, local service crash/recovery.
- Vanilla Android APK: no local agent, local agent reachable on loopback, remote HTTP/HTTPS target, private-network target, background/foreground transitions, storage bridge restoration before onboarding state reads.
- iOS device: cloud/remote only, keyboard and safe area behavior on RuntimeGate, remote private-network URL behavior, OAuth popup/browser return, session persistence.
- Desktop packaged app: fresh local setup, external API base, disabled local runtime mode, local child process port fallback, reset/re-onboarding, tray menu reset path.
- Web/cloud: cloud login, no agents auto-create, existing running agent, existing stopped/suspended agent, failed provisioning job, pairing-token redirect, expired bootstrap token, missing `sessionStorage`, popup blocked login.
- Visual QA: RuntimeGate chooser/cloud/remote screens at 320, 375, 768, 1024, and desktop widths in light/dark; homepage `/get-started`; cloud connected and error states.
- Accessibility QA: keyboard-only runtime selection, focus rings on custom clipped buttons/cards, screen reader labels for choice cards, contrast for yellow-on-black and muted white text.

## Recommended test matrix

| Surface | Scenario | Expected result |
|---|---|---|
| Desktop packaged | Fresh install, no persisted active server | StartupShell reaches RuntimeGate; Cloud/Local/Remote choices render; Local starts embedded runtime and lands in chat/provider setup safely. |
| Desktop external | `ELIZA_DESKTOP_API_BASE` plus optional token | Renderer targets external API, does not spawn local runtime, pairing/auth failures block with actionable UI. |
| Web hosted | No injected API base | Cloud/Remote path only; cloud login works; remote invalid URL does not complete onboarding. |
| Cloud dashboard | No existing agents | RuntimeGate creates `My Agent`, provisions it, waits for running URL, persists active server, lands in chat. |
| Cloud dashboard | Existing stopped/suspended/failed first agent | App resumes/provisions or shows recoverable list; it must not complete onboarding with a missing/stale URL. |
| Cloud-provisioned container | `#bootstrap=<token>` present | Token is scrubbed from URL, exchanged, session marker exists, coordinator reaches ready. |
| Cloud-provisioned container | Missing/expired bootstrap token | Fails closed in `BootstrapStep`; does not silently enter chat or RuntimeGate as authenticated. |
| Vanilla Android | Local probe pending | Shows "Checking for on-device agent..." only while pending; then expected choices render based on probe result. |
| Vanilla Android | Probe success | If local is intended for vanilla Android, local choice works; if not intended, product decision is documented and tested. |
| ElizaOS Android | Fresh install | Pre-seed runs before React, local active server is persisted, picker is bypassed, local agent readiness lands in chat. |
| ElizaOS Android | Settings -> Runtime -> switch | Clears local persisted runtime, reloads with `?runtime=picker`, lets user choose cloud/remote/local without being auto-bounced back. |
| iOS | Fresh install | Cloud/Remote choices only; remote validation works; no local copy or cloud-only branding contradiction appears. |
| Mobile layout | 320px/375px portrait | No heading/button/card overflow on RuntimeGate or homepage get-started; focus/keyboard states remain usable. |
| Accessibility | Keyboard and screen reader | Runtime choices, Cloud login, Remote connect, Bootstrap token form, and back buttons are reachable and named. |

## Changed paths

- `launchdocs/01-onboarding-setup-qa.md`
