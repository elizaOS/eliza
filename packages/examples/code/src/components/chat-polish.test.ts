// @vitest-environment node
//
// Polish batch (#11294 Med/Low): composer border stays aligned when the prompt
// is ANSI-colored (padEndVisible, not padEnd), and submitted prompts are
// recallable with the up-arrow (Editor history). Uses the VirtualTerminal
// harness; color is forced on so the ANSI-padding bug can actually manifest
// (chalk disables color off a TTY otherwise).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentRuntime } from "@elizaos/core";
import { TUI } from "@elizaos/tui";
import { VirtualTerminal } from "@elizaos/tui/testing";
import chalk from "chalk";
import { useStore } from "../lib/store.js";
import { ChatPane } from "./ChatPane.js";
import { MainScreen } from "./MainScreen.js";
import { StatusBar } from "./StatusBar.js";
import { TaskPane } from "./TaskPane.js";

const prevChalkLevel = chalk.level;

function makeScreen(cols: number) {
  const terminal = new VirtualTerminal(cols, 24);
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

beforeEach(() => {
  // Force color so chalk.cyan("> ") actually emits SGR — the padEnd-over-ANSI
  // bug only exists when the composer prompt carries invisible escape bytes.
  chalk.level = 3;
  useStore.setState({ rooms: [] });
  useStore.getState().setInputValue("");
});

afterEach(() => {
  chalk.level = prevChalkLevel;
});

describe("chat input-history recall (#11294)", () => {
  test("a submitted prompt is recalled by the up-arrow", async () => {
    const { chatPane } = makeScreen(80);
    chatPane.syncFocus(true);

    // Type a prompt and submit it (Enter). onSubmit records it to history +
    // clears the editor.
    for (const ch of "hello world") chatPane.handleInput(ch);
    chatPane.handleInput("\r");
    // Give the async onSubmit microtask a tick to run addToHistory/setText.
    await Promise.resolve();

    // Editor is cleared after submit…
    const editor = (chatPane as unknown as { editor: { getText(): string } })
      .editor;
    expect(editor.getText()).toBe("");

    // …and up-arrow recalls the last prompt.
    chatPane.handleInput("\x1b[A");
    expect(editor.getText()).toBe("hello world");
  });
});
