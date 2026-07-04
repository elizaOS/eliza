# Evidence for #12490 - Bot-Free Meeting Capture

## Code PR

https://github.com/elizaOS/eliza/pull/13225

## Human Follow-Up

https://github.com/elizaOS/eliza/issues/13226

## Agent-Completed Work

- Added a browser/desktop bot-free meeting audio capture primitive in
  `@elizaos/ui/voice`.
- Captures tab/system display audio through `getDisplayMedia({ audio: true })`
  and local microphone audio through `getUserMedia`.
- Keeps local mic and remote tab/system sources separate when both expose audio
  tracks.
- Emits explicit source metadata for requested, captured, unavailable, denied,
  and error states.
- Records sample rate, channel count, sample count, duration, RMS/peak, display
  surface, device/group ids, and local-vs-remote sync offset when measurable.
- Generates source-labeled PCM16 WAV artifacts plus a mixed fallback/reference
  WAV when both separate sources are available.
- Exposes support detection without prompting for permissions.
- Added deterministic unit coverage for support detection, source-mode
  classification, PCM mixing/clipping, WAV artifact metadata, and permission
  denied/no-source errors.

## Verification

Commands run on 2026-07-04:

```bash
bun install
```

Result: completed. The install synced the shared artifact bundle at
`2026-06-18.1`; generated artifact changes were restored before committing.

```bash
bun run --cwd packages/ui test -- bot-free-meeting-audio-capture.test.ts
```

Result: 1 file passed, 5 tests passed.

```bash
bunx @biomejs/biome check packages/ui/src/voice/bot-free-meeting-audio-capture.ts packages/ui/src/voice/bot-free-meeting-audio-capture.test.ts packages/ui/src/voice/index.ts
```

Result: passed with no fixes applied.

```bash
node packages/shared/scripts/generate-keywords.mjs --target ts
bun run --cwd packages/contracts build
bun run --cwd packages/cloud/routing build
```

Result: passed. These generated/build prerequisites were needed in the fresh
worktree before package typecheck could resolve shared/core generated keyword
data and workspace package declarations.

```bash
bun run --cwd packages/ui typecheck
```

Result: passed.

```bash
bun run --cwd packages/ui lint:check
```

Result: failed outside the files touched by this PR. Existing package-wide
diagnostics include `src/cloud/shell/cloud-route-gate.test.tsx` useless
fragments, `src/first-run/use-first-run-conductor.ts:940` assignment in an
expression, formatting in `src/state/useChatCallbacks.select-race.test.tsx`,
and formatting in `src/voice/tts-playback-activity.test.ts`. The three touched
files passed the targeted Biome check above.

```bash
bun run verify
```

Result: failed outside this PR in `@elizaos/tui#lint` on existing control
character regular-expression diagnostics and related TUI lint warnings. The
type-safety ratchet and error-policy ratchet passed for this branch. Biome
auto-fixes in unrelated packages were restored before publishing.

## Not Captured By Agent

Live Google Meet and Zoom capture evidence remains human-blocked. The follow-up
issue must capture a real desktop walkthrough video, source-separated local mic
and tab/system audio artifacts where platform policy allows, mixed fallback
audio where separation is impossible, transcript artifact, frontend console and
network logs, backend logs, permission-denied screenshot, and retention/delete
proof.
