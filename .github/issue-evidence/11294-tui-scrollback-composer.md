# Issue #11294: eliza-code TUI Scrollback + Multiline Composer

Date: 2026-07-02

Scope:
- `packages/examples/code` TUI `ChatPane`
- Adds PgUp/PgDn/Home/End scrollback controls, keeps the transcript viewport pinned while scrolled, and renders multiple visible composer rows.
- No model, prompt, provider, action, connector, browser, native, or web app behavior changed.

## Rendered Proof

Manually reviewed terminal render from the real `ChatPane.renderContent` path at the cockpit phone width (`43` columns):

```text
--- multiline composer, 43 cols ---

┌───────────────────────────────────────┐
│ >  first line                         │
│    second line                        │
│    third line                         │
└───────────────────────────────────────┘
Enter: send • PgUp/PgDn: scroll • Esc: c...
--- scroll pinned first visible ---
transcript line 16
transcript line 16
 Chat: Evidence (30) [↑ 16]
```

Manual review notes:
- All composer rows stay inside the 43-column frame.
- The second and third composer rows are visible instead of being collapsed.
- After PgUp, appending transcript lines 29 and 30 kept the first visible line at `transcript line 16`; the scroll indicator stayed visible.

## Verification

Commands run from `/private/tmp/eliza-11294-tui-scrollback` unless noted:

```bash
ELIZA_SKIP_ARTIFACT_SYNC=1 bun install
node packages/shared/scripts/generate-keywords.mjs --target ts
bun test --conditions eliza-source --pass-with-no-tests src/components/narrow-terminal.test.ts
bun test --conditions eliza-source --pass-with-no-tests src/components/narrow-terminal.test.ts src/components/chat-markdown.test.ts src/global-input.test.ts src/lib/agent-client.streaming.test.ts src/tool-transcript-events.test.ts src/lib/tool-transcript.test.ts src/lib/store.remove-message.test.ts
bunx @biomejs/biome check packages/examples/code/src/components/ChatPane.ts packages/examples/code/src/components/HelpOverlay.ts packages/examples/code/src/components/narrow-terminal.test.ts
bunx turbo run build --filter=@elizaos/example-code...
bun run --cwd packages/examples/code typecheck
bun run --cwd packages/examples/code build
```

Results:
- Focused narrow-terminal suite: 12 pass, 83 assertions.
- Broader eliza-code TUI regression set: 29 pass, 219 assertions.
- Biome check: pass.
- Turbo dependency build for `@elizaos/example-code...`: 97 successful.
- Package typecheck: pass.
- Package build: pass.

## Evidence Matrix

- Real-LLM trajectories: N/A - no model, prompt, action, provider, or agent decision behavior changed.
- Backend logs: N/A - terminal-only render/input handling change.
- Frontend console/network logs: N/A - no browser/web app surface.
- Screenshots/video: N/A - not a browser/native UI path; rendered terminal proof and VirtualTerminal tests cover the changed TUI surface.
- Domain artifacts: N/A - no persistence, memory, DB, task, file, wallet, or on-chain artifacts produced.
