# Issue 11330 Evidence

## Live model + TUI transcript

Command:

```bash
OPENAI_API_KEY="$CEREBRAS_API_KEY" \
OPENAI_BASE_URL="$CEREBRAS_BASE_URL" \
OPENAI_LARGE_MODEL="gpt-oss-120b" \
ELIZA_CODE_DISABLE_SESSION_PERSISTENCE=1 \
PGLITE_DATA_DIR=:memory: \
DATABASE_URL= \
POSTGRES_URL= \
LOG_LEVEL=fatal \
TERM=xterm-256color \
bun --conditions eliza-source .github/issue-evidence/11330-live-model-tui-harness.ts
```

Artifacts:

- `11330-live-model-trajectory.json` - live model tool calls, real FILE/SHELL action results, final file contents.
- `11330-live-tui-render.txt` - manually reviewed clean TUI render.
- `11330-live-tui-render.ansi` - raw ANSI TUI render.
- `11330-live-model-tui-harness.ts` - evidence harness.

Reviewed result:

```text
edit live-tool-fixture.txt +2/-1
run cat live-tool-fixture.txt exited 0
Eliza
  done
```

Final file content:

```text
alpha
after-one
after-two
omega
```

## Verification

```bash
bun --conditions eliza-source test --pass-with-no-tests src/lib/tool-transcript.test.ts src/tool-transcript-events.test.ts src/components/narrow-terminal.test.ts src/global-input.test.ts src/lib/store.remove-message.test.ts
bun --conditions eliza-source test src/actions/edit.test.ts src/actions/bash.test.ts
bun run --cwd packages/examples/code typecheck
bun run --cwd plugins/plugin-coding-tools typecheck
bun run --cwd packages/examples/code build
bun run --cwd plugins/plugin-coding-tools build
bunx @biomejs/biome check packages/examples/code/src/App.ts packages/examples/code/src/lib/tool-transcript.ts packages/examples/code/src/tool-transcript-events.test.ts packages/examples/code/src/components/ChatPane.ts packages/examples/code/src/components/narrow-terminal.test.ts packages/examples/code/src/lib/store.ts packages/examples/code/src/lib/session.ts packages/examples/code/src/types.ts packages/examples/code/src/lib/tool-transcript.test.ts plugins/plugin-coding-tools/src/actions/edit.ts plugins/plugin-coding-tools/src/actions/bash.ts plugins/plugin-coding-tools/src/actions/edit.test.ts plugins/plugin-coding-tools/src/actions/bash.test.ts
git diff --check HEAD
```

All commands above passed.

Root `bun run verify` was attempted and stopped at the existing repo-wide type-safety ratchet drift before Turbo:

```text
as unknown as: 80 / 77
?? {} (core/agent/app-core): 379 / 377
```
