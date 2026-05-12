# Launch Readiness Review Summary

Generated from the launch-readiness QA reports in `launchdocs/`.

## Second-Pass Status (2026-05-05)

- Subagents re-reviewed every launchdoc and found multiple stale historical findings now superseded by code/tests; each report now has a current second-pass status block.
- Launchdocs no longer contain historical task markers, and `node scripts/launch-qa/check-docs.mjs --scope=launchdocs --json` passes across all 20 markdown files.
- Root `test:launch-qa`, `test:launch-qa:docs`, `test:launch-qa:release:dry`, `test:ui:playwright`, and `.github/workflows/launch-qa.yml` now make launchdocs/static launch validation runnable and CI-addressable.
- Remaining launch blockers are product/runtime gaps, not markdown gaps: remote session lifecycle, live wallet/cloud/device QA, Computer Use approval posture, docs v2 cleanup, training/model publication, and local-model fallback behavior.

## Reports Completed

- `01-onboarding-setup-qa.md`
- `02-coding-subscriptions.md`
- `03-docs-v2.md`
- `05-settings-qa.md`
- `06-ios-qa.md`
- `07-android-qa.md`
<<<<<<< HEAD
- `08-cloud-eliza-qa.md`
=======
- `08-cloud-eliza-ai-qa.md`
>>>>>>> origin/shaw/fine-tune-apollo-pipeline
- `09-desktop-qa.md`
- `10-remote-interfaces.md`
- `11-browser-wallet-qa.md`
- `12-computer-use-qa.md`
- `14-lifeops-qa.md`
- `15-utility-apps-qa.md`
- `16-all-app-pages-qa.md`
- `17-prompt-optimization.md`
- `18-finetune-suite.md`
- `19-local-models.md`
- `20-automation-minimize-human-qa.md`

## Fixes Applied In This Pass

- iOS mobile build now includes the official Capacitor App and Preferences pods in the generated Podfile and the shipped iOS template.
- Android fresh app startup now pre-seeds the local runtime on elizaOS when the user has not forced the runtime picker.
- Streaming permission filters now show shared camera/microphone permissions on both web and mobile, while keeping screen capture web-only.
- Custom RPC settings no longer save cloud RPC selections when the user switches to custom mode.
- Cloud API key listing no longer returns/copies the full existing key after creation.
- Account-pool runtime routing now reads persisted account strategy and service-routing config, so round-robin/least-used choices can flow into provider selection.
- Launchpad dry-run now stops before any transaction-triggering click instead of waiting for the later `confirmTx` marker. The wallet provider option click is now executed when profiles define one.
- Root and app package scripts now expose `build:android:system`.
- Computer Use agent status now recognizes `@elizaos/plugin-computeruse` as the active computer-use capability.
- LifeOps Google OAuth callback refresh now emits both the current `elizaos:` channel/storage keys and the legacy `eliza:` keys.
- LifeOps follow-up tracker now creates/updates its recurring task row on startup and has a regression test.

## Validation Run

- `bunx @biomejs/biome check ...` passed for the changed code files.
- `bun test packages/app-core/scripts/run-mobile-build.test.ts` passed: 16 tests.
- `bunx vitest run --config packages/app-core/vitest.config.ts packages/app-core/src/components/permissions/StreamingPermissions.test.ts packages/app-core/src/components/pages/ConfigPageView.test.tsx packages/app-core/src/services/__tests__/account-pool.test.ts` passed: 33 tests.
- `bun run --cwd packages/app typecheck` passed.
- `bun run --cwd packages/app-core typecheck` passed.
- `bun run --cwd cloud typecheck` passed: 41/41 package splits.
- `bunx vitest run --config packages/agent/vitest.config.ts packages/agent/src/services/launchpads/launchpad-engine.test.ts packages/agent/src/actions/launchpad-launch.test.ts` passed: 10 tests.
- `bun run --cwd packages/agent typecheck` passed.
- `bunx vitest run --config plugins/app-lifeops/vitest.config.ts plugins/app-lifeops/test/followup-tracker.test.ts plugins/app-lifeops/src/hooks/useGoogleLifeOpsConnector.test.ts` passed: 25 tests.

Note: a direct `bun test` run against the launchpad tests failed because those tests depend on Vitest's `vi.mocked` helper. The same files passed under the repository's intended Vitest config.

## Highest Launch Risks

- Browser/wallet live purchase flows still need human QA with test wallets and controlled funds. Dry-run safety is improved, but pump.fun, flap.sh, four.meme, wallet login, signing, and real site selector drift cannot be validated safely from unit tests.
- iOS and Android still need physical-device QA for cloud models, local models, remote-to-cloud agent, remote-to-desktop agent, permissions, backgrounding, app-store/play-store packaging, and hardware-specific local model performance.
- Cloud and eliza.ai need live credential QA for login, create agent, use agent, migrate to desktop/phone, and pairing error states.
- Remote interfaces need second-device testing across multiple simultaneous interfaces. Reports found incomplete cloud pairing/data-plane paths and companion placeholders.
- Computer Use still needs a launch-safety decision: granting OS permissions can auto-enable the plugin and the plugin default is full-control. The status detection issue is fixed, but approval-mode UX/defaults need product/security sign-off and more code.
- LifeOps needs real connected-account QA for Google, Gmail, Calendar, X, iMessage, Telegram, Signal, Discord, WhatsApp, Twilio, Ntfy, reminders, follow-ups, browser bridge, and remote desktop. Follow-up task seeding and OAuth refresh fallback were fixed, but live side effects are unvalidated.
- Docs v2 are not launch-ready. Reports found stale CLI/install identity, Node version drift, app path drift, broken links, and missing/advertised command mismatches.
- Fine-tuning and local-model launch claims need real model/data work: more trajectories, data cleaning, eval gates, training runs, Hugging Face publishing, hardware benchmarking, and local-only UX validation.

## Codex-Ready Follow-Up Work

- Finish Docs v2 cleanup: update install/runtime requirements, remove stale app paths, fix broken links, and align CLI/deploy docs with actual commands.
- Add remote pairing end-to-end coverage: pending-to-consumed transition, data-plane session IDs, cloud ingress, and companion app chat/pairing screens.
- Add a Computer Use approval-mode settings control and make the default posture approval-first rather than full-control.
- Unify the two Computer Use toggles so UI state and runtime plugin state cannot diverge.
- Harden onboarding remote target validation and cloud agent auto-pick behavior.
- Add route/client parity tests for LifeOps connectors and cloud pairing.
- Add local model UX tests for local-only mode plus cloud API/RPC combinations.
- Expand prompt/trajectory evals and add efficiency budgets for native tool-call payloads and compacted prompt surfaces.

## Human Work Plan

- Device matrix: iPhone/iPad, Android phone/tablet, macOS desktop, cloud web, and at least one second remote device.
- Credential matrix: fresh account, existing account, cloud-managed agent, local desktop agent, multiple Claude/Codex/Z.AI subscriptions, local-only model mode, and cloud API/RPC mixed mode.
- Wallet matrix: empty wallet, funded test wallet, connect/disconnect, wrong chain, reject signature, approve signature, dry-run, real testnet transaction, and blocked/failed transaction.
- LifeOps matrix: connect/disconnect each provider, send/read harmless test data, revoke tokens, verify stale-token reauth, validate user-vs-agent side separation.
- Model matrix: collect representative trajectories, clean/redact data, run offline evals, run fine-tune jobs, publish candidate models/datasets, benchmark on target local hardware, and compare fallback routing.
- Release matrix: packaged desktop, TestFlight/dev iOS, Android debug/release/AOSP system build, cloud production, and migration between all surfaces.

## Not Validated In This Pass

- Real OAuth/login/payment/wallet side effects.
- Physical iOS or Android builds installed on devices.
- Packaged desktop app permissions and macOS TCC prompts.
- Live cloud agent creation or eliza.ai authenticated flows.
- Live model downloads, training jobs, Hugging Face publishing, or GPU/local hardware benchmarks.
- Full button-by-button browser QA across every page on web, mobile, and desktop.
