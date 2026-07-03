# PR 11962 Chat First-Turn Pool-First Review

Date: 2026-07-03
Branch: `fix/chat-sub-pool-first-warm-auth`
PR: https://github.com/elizaOS/eliza/pull/11962
Issue context: https://github.com/elizaOS/eliza/issues/11180

## Scope Reviewed

- `plugins/plugin-cli-inference`: first warm-session auth, account-pool selection, subprocess-only env, rotation-on-limit, SDK dependency metadata.
- `packages/ui`: in-chat onboarding conductor, single action/send funnel, continuous chat first-run lock, tutorial handoff, local model auto-download trigger, model-download home widget.
- `plugins/plugin-local-inference`: resumable model download job, installed-model registration, chat-readable local inference status.

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

- Rebased PR 11962 onto `origin/develop`.
- Kept the PR's pool-first behavior and tests intact.
- Fixed the remaining `plugin-cli-inference` package-suite failure by adding the lazily imported `@anthropic-ai/claude-agent-sdk` to `optionalDependencies` and updating `bun.lock`.
- Removed unrelated `bun install` artifact churn before final validation.

## Remaining Delta / Risks

- The account-pool session key is the warm SDK session key (`model`, mode, system prompt hash for Claude; `model`, mode for Codex), not an explicit conversation id. That is acceptable for PR 11962's first-turn auth fix, but the ideal affinity model would use a true conversation/thread key once this plugin receives one reliably.
- Root `bun run verify` is blocked before package checks by the repo-wide type-safety ratchet on current `origin/develop`: `as unknown as` is `81` current vs `75` baseline, and `?? 0` in core/agent/app-core is `377` current vs `375` baseline. This branch does not touch those production source files.
- UI screenshots/video were not recaptured for this backend/package-metadata branch. No UI pixels changed. The first-run/download/tutorial journey was validated with targeted UI tests listed below. If a UI PR changes these surfaces, capture with `bun run --cwd packages/app audit:app` and `bun run test:e2e:record`.
- Live Claude/Codex model trajectory was not captured in this pass because no live app account-pool subscription credentials were available in the workspace. The unit suite validates the credential-selection contract and verifies pooled tokens never enter `process.env`.

## Validation Run

- `bun install` after rebase completed, including dev artifact sync.
- `ELIZA_SKIP_ARTIFACT_SYNC=1 bun install` after manifest edit updated only dependency state.
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
- `git diff --check` passed.
- `bun run verify` failed at `audit:type-safety-ratchet` before reaching this package: unrelated `as unknown as` and `?? 0` baselines exceeded in current `origin/develop`.
