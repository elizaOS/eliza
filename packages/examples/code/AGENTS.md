# Code

A first-party elizaOS runnable example — an interactive coding-agent TUI. See [README.md](README.md) for what it does and how to run it.

## Dual role (why this package matters beyond "an example")

`dist/index.js` is not only the standalone `eliza-code` TUI — it is the binary the **coding cockpit's PTY terminal spawns** (`@elizaos/plugin-pty` resolves it via `ELIZA_CODE_BIN`; see `plugins/plugin-pty/CLAUDE.md`). So two non-obvious build contracts are load-bearing for the cockpit and must not be "simplified" away:

- **`scripts/write-dist-tsconfig.mjs` runs as the last `build` step** and emits a paths-free `dist/tsconfig.json`. Bun applies the nearest tsconfig's `compilerOptions.paths` **at runtime**; this package's tsconfig maps externalized `@elizaos/plugin-*` to types-only `.d.ts`, so without the shadow tsconfig `bun dist/index.js` loads a `.d.ts` and throws `ReferenceError: <plugin> is not defined` on first import. Removing the step silently re-breaks every cockpit terminal spawn (#11043).
- **The TUI must survive narrow terminals.** `components/ChatPane.ts` renders the editor at `innerWidth - 3` and `components/MainScreen.ts` clips every assembled line via `truncateToWidth`, because the cockpit xterm can be ~40 columns on a phone and the TUI's overflow guard aborts the whole render otherwise (#11043). A regression here is covered by `components/narrow-terminal.test.ts`.

## TUI architecture and capabilities

The interactive TUI is built on `@elizaos/tui`: differential rendering, `Editor`, `Markdown`, and themes. Most expected terminal UI primitives already exist in `@elizaos/tui` or `@elizaos/core`; the work is wiring them, not reinventing them. `App` owns input and slash commands; `MainScreen` composes columns and clips every line; `ChatPane` owns transcript plus composer; `TaskPane` owns task detail; `StatusBar` owns room, cwd, task count, and active model display.

- **Input routing:** stdin flows through `FilteringTerminal` into `App.consumeGlobalInput`. Global shortcuts fire before the focused component. Shortcuts must not eat typed characters: `?` opens help only when the chat composer is empty or unfocused; bare `,` / `.` resize the task pane only when it is focused. Ctrl-left/right always resizes.
- **Markdown transcript:** assistant replies render through the tui `Markdown` component with `lib/markdown-theme.ts`. Below roughly 40 columns it falls back to plain `wrapText` so the narrow-terminal guarantee holds. Markdown output is pre-styled as `RenderLine.raw`; do not re-chalk it.
- **Streaming and turn control:** `lib/agent-client.ts` streams via `onDelta` / core `onStreamChunk`. `App.activeTurnAbortController` lets Esc / Ctrl-C cancel an in-flight turn, and a re-entrancy guard blocks concurrent turns. Turn errors are caught and shown as system messages; unhandled rejections escape to `index.ts` fatal handlers, which only best-effort restore the terminal.
- **Composer and history:** `Editor` handles multiline input, cursor-windowing, and up/down prompt history. `ChatPane` must call `editor.addToHistory` on submit for recall to work.
- **Scrollback:** Ctrl-up/down scrolls one line, PgUp/PgDn scroll by page, Home/End jump to oldest/newest. Home/End route to scroll only when the composer is empty or the transcript is already scrolled; otherwise they reach editor line navigation. Key matching goes through `@elizaos/tui` `matchesKey(...)`, not raw escape sequences.
- **Slash commands:** `App.handleSlashCommand` owns `/copy`, `/new`, `/task`, `/cd`, `/clear`, and related commands. `/copy` writes the latest reply via OSC 52 for SSH/PTY clipboard support. Unknown `/cmd` is reported, not sent to the LLM; `//literal` escapes. Register new commands in `SLASH_COMMANDS` and `/help`.
- **ANSI-safe borders:** pad styled strings with `lib/text-width.ts` `padEndVisible`; never use `String.padEnd` on chalked strings, because invisible SGR bytes collapse right borders.

Reusable test patterns:
- Drive private handlers by constructing `new App(stubRuntime)` with `{ agentId, character, getService: () => null }` and casting to call `consumeGlobalInput` or `handleSlashCommand`.
- Render assertions use `VirtualTerminal` plus `TUI` plus `MainScreen.render(width)`, as in `narrow-terminal.test.ts`. Chalk color is off outside a TTY, so assert visible width / marker stripping instead of raw SGR unless a test explicitly forces and restores `chalk.level`.
- The zustand `useStore` is a cross-file singleton. Each `beforeEach` must seed its own room with `createRoom` plus `switchRoom`, and pin/restore `chalk.level`, or sibling tests can leak `rooms: []` or color state into your assertions.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — runnable example:**
- Proof the example **actually runs** end to end on a clean checkout — the real command(s), the real output/logs, and a screenshot or recording where there is a UI or visible result.
- Any model interaction captured as a **live** trajectory (not the proxy) and reviewed — this example is a reference others copy, so it must demonstrate the real path.
- The artifacts it produces (files, memories, on-chain/DB state, responses) inspected by hand.
- Failure/edge behavior (missing keys, bad input) handled or clearly documented — keep the example honest, not a happy-path-only toy.
<!-- END: evidence-and-e2e-mandate -->
