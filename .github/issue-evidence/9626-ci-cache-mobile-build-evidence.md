# Issue #9626 evidence: CI cache and platform build hardening

## What changed

- Turbo cache keys now come from `packages/scripts/turbo-cache-key.mjs`, shared by the setup action and release workflow.
- Mobile web build reuse now validates renderer manifest variant/target metadata before reusing `packages/app/dist`.
- iOS native dependency scripts now skip cleanly on non-Darwin hosts through `packages/scripts/run-bash-darwin-only.mjs`.

## Verification

- `git fetch origin && git rebase origin/develop`: branch synced; final `git rev-list --left-right --count HEAD...origin/develop` was `0 0`.
- `bun install`: completed on the synced base.
- `bun test packages/scripts/__tests__/turbo-cache-key.test.ts packages/app-core/scripts/lib/mobile-web-build-reuse.test.mts`: 10 passed.
- `bun run verify`: passed; final gates included build-model audit, Turbo dependency audit, script audit, and 28 dist-path consumer configs.

## Evidence type coverage

- Backend logs: N/A, workflow/build-script hardening only.
- Frontend logs: N/A, no user-facing frontend runtime path.
- Real-LLM trajectories: N/A, no agent/action/prompt/model behavior changed.
- Screenshots/video/audio: N/A, no visual, voice, TTS, or STT behavior changed.
