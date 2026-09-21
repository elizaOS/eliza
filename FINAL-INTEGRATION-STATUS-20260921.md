# Eliza integration status — 2026-09-21

## Saved checkpoints

- Verified text-demo checkpoint: `codex/final-text-integration-20260920` at `acda9b399844`, tag `codex/final-text-verified-20260920`.
- Current `develop` base audited at `df219e4b2fe8`.
- Historical consolidation draft: [PR #32042](https://github.com/elizaOS/eliza/pull/32042). It remains draft and conflicts because `develop` relocated the message runtime and advanced calendar/runtime code. It must be integrated semantically; do not merge it blindly.

## What is fixed in the current-develop lane

- `VITE_VOICE_REALTIME_FORCE` is explicit-only again. The dev supervisor starts the Cartesia gateway and relies on its health probe; it does not silently force-arm voice when a key exists. This is [PR #32044](https://github.com/elizaOS/eliza/pull/32044).
- Current `develop` already contains the acknowledgement/progress plumbing and the relocated assistant message runtime. The normal text path can remain fast; planner/context work should show progress when it is genuinely doing work.

## Verification and limits

- `node --check packages/app-core/scripts/dev-ui.mjs` passes.
- The saved 5288 runtime checkpoint is healthy: API ready, local voice gateway ready, Cartesia STT/TTS configured, Cerebras text configured; 73 focused voice tests passed on the verified checkpoint.
- Physical microphone/audio/animation verification is still a user-side gate. No deploy or protected-`develop` merge has happened.
- There is no universal under-three-second guarantee for planner, calendar, memory, or conflict checks; those paths can require additional model/tool calls and larger context.

## Next safe merge gate

Rebase the small voice PR if `develop` moves, run current-develop assistant/calendar/notes tests with a fully installed worktree, then review the historical consolidation by behavior and cherry-pick only missing semantics. Keep PR #32042 draft until that audit is complete.
