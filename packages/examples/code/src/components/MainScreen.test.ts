// Exercises the MainScreen composition contract: input routing between the
// chat and task panes, focus-sync fan-out, the hidden/auto/shown layout
// switch read from the real store, split-width arithmetic, row joining with
// the pane separator, and final-width clipping of overflowing child output.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stringToUuid } from "@elizaos/core";
import { type Terminal, truncateToWidth, visibleWidth } from "@elizaos/tui";
import { useStore } from "../lib/store.js";
import type { ChatPane } from "./ChatPane.js";
import { MainScreen } from "./MainScreen.js";
import type { StatusBar } from "./StatusBar.js";
import type { TaskPane } from "./TaskPane.js";

// Recording collaborators: they only supply deterministic child output so
// every assertion below targets what MainScreen itself does — which child
// receives input, which widths/heights are handed down, how rows are joined
// and clipped.
class RecordingPane {
  focused = true;
  inputs: string[] = [];
  syncFocusCalls: boolean[] = [];
  renderContentCalls: Array<{ width: number; height: number }> = [];
  invalidations = 0;

  constructor(private readonly lines: string[]) {}

  syncFocus(isFocused: boolean): void {
    this.syncFocusCalls.push(isFocused);
  }

  invalidate(): void {
    this.invalidations += 1;
  }

  handleInput(data: string): void {
    this.inputs.push(data);
  }

  renderContent(width: number, height: number): string[] {
    this.renderContentCalls.push({ width, height });
    return [...this.lines];
  }
}

class RecordingStatusBar {
  invalidations = 0;
  renderCalls: number[] = [];

  constructor(private readonly lines: string[]) {}

  invalidate(): void {
    this.invalidations += 1;
  }

  render(width: number): string[] {
    this.renderCalls.push(width);
    return [...this.lines];
  }
}

class FixedRowsTerminal {
  constructor(private readonly _rows: number) {}

  get rows(): number {
    return this._rows;
  }
}

function makeScreen(opts?: {
  rows?: number;
  statusLines?: string[];
  chatLines?: string[];
  taskLines?: string[];
}) {
  const terminal = new FixedRowsTerminal(opts?.rows ?? 24);
  const statusBar = new RecordingStatusBar(opts?.statusLines ?? ["status"]);
  const chatPane = new RecordingPane(opts?.chatLines ?? []);
  const taskPane = new RecordingPane(opts?.taskLines ?? []);
  const mainScreen = new MainScreen(
    terminal as unknown as Terminal,
    statusBar as unknown as StatusBar,
    chatPane as unknown as ChatPane,
    taskPane as unknown as TaskPane,
  );
  return { mainScreen, statusBar, chatPane, taskPane };
}

function resetChatStore(): void {
  useStore.setState({
    rooms: [
      {
        id: "test-room",
        name: "Main",
        messages: [],
        createdAt: new Date(0),
        taskIds: [],
        elizaRoomId: stringToUuid("eliza-code-mainscreen-test-room"),
      },
    ],
    currentRoomId: "test-room",
    focusedPane: "chat",
    taskPaneVisibility: "hidden",
    taskPaneWidthFraction: 0.4,
    inputValue: "",
    isLoading: false,
    isAgentTyping: false,
    pendingSubmissions: [],
    tasks: [],
  });
}

beforeEach(() => {
  resetChatStore();
});

afterEach(() => {
  resetChatStore();
});

describe("MainScreen composition", () => {
  test("starts focused so the root component satisfies Focusable", () => {
    const { mainScreen } = makeScreen();
    expect(mainScreen.focused).toBe(true);
  });

  test("invalidate fans out to the status bar and both panes", () => {
    const { mainScreen, statusBar, chatPane, taskPane } = makeScreen();
    mainScreen.invalidate();
    expect(statusBar.invalidations).toBe(1);
    expect(chatPane.invalidations).toBe(1);
    expect(taskPane.invalidations).toBe(1);

    mainScreen.invalidate();
    expect(statusBar.invalidations).toBe(2);
    expect(chatPane.invalidations).toBe(2);
    expect(taskPane.invalidations).toBe(2);
  });

  test("routes input to the task pane when it holds focus", () => {
    const { mainScreen, chatPane, taskPane } = makeScreen();
    useStore.setState({ focusedPane: "tasks" });

    mainScreen.handleInput("\x1b[5~");
    mainScreen.handleInput("j");

    expect(taskPane.inputs).toEqual(["\x1b[5~", "j"]);
    expect(chatPane.inputs).toEqual([]);
  });

  test("routes input to the chat pane otherwise", () => {
    const { mainScreen, chatPane, taskPane } = makeScreen();
    useStore.setState({ focusedPane: "chat" });

    mainScreen.handleInput("h");
    mainScreen.handleInput("i");

    expect(chatPane.inputs).toEqual(["h", "i"]);
    expect(taskPane.inputs).toEqual([]);
  });

  test("with the task pane hidden, the chat pane renders full width below the status bar", () => {
    const { mainScreen, chatPane, taskPane } = makeScreen({
      rows: 24,
      statusLines: ["STATUS"],
      chatLines: ["chat-a", "chat-b"],
    });
    useStore.setState({ focusedPane: "chat", taskPaneVisibility: "hidden" });

    const lines = mainScreen.render(80);

    expect(lines).toEqual(["STATUS", "chat-a", "chat-b"]);
    expect(chatPane.renderContentCalls).toEqual([{ width: 80, height: 23 }]);
    expect(taskPane.renderContentCalls).toEqual([]);
  });

  test("propagates store focus to both panes on every render", () => {
    const { mainScreen, chatPane, taskPane } = makeScreen();
    useStore.setState({ focusedPane: "chat" });
    mainScreen.render(80);
    expect(chatPane.syncFocusCalls).toEqual([true]);
    expect(taskPane.syncFocusCalls).toEqual([false]);

    useStore.setState({ focusedPane: "tasks" });
    mainScreen.render(80);
    expect(chatPane.syncFocusCalls).toEqual([true, false]);
    expect(taskPane.syncFocusCalls).toEqual([false, true]);
  });

  test("floors the viewport height at one row when the terminal reports zero", () => {
    const { mainScreen, chatPane } = makeScreen({
      rows: 0,
      statusLines: ["S"],
      chatLines: ["c"],
    });
    const lines = mainScreen.render(80);
    expect(lines).toEqual(["S", "c"]);
    expect(chatPane.renderContentCalls).toEqual([{ width: 80, height: 1 }]);
  });

  test("floors the content height at one when the status bar fills the screen", () => {
    const { mainScreen, chatPane } = makeScreen({
      rows: 2,
      statusLines: ["a", "b", "c", "d", "e"],
      chatLines: ["c"],
    });
    mainScreen.render(80);
    expect(chatPane.renderContentCalls).toEqual([{ width: 80, height: 1 }]);
  });

  test("hands the full terminal width to the status bar on every render", () => {
    const { mainScreen, statusBar } = makeScreen();
    mainScreen.render(100);
    mainScreen.render(72);
    expect(statusBar.renderCalls).toEqual([100, 72]);
  });

  test("with the task pane shown, splits columns by the stored fraction and joins rows with the separator", () => {
    const { mainScreen, chatPane, taskPane } = makeScreen({
      statusLines: ["S"],
      chatLines: ["left-1", "left-2", "left-3"],
      taskLines: ["right-1"],
    });
    useStore.setState({
      focusedPane: "chat",
      taskPaneVisibility: "shown",
      taskPaneWidthFraction: 0.4,
    });

    const lines = mainScreen.render(100);

    // taskW = max(18, min(floor(100 * 0.4), 100 - 22)) = 40
    // chatW = max(18, 100 - 40 - 1) = 59
    expect(chatPane.renderContentCalls).toEqual([{ width: 59, height: 23 }]);
    expect(taskPane.renderContentCalls).toEqual([{ width: 40, height: 23 }]);
    // Row count is the taller pane; the shorter side is padded with "".
    expect(lines).toEqual(["S", "left-1│right-1", "left-2│", "left-3│"]);
  });

  test("pads the chat side when the task pane is taller", () => {
    const { mainScreen } = makeScreen({
      statusLines: ["S"],
      chatLines: ["L"],
      taskLines: ["R1", "R2", "R3"],
    });
    useStore.setState({ focusedPane: "chat", taskPaneVisibility: "shown" });

    const lines = mainScreen.render(100);

    expect(lines).toEqual(["S", "L│R1", "│R2", "│R3"]);
  });

  test("clamps the task pane to an 18-column minimum on narrow terminals", () => {
    const { mainScreen, chatPane, taskPane } = makeScreen({
      statusLines: ["S"],
    });
    useStore.setState({ focusedPane: "chat", taskPaneVisibility: "shown" });

    mainScreen.render(40);

    // floor(40 * 0.4) = 16 < 18, so the minimum wins; chat keeps 40 - 18 - 1.
    expect(chatPane.renderContentCalls).toEqual([{ width: 21, height: 23 }]);
    expect(taskPane.renderContentCalls).toEqual([{ width: 18, height: 23 }]);
  });

  test("caps the task pane so the chat pane keeps its share on wide terminals", () => {
    const { mainScreen, chatPane, taskPane } = makeScreen({
      statusLines: ["S"],
    });
    useStore.setState({
      focusedPane: "chat",
      taskPaneVisibility: "shown",
      taskPaneWidthFraction: 0.75,
    });

    mainScreen.render(60);

    // floor(60 * 0.75) = 45 exceeds the 60 - 22 cap, so 38 wins.
    expect(chatPane.renderContentCalls).toEqual([{ width: 21, height: 23 }]);
    expect(taskPane.renderContentCalls).toEqual([{ width: 38, height: 23 }]);
  });

  test("takes the split path under auto visibility when the task pane holds focus", () => {
    const { mainScreen, chatPane, taskPane } = makeScreen({
      statusLines: ["S"],
    });
    useStore.setState({ focusedPane: "tasks", taskPaneVisibility: "auto" });

    mainScreen.render(100);

    expect(taskPane.renderContentCalls.length).toBe(1);
    expect(chatPane.renderContentCalls.length).toBe(1);
  });

  test("clips assembled split rows back to the terminal width", () => {
    const longLeft = "x".repeat(30);
    const longRight = "y".repeat(30);
    const { mainScreen } = makeScreen({
      statusLines: ["S"],
      chatLines: [longLeft],
      taskLines: [longRight],
    });
    useStore.setState({ focusedPane: "chat", taskPaneVisibility: "shown" });

    const lines = mainScreen.render(43);

    // taskW = 18, chatW = 24 on a 43-column terminal; the joined row overflows
    // and must come back exactly truncateToWidth-clipped, never wider.
    expect(lines[1]).toBe(truncateToWidth(`${longLeft}│${longRight}`, 43));
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(43);
    }
  });

  test("clips single-pane output too when the chat pane overflows", () => {
    const longLine = "z".repeat(25);
    const { mainScreen } = makeScreen({
      statusLines: [],
      chatLines: [longLine],
    });
    useStore.setState({ focusedPane: "chat", taskPaneVisibility: "hidden" });

    const lines = mainScreen.render(10);

    expect(lines).toEqual([truncateToWidth(longLine, 10)]);
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(10);
  });
});
