# Second-Pass Review: Automating Human QA

## Second-Pass Status (2026-05-05)

- Superseded: several proposed automations now exist, including `scripts/launch-qa/run.mjs`, mobile/model-data gates, cloud API-key redaction wiring, fake-wallet tests, remote pairing route tests, LifeOps fake connector tests, and the all-pages Playwright smoke.
- Still open: launch QA was not previously wired into package scripts or CI, all-pages smoke does not yet implement screenshot/text-overflow heuristics, and broad docs checking still fails outside launchdocs.
- Launch gate: root `test:launch-qa`, `test:launch-qa:docs`, and `.github/workflows/launch-qa.yml` now make launchdocs and static launch gates runnable from one command.

## Code Review Findings

No new blocking defects found in the previous-pass changes after re-reading the diffs and rerunning targeted checks.

One coverage gap was found and fixed in this pass: Computer Use package-name detection in `GET /api/agent/self-status` now has a regression test at `packages/agent/src/api/agent-status-routes.test.ts`.

## Additional Validation In This Pass

- `bunx vitest run --config packages/agent/vitest.config.ts packages/agent/src/api/agent-status-routes.test.ts packages/agent/src/services/launchpads/launchpad-engine.test.ts packages/agent/src/actions/launchpad-launch.test.ts` passed: 3 files, 11 tests.
- `bun run --cwd packages/agent typecheck` passed.
- `bunx @biomejs/biome check packages/agent/src/api/agent-status-routes.test.ts packages/agent/src/api/agent-status-routes.ts` passed.

## Human Work That Can Be Fully Automated

These should move out of manual launch QA and into CI or a one-command launch gate.

- Docs v2: run markdown link checking, stale command detection, package path validation, and docs code-block command smoke tests. This can catch broken links, missing commands like `deploy`, wrong Node/Bun versions, stale paths, and dead package references.
- Settings click coverage: use component tests and Playwright with mocked APIs to press every settings button, modal tab, toggle, picker, and save action. Only OS-native prompts, live checkout, and real account side effects need manual follow-up.
- All app pages: use the existing Playwright UI-smoke harness to crawl every visible route/tile at desktop and mobile viewports, click every visible safe button, assert no console errors, no uncaught exceptions, no text overflow via screenshot heuristics, and no dead routes.
- Onboarding: automate cloud/local/remote picker state, invalid remote target validation, fresh Android elizaOS local pre-seed, responsive layout snapshots, and cloud-agent list selection with mocked backends.
- Subscription routing: add deterministic AccountPool tests for multiple Claude, Codex, and Z.AI accounts; round-robin persistence; least-used/quota-aware behavior; service-routing overrides; disabled/exhausted accounts; and hot reload.
- Browser/wallet safety: use mock launchpad pages plus a fake injected wallet provider to verify connect, provider selection, chain mismatch, reject signature, approve signature, dry-run stop-before-tx, and no transaction-triggering click in dry-run.
- Computer Use API/UI safety: automate approval-mode route behavior, approval overlay queue/approve/reject, plugin status reporting, role gating, and the two-toggle drift case with mocked desktop permissions.
- LifeOps connector contracts: add fake-adapter tests for Google/Gmail/Calendar, X, Telegram, Signal, Discord, WhatsApp, iMessage, Twilio, Ntfy, reminders, follow-ups, and Browser Bridge route availability. Use local HTTP stubs for OAuth callbacks and Ntfy.
- Remote control-plane: simulate two browser contexts/devices against the auth pairing routes, pending/consumed pairing lifecycle, wrong-code handling, session promotion, revocation, and multi-interface fanout.
- Cloud API and eliza.ai: automate non-billing create-agent/login/migration flows with test auth, mocked or sandbox billing, API route e2e, and Playwright dashboard smoke. Existing cloud e2e/playwright structure is already present.
- iOS/Android build integrity: run `build:ios`, `build:android`, `build:android:system`, manifest/Podfile/Info.plist validation, bundle asset checks, generated Capacitor template diffs, and Android AOSP validators in CI.
- Local models: automate catalog schema validation, routing-policy tests, local-only mode with cloud API/RPC combinations, model assignment persistence, download error handling, and benchmark harness dry-runs without downloading full models.
- Prompt/trajectory optimization: add golden trajectory tests, TOON/caveman compression budgets, schema validators, token/byte budgets, PII redaction checks, and action-parameter diff tests.
- Fine-tune suite: automate dataset export schema checks, trajectory sufficiency thresholds, train/eval dry-run jobs on tiny fixtures, redaction scans, eval report generation, and Hugging Face metadata validation without publishing.

## Human Work That Can Be Partially Automated

These still need a human for final judgment or real credentials, but automation can do most setup, evidence capture, and pass/fail triage.

- Physical mobile QA: CI can build artifacts, run emulator/simulator smoke, collect screenshots/logs, and validate permissions metadata. Humans only need physical-device checks for backgrounding, thermal/performance, real permission UX, TestFlight/Play install, and hardware-specific local model performance.
- Live wallet flows: automation can run fake-wallet and testnet dry-runs, capture selector drift, and assert no accidental signing. Humans should approve only controlled testnet or tiny-mainnet transactions with dedicated funded wallets.
- OAuth/account connectors: local OAuth stubs and sandbox accounts can test most flows. Humans still need periodic validation with real Google, Telegram, Signal, Discord, WhatsApp, iMessage, and X accounts because providers change UX and anti-abuse gates.
- Cloud production: automated smoke can verify public pages, authenticated test accounts, agent creation, and deep links. Humans still need billing, credits, compliance copy, and launch UX judgment.
- Packaged desktop Computer Use: automation can run mocked approval and packaged Playwright smoke. Humans still need macOS TCC prompts, System Settings behavior, and accessibility/screen-recording grant/revoke checks.
- Remote multi-device: two Playwright contexts can simulate remote browsers; humans still need LAN/firewall/mobile network checks and real second-device ergonomics.
- Model quality: evals can score regressions and budgets. Humans still need label review for taste, tool-call usefulness, safety, and whether outputs feel like the product.

## Work That Should Stay Manual

- Product/security decisions: Computer Use default approval posture, local-only-with-cloud-RPC policy, billing UX, wallet-risk copy, and cloud-agent auto-selection behavior.
- App Store / Play Store review, notarization, signing-account status, and production release management.
- Real-money or account-affecting wallet actions, except tightly controlled internal testnet/mainnet smoke.
- Human UX judgment on color, button feel, onboarding clarity, copy, and whether mobile/desktop/cloud migration feels coherent.
- Final model acceptance based on qualitative trajectory review and brand/personality fit.

## Highest-Value Automation To Add Next

1. `scripts/launch-qa/run.mjs`: a single orchestrator that runs the already-proven launch gate slices, writes JSON/JUnit output, and links artifacts/screenshots into `launchdocs/artifacts/`.
2. `packages/app/test/ui-smoke/all-pages-clicksafe.spec.ts`: route/tile crawler with safe-button allowlist, desktop/mobile viewports, console-error failure, and screenshot capture.
3. `packages/agent/src/api/agent-status-routes.test.ts`: added in this pass for Computer Use status regression coverage.
4. Cloud API-key redaction e2e: after creating an API key, list keys and assert the list response never includes `key`, while create response still includes the one-time secret.
5. Fake wallet launchpad e2e: local HTML fixtures for four.meme/flap.sh/pump.fun-like flows plus fake wallet provider, proving dry-run and reject/approve branches without live funds.
6. Remote pairing e2e: two browser contexts plus route-level assertions for pending, consume, promote, revoke, and multi-interface message fanout.
7. LifeOps fake-connector matrix: deterministic fake adapters for each connector action/status/send path and route/client parity tests.
8. Mobile artifact gate: build iOS/Android, validate Podfile/Info.plist/AndroidManifest, run emulator/simulator smoke where available, collect logs/screenshots, and only leave physical-device feel/performance to humans.
9. Docs command/link gate: markdown link checker plus command existence checker against `package.json` scripts and CLI registrations.
10. Model/data gate: trajectory schema validation, redaction scan, token budget report, eval dry-run, and benchmark artifact generation.

## Existing Automation To Reuse

- App UI Playwright: `packages/app/test/ui-smoke/*`, `packages/app/scripts/run-ui-playwright.mjs`.
- Cloud e2e and Playwright: `cloud/package.json` scripts `test:e2e:*`, `test:playwright`, and `cloud/packages/tests/playwright/*`.
- Mobile/AOSP tooling: `packages/app-core/scripts/aosp/*`, `scripts/distro-android/*`, `packages/app-core/scripts/run-mobile-build.mjs`.
- Local model suites: `packages/app-core/src/services/local-inference/*.test.ts`, `packages/app-core/src/runtime/mobile-local-inference-gate.test.ts`.
- Remote/auth foundations: `packages/app-core/src/api/auth-pairing-compat-routes.test.ts`, `packages/app-core/src/api/auth/*`, `packages/app-core/test/live-agent/*`.
- Computer Use foundations: `plugins/plugin-computeruse/src/__tests__/*`, `packages/app-core/src/api/computer-use-compat-routes.test.ts`, `packages/app-core/src/components/shell/ComputerUseApprovalOverlay.test.tsx`.
- LifeOps foundations: `plugins/app-lifeops/test/*`, `plugins/app-lifeops/src/routes/lifeops-routes.test.ts`, `plugins/app-lifeops/src/hooks/useGoogleLifeOpsConnector.test.ts`.
- Scenario and prompt tooling: `scripts/run-live-scenarios.mjs`, `scripts/run-scenario-benchmark.mjs`, app-training tests, and trajectory services.

## Recommended Launch Gate Shape

- Tier 0, every PR: typecheck, Biome, docs command/link check, focused unit tests for changed packages.
- Tier 1, release branch: app UI smoke, cloud e2e smoke, agent route/contracts, LifeOps fake connectors, fake wallet launchpad, local model dry-run, mobile build template validation.
- Tier 2, nightly: Android emulator/AOSP Cuttlefish, iOS simulator where possible, cloud Playwright with test auth, scenario benchmarks, prompt/token budget reports.
- Tier 3, pre-release human pass: physical devices, real OAuth providers, controlled wallet transaction, macOS TCC, app-store/play-store packaging, final UX/model judgment.

## Net Human Load Reduction

If the Tier 0-2 automation above is implemented, humans should no longer need to manually press every button, re-check every settings control, verify routine cloud API behavior, or repeat most connector/control-plane flows. Human QA should shrink to:

- One physical-device pass per platform.
- One production-cloud account pass.
- One controlled wallet/funds pass.
- One real connector account pass for each external provider.
- One final UX/model/product-signoff pass.
