// @vitest-environment node
//
// #11294: assistant replies render as real markdown (bold, fenced code) via
// @elizaos/tui's Markdown component at usable widths, and fall back to plain
// wrapped text on narrow terminals (the ~43-col cockpit xterm) so the #11043
// overflow guarantee holds. Uses the same VirtualTerminal harness as
// narrow-terminal.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentRuntime } from "@elizaos/core";
import { TUI, visibleWidth } from "@elizaos/tui";
import { VirtualTerminal } from "@elizaos/tui/testing";
import chalk from "chalk";
import { useStore } from "../lib/store.js";
import { ChatPane } from "./ChatPane.js";
import { MainScreen } from "./MainScreen.js";
import { StatusBar } from "./StatusBar.js";
import { TaskPane } from "./TaskPane.js";

function makeScreen(cols: number) {
  const terminal = new VirtualTerminal(cols, 40);
  const tui = new TUI(terminal);
  const chatPane = new ChatPane({ onSubmit: async () => {}, tui });
  const statusBar = new StatusBar();
  const taskPane = new TaskPane({
    runtime: {} as unknown as AgentRuntime,
    tui,
  });
  const mainScreen = new MainScreen(terminal, statusBar, chatPane, taskPane);
  return { chatPane, mainScreen };
}

const prevChalkLevel = chalk.level;

beforeEach(() => {
  // Pin color OFF: this suite asserts markdown MARKER consumption (# / ** /
  // backticks stripped), which is color-independent. Forcing level 0 makes the
  // substring assertions ("const x = 1;") stable regardless of any chalk.level
  // another test file leaked (syntax highlighting inserts SGR mid-token).
  chalk.level = 0;
  // The store is a cross-file singleton; a sibling test file may have left it
  // with rooms:[] (dangling currentRoomId). Establish our own fresh room so
  // addMessage(currentRoomId, …) actually lands.
  useStore.setState({ rooms: [] });
  const room = useStore.getState().createRoom("Main");
  useStore.getState().switchRoom(room.id);
});

afterEach(() => {
  chalk.level = prevChalkLevel;
  useStore.setState({ rooms: [] });
  useStore.getState().setInputValue("");
});

describe("eliza-code chat markdown rendering (#11294)", () => {
  const MD_BODY =
    "# Title\n\nHere is **bold** and `inline code`:\n\n```ts\nconst x = 1;\n```";

  test("renders assistant replies through the markdown component at a usable width", () => {
    const { chatPane, mainScreen } = makeScreen(100);
    chatPane.syncFocus(true);
    const state = useStore.getState();
    state.addMessage(state.currentRoomId, "assistant", MD_BODY);

    const lines = mainScreen.render(100);
    const joined = lines.join("\n");
    // Content survives.
    expect(joined).toContain("const x = 1;");
    // Inline markdown markers are consumed (was flat raw text before): the
    // heading "#", the bold "**", and the inline-code backticks are stripped
    // — in a real TTY the runs are also colored via the chalk theme (color is
    // disabled in this non-TTY test env, so we assert the marker-stripping,
    // which is environment-independent).
    expect(joined).toContain("Title");
    expect(joined).not.toContain("# Title");
    expect(joined).toContain("bold");
    expect(joined).not.toContain("**bold**");
    expect(joined).toContain("inline code");
    expect(joined).not.toContain("`inline code`");
    // Overflow invariant still holds.
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(100);
    }
  });

  test("falls back to plain wrap on a narrow (cockpit phone) terminal", () => {
    const { chatPane, mainScreen } = makeScreen(43);
    chatPane.syncFocus(true);
    const state = useStore.getState();
    state.addMessage(state.currentRoomId, "assistant", MD_BODY);

    const lines = mainScreen.render(43);
    // No crash + width invariant (the #11043 guarantee) — the whole point of
    // the narrow-width fallback.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(43);
    }
  });
});
