// @vitest-environment node
//
// #11294: scrollback paging. Before, the transcript only scrolled ±1 line
// (Ctrl+Up/Down). Add PgUp/PgDn (page) and Home/End (jump to oldest/newest)
// so long conversations are navigable. Asserts on the actually-rendered visible
// message text via renderContent (the real behavior), driven by real keystrokes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TUI } from "@elizaos/tui";
import { VirtualTerminal } from "@elizaos/tui/testing";
import chalk from "chalk";
import { useStore } from "../lib/store.js";
import { ChatPane } from "./ChatPane.js";

const prevChalkLevel = chalk.level;

function makeChatPane() {
  const terminal = new VirtualTerminal(80, 12);
  const tui = new TUI(terminal);
  return new ChatPane({ onSubmit: async () => {}, tui });
}

// A fresh room with N single-line system messages "MSG-000".."MSG-(N-1)".
function seedMessages(n: number): void {
  useStore.setState({ rooms: [] });
  const room = useStore.getState().createRoom("Main");
  useStore.getState().switchRoom(room.id);
  for (let i = 0; i < n; i++) {
    useStore
      .getState()
      .addMessage(room.id, "system", `MSG-${String(i).padStart(3, "0")}`);
  }
}

beforeEach(() => {
  chalk.level = 0; // deterministic plain text for substring assertions
  seedMessages(30);
});

afterEach(() => {
  chalk.level = prevChalkLevel;
});

describe("chat scrollback paging (#11294)", () => {
  const WIDTH = 80;
  const HEIGHT = 12; // messageAreaHeight = 12 - 6 = 6 visible rows

  test("starts pinned to the newest messages", () => {
    const cp = makeChatPane();
    cp.syncFocus(true);
    const out = cp.renderContent(WIDTH, HEIGHT).join("\n");
    expect(out).toContain("MSG-029");
    expect(out).not.toContain("MSG-000");
  });

  test("Home jumps to the oldest, End back to the newest", () => {
    const cp = makeChatPane();
    cp.syncFocus(true);
    cp.renderContent(WIDTH, HEIGHT); // set dims

    cp.handleInput("\x1b[H"); // Home
    let out = cp.renderContent(WIDTH, HEIGHT).join("\n");
    expect(out).toContain("MSG-000");
    expect(out).not.toContain("MSG-029");

    cp.handleInput("\x1b[F"); // End
    out = cp.renderContent(WIDTH, HEIGHT).join("\n");
    expect(out).toContain("MSG-029");
    expect(out).not.toContain("MSG-000");
  });

  test("PgUp scrolls a page toward older; PgDn returns", () => {
    const cp = makeChatPane();
    cp.syncFocus(true);
    cp.renderContent(WIDTH, HEIGHT);

    cp.handleInput("\x1b[5~"); // PgUp
    const afterPgUp = cp.renderContent(WIDTH, HEIGHT).join("\n");
    // Moved off the newest (a page = height-6-1 = 5 lines up).
    expect(afterPgUp).not.toContain("MSG-029");
    // Header shows a scroll indicator once scrolled.
    expect(afterPgUp).toContain("[↑");

    cp.handleInput("\x1b[6~"); // PgDn
    const afterPgDn = cp.renderContent(WIDTH, HEIGHT).join("\n");
    expect(afterPgDn).toContain("MSG-029");
  });

  test("scrolling is clamped — cannot page past the oldest line", () => {
    const cp = makeChatPane();
    cp.syncFocus(true);
    cp.renderContent(WIDTH, HEIGHT);

    // Many PgUps well beyond the top.
    for (let i = 0; i < 50; i++) cp.handleInput("\x1b[5~");
    const out = cp.renderContent(WIDTH, HEIGHT).join("\n");
    // The very first line is visible and stays put (no blank overscroll).
    expect(out).toContain("MSG-000");
  });
});
