# @elizaos/tui

Terminal User Interface library with differential rendering for flicker-free interactive CLI applications.

## Purpose / Role

`@elizaos/tui` is a standalone rendering library that provides a component-based terminal UI framework. It is used by `packages/agent` (the elizaOS agent CLI) and `packages/examples/code` to build interactive terminal interfaces. It is not an elizaOS plugin and does not register actions/providers/evaluators — it is a pure UI rendering library consumed by other packages.

## Layout

```
packages/tui/
  src/
    index.ts               Public API — re-exports everything below
    tui.ts                 TUI class (main container, differential renderer, overlay manager)
    terminal.ts            Terminal interface + ProcessTerminal (process.stdin/stdout impl)
    terminal-image.ts      Kitty/iTerm2 image protocol support, capability detection
    autocomplete.ts        CombinedAutocompleteProvider (slash commands + file paths)
    keybindings.ts         EditorKeybindingsManager, EditorAction types, getEditorKeybindings
    keys.ts                matchesKey(), Key helper, Kitty keyboard protocol parsing
    stdin-buffer.ts        StdinBuffer — batches rapid key events before forwarding
    fuzzy.ts               fuzzyMatch / fuzzyFilter for list filtering
    editor-component.ts    EditorComponent interface (for custom editor implementations)
    constants.ts           All numeric/string constants (timeouts, sizes, limits)
    utils.ts               visibleWidth(), truncateToWidth(), wrapTextWithAnsi()
    view-registry.ts       TerminalViewRegistry — process-global registry mapping string ids to Component instances for plugin-contributed terminal views
    core/
      types.ts             Component, Focusable, OverlayOptions, CURSOR_MARKER interfaces
      container.ts         Container — groups child components, delegates render/input
      overlay.ts           Overlay layout math (resolveOverlayLayout, parseSizeValue)
    components/
      editor.ts            Editor — multi-line text input with autocomplete, scrolling
      editor/              Editor internals (history, kill-ring, layout, undo, types)
      input.ts             Input — single-line text input with horizontal scroll
      text.ts              Text — word-wrapped multi-line text with padding
      truncated-text.ts    TruncatedText — single-line status/header text
      markdown.ts          Markdown — renders markdown with syntax highlighting
      markdown/            Markdown internals (inline-renderer, list-renderer, table-renderer, types)
      loader.ts            Loader — animated spinner
      cancellable-loader.ts CancellableLoader — Loader + Escape key AbortSignal
      select-list.ts       SelectList — keyboard-navigable selection list
      settings-list.ts     SettingsList — settings panel with value cycling + submenus
      box.ts               Box — Container with padding and background color
      spacer.ts            Spacer — N blank lines
      image.ts             Image — inline image via Kitty or iTerm2 protocols
      toast.ts             Toast — transient notification overlay
      progress-bar.ts      ProgressBar — horizontal progress indicator
    themes/
      index.ts             Theme / ThemeColors interfaces; defaultTheme, darkTheme,
                           minimalTheme, oceanTheme; ansi helpers; compose()
    types/
      marked-tokens.ts     ListToken, TableToken extension types for marked parser
    utils/
      index.ts             Text-edit primitives (cursor movement, word deletion, paste)
      cursor-movement.ts   Low-level cursor position math
      paste-handler.ts     PasteHandler — bracketed paste detection + large-paste markers
    testing/
      virtual-terminal.ts  VirtualTerminal — headless @xterm/headless terminal,
                           exported via @elizaos/tui/testing
  test/
    chat-simple.ts         Runnable demo: full chat UI (markdown + loader + editor)
    *.test.ts              Vitest unit tests for all subsystems
```

## Key Exports / Surface

Everything is re-exported from `src/index.ts`. Key symbols:

| Symbol | What it is |
|--------|-----------|
| `TUI` | Main container class — manages components, overlays, and differential rendering |
| `ProcessTerminal` | `Terminal` impl backed by `process.stdin` / `process.stdout` |
| `Component` | Interface: `render(width): string[]`, optional `handleInput(data)`, optional `invalidate()` |
| `Focusable` | Interface: `focused: boolean` — for IME cursor positioning via `CURSOR_MARKER` |
| `Container` | Groups child `Component`s; base class of `TUI` |
| `CURSOR_MARKER` | Zero-width APC escape that marks IME cursor position in `render()` output |
| `Editor` | Multi-line editor; set `onSubmit`, `onChange`, call `setAutocompleteProvider()` |
| `Input` | Single-line editor; set `onSubmit`, call `getValue()` / `setValue()` |
| `SelectList` | Selection list; set `onSelect`, `onCancel`, `onSelectionChange`, call `setFilter()` |
| `Markdown` | Renders markdown; pass `MarkdownTheme`; call `setText()` to update |
| `Loader` / `CancellableLoader` | Spinner; `CancellableLoader.signal` is an `AbortSignal` |
| `Toast` | Transient overlay notification |
| `ProgressBar` | Horizontal progress bar |
| `Image` | Inline image (Kitty or iTerm2 protocol; falls back to text output) |
| `CombinedAutocompleteProvider` | Slash command + file path autocomplete for `Editor` |
| `matchesKey(data, key)` | Test raw terminal input against a `KeyId` |
| `Key` | Builder: `Key.enter`, `Key.ctrl("c")`, `Key.shift("tab")`, `Key.alt("left")` etc. |
| `visibleWidth(s)` | Visible column width ignoring ANSI codes |
| `truncateToWidth(s, w, ellipsis?)` | Truncate preserving ANSI codes |
| `wrapTextWithAnsi(s, w)` | Word-wrap preserving ANSI codes |
| `themes`, `getTheme(name)`, `ansi`, `compose` | Built-in themes and ANSI helpers |
| `EditorKeybindingsManager`, `getEditorKeybindings`, `setEditorKeybindings` | Runtime key remapping |

## Commands

```bash
bun run --cwd packages/tui build   # tsc compile to dist/
bun run --cwd packages/tui dev     # tsgo watch (faster incremental compile)
bun run --cwd packages/tui test    # vitest run test/
bun run --cwd packages/tui clean   # rm -rf dist/
```

## Config / Env Vars

| Variable | Effect |
|----------|--------|
| `TUI_WRITE_LOG=<path>` | Capture raw ANSI stream written to stdout |
| `TUI_HARDWARE_CURSOR=1` | Show real terminal cursor instead of fake cursor |
| `TUI_CLEAR_ON_SHRINK=1` | Full clear when rendered content shrinks in height |
| `TUI_DEBUG_REDRAW=1` | Log differential redraw operations to stderr |
| `PI_TUI_DEBUG=1` | Enable low-level TUI debug logging |

## How to Extend

### Add a custom component

1. Implement the `Component` interface from `@elizaos/tui`.
2. `render(width: number): string[]` — every returned line **must not exceed `width` columns** (use `truncateToWidth`). The TUI errors otherwise.
3. Optionally implement `handleInput(data: string): void` for keyboard handling (use `matchesKey` + `Key`).
4. Optionally implement `invalidate(): void` to clear render cache when content changes.
5. For IME support (CJK input), implement `Focusable` and emit `CURSOR_MARKER` in `render()` immediately before the fake cursor position.

### Show an overlay

```ts
const handle = tui.showOverlay(component, { anchor: 'bottom-right', width: 60 });
handle.hide();           // remove
handle.setHidden(true);  // temporarily hide
```

### Customize keybindings

Use `setEditorKeybindings(manager)` at startup to remap `EditorAction` values to different key sequences. `DEFAULT_EDITOR_KEYBINDINGS` is the reference map.

## Conventions / Gotchas

- **Every `render()` line must be <= `width`.** The TUI throws if a line is wider. Always call `truncateToWidth()` or `wrapTextWithAnsi()` before returning lines.
- **ANSI codes do not carry across lines.** The TUI appends `SGR reset` after each line. Reapply styles per line or use `wrapTextWithAnsi()` which preserves them.
- **`VirtualTerminal` is the headless test terminal.** It wraps `@xterm/headless`, implements the same `Terminal` interface as `ProcessTerminal`, and is exported from `@elizaos/tui/testing` (`src/testing/virtual-terminal.ts`). Drive it with `sendInput`/`resize`; read the rendered grid back cell-accurately with `getViewport`/`getScrollBuffer`/`getCursorPosition`/`getCellAttributes`, and the raw ANSI stream with `getWriteLog`. Intended for tests, not the runtime render path.
- **Image rendering is capability-gated.** `detectCapabilities()` inspects the terminal env vars; `getCapabilities()` caches that result. The `Image` component calls `getCapabilities()` automatically and falls back to text output when Kitty/iTerm2 is absent.
- **Kitty keyboard protocol.** `ProcessTerminal` enables the Kitty protocol on start. `matchesKey` handles both legacy and Kitty sequences. `isKittyProtocolActive()` reflects current state.
- **Focus and IME.** Only one component holds focus at a time. When a container wraps an `Input`/`Editor`, it must propagate `focused` to the child or IME candidate windows appear at the wrong position (see README for the pattern).
- **`StdinBuffer`** coalesces rapid stdin bursts before dispatching to components — prevents partial multi-byte sequence splits over slow connections.
- **Large pastes** (>10 lines or above `LARGE_PASTE_CHAR_THRESHOLD`) are collapsed to a `[paste #N +M lines]` marker in the `Editor` to prevent render floods.
- **No elizaOS plugin registration.** This package has no `Plugin` export and no actions/providers/services. It is a pure rendering library.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
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

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — UI surface:**
- Before/after **full-page** screenshots — desktop **and** mobile, portrait **and** landscape, rest **and** hover (`bun run --cwd packages/app audit:app` where applicable) — not desktop-only-happy-path (see #9950).
- A **video walkthrough** of the whole view/flow, plus browser console + network logs showing the real request/response and state change.
- Empty, loading, error, and permission-denied states — and fill the per-view manual-review verdict (`good`/`needs-work`/`needs-eyeball`/`broken`); no page ships `needs-work`/`broken`.
- The backend trajectory/logs behind anything the UI triggered.
<!-- END: evidence-and-e2e-mandate -->
