# Issue #11329: eliza-code TUI turn abort

## What changed

- `packages/examples/code/src/App.ts` now owns one active turn `AbortController`.
- `Esc` or the first `Ctrl+C` aborts an active turn and leaves the TUI in an idle state.
- `Ctrl+C` with no active turn still follows the existing quit path.
- `packages/examples/code/src/lib/agent-client.ts` threads the caller `abortSignal` into `runtime.messageService.handleMessage`.
- The loading row now advertises `Esc/Ctrl+C abort` and is clipped to narrow terminal width.

## Verification

- `bun --conditions eliza-source test --pass-with-no-tests src/global-input.test.ts src/components/narrow-terminal.test.ts src/lib/store.remove-message.test.ts`
- `bun run --cwd packages/examples/code typecheck`
- `bunx @biomejs/biome check packages/examples/code/src/App.ts packages/examples/code/src/lib/agent-client.ts packages/examples/code/src/components/ChatPane.ts packages/examples/code/src/global-input.test.ts packages/examples/code/src/components/narrow-terminal.test.ts packages/examples/code/tsconfig.json`
- `git diff --check`
- `bun run --cwd packages/examples/code build`

## Manual evidence

- `11329-tui-abort-tui-transcript.txt`: cleaned PTY transcript from a built interactive `eliza-code --interactive --coding-only` run against the live Cerebras-backed OpenAI-compatible provider. The run starts a long turn, shows `Processing... Esc/Ctrl+C abort`, sends `Esc`, then shows `Turn aborted.` with the composer idle.
- `11329-tui-abort-tui-raw.txt`: raw ANSI TUI transcript from the same run.
- `11329-tui-abort-expect-output.txt`: expect harness output from the same run.
- `11329-tui-abort-transcript-screenshot.png`: rendered screenshot of the real PTY transcript states.
- `11329-tui-abort-walkthrough.mp4`: short visual playback generated from the real PTY transcript frames.
- `11329-tui-abort-live-agentclient.json`: direct live `AgentClient` path using the same provider/model settings; it captures a real model response callback and confirms the caller signal was aborted.
- `11329-tui-abort-live-agentclient-timer-abort.json`: direct live `AgentClient` timer-abort capture. This path resolved quickly because this package receives completed response callbacks rather than token deltas for the tested provider path; the TUI transcript is the authoritative user-flow abort proof.

## Notes

- Root `bun run verify` remains blocked before Turbo by the current repository type-safety ratchet drift unrelated to this package change: `as unknown as` and ``?? {}` budgets are already exceeded on `develop`.
- No `packages/app` files changed, so the app visual audit requirement does not apply.
