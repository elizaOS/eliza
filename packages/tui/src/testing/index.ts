/**
 * Test-only harness primitives for `@elizaos/tui`, exposed under the
 * `@elizaos/tui/testing` subpath.
 *
 * {@link VirtualTerminal} is a headless `@xterm/headless`-backed implementation
 * of the `Terminal` interface. It lets any TUI host run in a deterministic,
 * cell-accurate terminal grid with no real TTY — drive it with `sendInput`,
 * read it back with `getViewport` / `getScrollBuffer` / `getCursorPosition` /
 * `getCellAttributes`, and capture the raw stream with `getWriteLog`. Intended
 * for tests; not part of the runtime render path.
 */

export { type CellAttributes, VirtualTerminal } from "./virtual-terminal.js";
