# Issue #11576 — Voice Listener Safety

## Validation

- `bun install` completed in the clean worktree to restore local test binaries.
- `bun packages/shared/scripts/generate-keywords.mjs` generated the local i18n import needed by the UI test runner.
- `bunx @biomejs/biome check --write packages/ui/src/hooks/useVoiceChat.ts packages/ui/src/hooks/useVoiceChat.talkmode-listeners.test.tsx packages/ui/src/components/settings/VoiceConfigView.tsx packages/ui/src/components/settings/VoiceConfigView.test.tsx packages/ui/src/components/settings/VoiceSectionMount.tsx packages/ui/src/components/settings/VoiceSectionMount.test.tsx`
- `bun run --cwd packages/ui test -- src/hooks/useVoiceChat.talkmode-listeners.test.tsx src/components/settings/VoiceConfigView.test.tsx src/components/settings/VoiceSectionMount.test.tsx` — 3 files, 9 tests passed.
- `git diff --check`

## Typecheck

- `bun run --cwd packages/ui typecheck` still fails on existing unrelated `@elizaos/contracts` resolution and `AccountWithCredentialFlag` account-field errors. The #11576-specific `VoiceSectionMount.tsx` typing error observed during development was fixed and no longer appears in the final typecheck output.

## UI Evidence

- Visual screenshots/video: N/A — this change does not alter rendered layout, styling, copy, or interaction affordances. It fixes async listener registration/cleanup and boot error handling with jsdom lifecycle regressions.
- Real LLM trajectories: N/A — no model, prompt, provider, action, or agent behavior changed.
