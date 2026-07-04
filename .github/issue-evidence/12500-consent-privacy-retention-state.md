# Issue #12500 — consent, privacy, and retention UX

Parent issue: https://github.com/elizaOS/eliza/issues/12500
Code PR: https://github.com/elizaOS/eliza/pull/13259
Human follow-up issue: https://github.com/elizaOS/eliza/issues/13260

## Agent-completed scope

- Added a shared `TranscriptCapturePrivacyState` contract and
  `transcriptCapturePrivacyState()` normalizer for meeting capture mode,
  consent, policy, permission, retention, source-audio deletion, and independent
  transcript/notes/source-audio/artifact sharing states.
- Added Transcripts view chips for meeting records so capture/privacy/retention
  metadata is visible in the detail pane.
- Persisted default meeting transcript privacy metadata from
  `MeetingTranscriptWriter`:
  - capture mode: `bot`
  - policy: `allowed`
  - permission: `not_required`
  - retention: `transcript_only` or `audio_retained`
  - sharing: owner-private transcript/notes/artifacts, source audio disabled
    unless retained.

## Verification

- `bun install`
  - Completed in the isolated worktree.
  - Artifact sync completed at `2026-06-18.1`.
  - Generated lock/artifact drift was restored before commit.
  - Reran after `git fetch origin && git rebase origin/develop`; artifacts were
    already current and lockfile ordering drift was restored.
- `node packages/shared/scripts/generate-keywords.mjs --target ts`
  - Generated the local core/shared validation keyword modules required by
    focused tests.
- `bun run --cwd packages/cloud/routing build`
  - Passed; required so Vitest could resolve `@elizaos/cloud-routing`.
- `bun run --cwd packages/contracts build`
  - Passed; required by shared/core package typechecks.
- `bun run --cwd packages/shared build`
  - Passed.
- `bun run --cwd packages/core build`
  - Passed.
- `bunx biome check packages/shared/src/transcripts.ts packages/shared/src/transcripts.test.ts packages/ui/src/components/transcripts/TranscriptsView.tsx packages/ui/src/components/transcripts/TranscriptsView.test.tsx plugins/plugin-meetings/src/transcripts/meeting-transcript-writer.ts plugins/plugin-meetings/src/transcripts/meeting-transcript-writer.test.ts`
  - Passed.
- `bun run --cwd packages/shared test -- transcripts.test.ts`
  - Passed: 1 file, 20 tests.
- `bun run --cwd packages/ui test -- TranscriptsView.test.tsx`
  - Passed: 1 file, 8 tests.
- `bun run --cwd plugins/plugin-meetings test -- src/transcripts/meeting-transcript-writer.test.ts`
  - Passed: 1 file, 7 tests.
- `bun run --cwd packages/shared typecheck`
  - Passed.
- `bun run --cwd plugins/plugin-meetings typecheck`
  - Passed.
- `bun run --cwd plugins/plugin-meetings lint:check`
  - Passed.
- `bun run --cwd packages/ui typecheck`
  - Passed before the final `origin/develop` rebase.
  - On final base `c971b10c275`, failed outside this PR on
    `packages/ui/src/components/chat/widgets/notifications.tsx` because
    `selectHomeNotifications` is not exported from
    `packages/ui/src/widgets/home-priority`.
- `bun run --cwd packages/app audit:app`
  - Passed before and after rebasing onto latest `origin/develop`.
  - Post-rebase result: 373 Playwright audit checks passed.
  - Summary: `broken=0`, `needs-work=0`, `needs-eyeball=25`, `good=347`,
    `minimalism-budget-failures=0`, `minimalism-ratchet-failures=0`.
  - Known hover-probe timeouts included `builtin-transcripts` "Join meeting" in
    all four viewports; screenshots showed no visible layout breakage.
  - Manually reviewed Transcripts screenshots:
    - `packages/app/aesthetic-audit-output/desktop-landscape/builtin-transcripts.png`
    - `packages/app/aesthetic-audit-output/mobile-portrait/builtin-transcripts.png`
    - `packages/app/aesthetic-audit-output/mobile-landscape/builtin-transcripts.png`
    - `packages/app/aesthetic-audit-output/ipad-portrait/builtin-transcripts.png`
  - Filled Transcripts manual-review notes:
    - `packages/app/aesthetic-audit-output/manual-review/builtin-transcripts-desktop-landscape.md`
    - `packages/app/aesthetic-audit-output/manual-review/builtin-transcripts-mobile-portrait.md`
    - `packages/app/aesthetic-audit-output/manual-review/builtin-transcripts-mobile-landscape.md`
    - `packages/app/aesthetic-audit-output/manual-review/builtin-transcripts-ipad-portrait.md`
- `bun run verify`
  - Failed outside this PR during workspace lint after the AGENTS/CLAUDE
    identity check, type-safety ratchet, and error-policy ratchet passed against
    final base `c971b10c275`.
  - Turbo reported `@elizaos/electrobun#lint` as the failing task.
- `bun run --cwd packages/app-core/platforms/electrobun lint`
  - Reproduced the final root-verify blocker.
  - Failed on existing unrelated formatting in
    `packages/app-core/platforms/electrobun/src/voice/voice-service.test.ts`.

## Known out-of-scope verification failures

- Earlier post-rebase `bun run verify`
  - Failed outside this PR at `@elizaos/tui#lint`.
  - Direct repro: `bun run --cwd packages/tui lint` failed on existing
    unrelated TUI lint debt, including
    `lint/suspicious/noControlCharactersInRegex` in `packages/tui/src/keys.ts`
    and `packages/tui/src/terminal.ts`, plus existing non-null assertion/import
    diagnostics.
- `bun run --cwd packages/shared lint:check`
  - Failed on existing unrelated formatting in
    `packages/shared/src/voice/aec/echo-alignment.ts`.
- `bun run --cwd packages/ui lint:check`
  - Failed on existing unrelated diagnostics in:
    - `packages/ui/src/cloud/shell/cloud-route-gate.test.tsx`
    - `packages/ui/src/first-run/use-first-run-conductor.ts`
    - `packages/ui/src/state/useChatCallbacks.select-race.test.tsx`
    - `packages/ui/src/voice/tts-playback-activity.test.ts`

## Still needs human proof

- Headful screenshots/video showing real meeting records with these capture
  modes: bot, platform import, bot-free tab/system, local mic, mobile room mic,
  benchmark import, and imported artifact.
- Real org-policy-denied flow proving capture is blocked before audio starts,
  with frontend and backend logs.
- Permission-denied, capture-stopped, bot-removed, meeting-ended, and
  policy-denied failure-state proof.
- Retention proof deleting source audio, invalidating replay, and preserving
  allowed transcript references.
- Sharing-control proof that transcript, notes, source audio, and generated
  artifacts can be controlled independently.
- Domain artifacts from the real run: transcript metadata rows, source-audio
  media handles before/after deletion, generated notes/artifacts, and logs.
