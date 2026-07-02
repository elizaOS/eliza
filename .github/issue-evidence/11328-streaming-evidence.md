# Issue 11328 Evidence

## Live model trajectory

Command:

```bash
bun .github/issue-evidence/11328-live-stream-harness.ts
```

Result: captured 22 live deltas from `gemma-4-31b` via the OpenAI-compatible
Cerebras endpoint.

Artifacts:

- `11328-live-stream.json` - prompt, response, per-delta timestamps/text, and
  render snapshot metadata.
- `11328-live-render.txt` - manually reviewed plain-text TUI snapshots.
- `11328-live-render.ansi` - raw ANSI TUI snapshots.
- `11328-live-stream-harness.ts` - repeatable capture harness.

Manual review:

- Initial snapshot shows `Processing (Esc/Ctrl+C abort)` from the TUI `Loader`
  with an empty assistant placeholder.
- Delta snapshots show the assistant content growing from 1 char to 133 chars
  before the final response.
- Final snapshot shows the full 258-char live response and the loader removed.

## Verification

```bash
bun test --conditions eliza-source --pass-with-no-tests \
  src/lib/agent-client.streaming.test.ts \
  src/components/narrow-terminal.test.ts \
  src/global-input.test.ts \
  src/tool-transcript-events.test.ts \
  src/lib/tool-transcript.test.ts \
  src/lib/store.remove-message.test.ts

bun run --cwd packages/examples/code typecheck
bun run --cwd packages/examples/code build
git diff --check
bun run verify
```

Results:

- Focused tests: 24 pass.
- `packages/examples/code` typecheck: pass.
- `packages/examples/code` build: pass.
- Whitespace check: pass.
- Root `bun run verify`: blocked before Turbo by existing type-safety ratchet
  drift: `as unknown as` is `80 / 77`; `?? {}` is `379 / 377`.
