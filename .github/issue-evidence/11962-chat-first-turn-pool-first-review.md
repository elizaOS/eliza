# PR 11962 Chat First-Turn Pool-First Review

Date: 2026-07-03
Branch: `fix/11962-cli-inference-sdk-dep`
Original PR: https://github.com/elizaOS/eliza/pull/11962
Follow-up PR: https://github.com/elizaOS/eliza/pull/11986
Issue context: https://github.com/elizaOS/eliza/issues/11180

## Scope Reviewed

- `plugins/plugin-cli-inference`: first warm-session auth, account-pool selection, subprocess-only env, rotation-on-limit, SDK dependency metadata.
- `packages/ui`: in-chat onboarding conductor, single action/send funnel, continuous chat first-run lock, tutorial handoff, local model auto-download trigger, model-download home widget.
- `plugins/plugin-local-inference`: resumable model download job, installed-model registration, chat-readable local inference status.
- `packages/cloud/shared`: post-rebase video-provider contract compatibility required by the latest `develop`.
- Repo verification blockers discovered after rebasing onto `origin/develop`: type-safety ratchet, local package typecheck/lint failures, dist-path declaration config, and post-rebase provider/typecheck drift.

## Current UX

- Chat is one persistent `ContinuousChatOverlay` mounted by the app shell. During first-run, `firstRunOpen` pins it open, disables text/attachment/voice/send controls, and makes collapse paths no-op.
- First-run choices are in-band chat turns using the reserved `__first_run__:` prefix. `AppContext` classifies every action value before send: first-run choices go to the headless conductor, non-first-run text is dropped while onboarding is active, and stale first-run sentinels never reach the server.
- Onboarding flow is chat-native: runtime choice (`cloud`, `local`, `remote`), provider choice for local (`on-device`, `elizacloud`, `other`), then tutorial choice (`start`, `skip`). Setup completion is delayed until the tutorial choice so the tour remains reachable.
- Local all-local setup starts the local agent, persists first-run once, then enqueues `autoDownloadRecommendedLocalModelInBackground`. The user lands in chat immediately while the model download continues.
- Model download visibility is handled by the home widget and local-inference chat status: queued/downloading/loading/failed/retry/ready are surfaced from the local inference hub and download stream.
- Tutorial is a post-setup guided overlay that drives the real chat controls into known states, pre-fills one navigation request, listens for actual user actions, and can be rerun from Help.
- PR 11962's chat-brain path selects a pooled `claude-sdk`/`codex-sdk` account before the first SDK attempt, strips competing ambient auth vars from the subprocess env, reuses the selected env by session key, and rotates on subscription limits before provider failover.

## Ideal UX

- The user should never bounce between a separate wizard and chat. Setup, auth, model download state, first message, and tutorial should all be controlled through the same chat surface.
- During setup, the user should only be able to make valid setup choices. Free text, stale widgets, double taps, and tutorial events should not leak into agent chat or move the sheet out of the setup state.
- A connected Claude/Codex subscription should serve the first chat turn. Ambient CLI credentials should be fallback only, not the primary route when a healthy app-connected account exists.
- Local-first setup should land in the app quickly, show clear model download progress, allow retry/cancel/manage actions, and avoid blocking the tutorial or basic navigation.
- Failures should be recoverable through explicit choices: retry, choose a different runtime/provider, or configure in Settings.

## Delta Closed In This Pass

- Confirmed original PR #11962 was merged into `develop`.
- Opened follow-up PR #11986 for the remaining package/verification work.
- Added the lazily imported `@anthropic-ai/claude-agent-sdk` as an optional dependency of `@elizaos/plugin-cli-inference` so isolated package tests resolve the SDK import.
- Removed remaining repo-wide verification blockers on this branch:
  - reduced type-safety ratchet counts back within baseline by removing double casts and numeric fallback expressions in touched runtime-adjacent code,
  - fixed `cloud-shared` access to `@elizaos/security` declarations and nullable affiliate billing markup,
  - implemented AtlasCloud video `getJobStatus` support required by the current `VideoProvider` contract and covered success/pending/terminal-failure/404 states,
  - fixed shared/plugin-local-inference formatting/lint failures,
  - regenerated `tsconfig.dist-paths.json` so dist-path consumers include `@elizaos/plugin-meetings`.
- Kept unrelated generated registry and emitted `.js/.map` build artifacts out of the final diff.

## Remaining Delta / Risks

- The account-pool session key is the warm SDK session key (`model`, mode, system prompt hash for Claude; `model`, mode for Codex), not an explicit conversation id. That is acceptable for PR 11962's first-turn auth fix, but the ideal affinity model would use a true conversation/thread key once this plugin receives one reliably.
- No live Claude/Codex trajectory was captured in this pass because no live app account-pool subscription credentials were available in the workspace. The package suite validates the credential-selection contract and verifies pooled tokens never enter `process.env`.
- The recorded `assistant-home-flow` UI lane produced usable first-run/chat screenshots, but the full lane exits non-zero on existing launcher/voice smoke drift unrelated to this PR: missing `launcher-tile-settings` after `/views`, missing `home-launcher-surface` in the iOS-style home assertion, and missing the `release to send` push-to-talk affordance. I did not change those UI tests in this backend/package follow-up.

## Visual Evidence

Captured with `E2E_RECORD=1 bun run --cwd packages/app test:e2e -- test/ui-smoke/assistant-home-flow.spec.ts` on 2026-07-03 and manually reviewed from `packages/app/aesthetic-audit-output/assistant-home-flow/` before copying into this evidence directory:

- `.github/issue-evidence/11962-chat-journey-01-first-run-clouds.png`: fresh first-run starts inside the continuous chat overlay; free-text composer is disabled; only runtime choices are active.
- `.github/issue-evidence/11962-chat-journey-02-assistant-chat-root.png`: after setup completion, the same bottom chat overlay returns on the ready app surface.
- `.github/issue-evidence/11962-chat-journey-03-assistant-chat-typing.png`: normal chat input resumes after first-run completion.
- `.github/issue-evidence/11962-chat-journey-04-chat-pill-suppressed.png`: `/chat` keeps the assistant chat surface active without rendering the extra shell home pill.

## Validation Run

- `bun install` after rebase completed.
- `ELIZA_SKIP_ARTIFACT_SYNC=1 bun install` after manifest edit updated workspace dependency links.
- `bun run --cwd packages/core build` passed.
- `bun run --cwd plugins/plugin-cli-inference test -- __tests__/account-rotation.test.ts` passed: 1 file, 21 tests.
- `bun run --cwd plugins/plugin-cli-inference test` passed: 7 files, 94 tests.
- `bun run --cwd plugins/plugin-cli-inference typecheck` passed.
- `bun run --cwd plugins/plugin-cli-inference lint:check` passed.
- `bun run --cwd plugins/plugin-cli-inference build` passed.
- Targeted UI journey slice passed: 8 files, 73 tests.
  - `src/App.chat-overlay-first-run.test.tsx`
  - `src/first-run/use-first-run-conductor.test.ts`
  - `src/first-run/use-first-run-conductor.fuzz.test.ts`
  - `src/first-run/first-run-action-channel.test.ts`
  - `src/first-run/auto-download-recommended.test.ts`
  - `src/components/chat/widgets/model-download.test.tsx`
  - `src/components/shell/ContinuousChatOverlay.firstrun.test.tsx`
  - `src/components/pages/tutorial/tutorial-steps.test.ts`
- `bun run --cwd packages/agent test -- src/api/trajectory-fallback-routes.test.ts` passed: 8 tests.
- `bun run --cwd plugins/plugin-meetings typecheck` passed.
- `bun run --cwd plugins/plugin-meetings build` passed.
- `bun run --cwd packages/cloud/shared typecheck` passed.
- `bun run --cwd packages/cloud/shared test -- src/lib/providers/video/atlascloud-video-generation.test.ts` passed: 8 tests.
- `bun run --cwd packages/cloud/shared lint` passed.
- `bun run --cwd packages/cloud/api typecheck` passed.
- `bun run --cwd packages/agent lint` passed.
- `bun run --cwd packages/security typecheck` passed.
- `bun run --cwd packages/shared lint` passed.
- `bun run --cwd packages/shared typecheck` passed.
- `bun run --cwd plugins/plugin-local-inference lint:check` passed.
- `bun run --cwd plugins/plugin-local-inference test -- src/services/bionic-host-loader.test.ts` passed: 4 passed, 16 skipped.
- Focused app-core account-pool suite passed for 5 files / 51 tests; the standalone `credential-resolver.multi-account.test.ts` lane still needs the broader build graph because it imports `@elizaos/plugin-birdclaw`.
- `git diff --check` passed.
- `bun run typecheck:dist` passed: 28 dist-path consumer configs.
- `bun run verify` passed: type-safety ratchet, 488 turbo build/typecheck/lint tasks, build model audit, turbo build dependency audit, TEE secret leak audit, script audit, test-realness audit, and dist-path consumer typecheck.
- `E2E_RECORD=1 bun run --cwd packages/app test:e2e -- test/ui-smoke/assistant-home-flow.spec.ts` produced the visual evidence above, but exited 1 on the unrelated launcher/voice assertions listed in Remaining Delta / Risks.
