import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type AgentRuntime, stringToUuid } from "@elizaos/core";
import { TUI, visibleWidth } from "@elizaos/tui";
import { VirtualTerminal } from "@elizaos/tui/testing";
import { useStore } from "../lib/store.js";
import { ChatPane } from "./ChatPane.js";
import { MainScreen } from "./MainScreen.js";
import { StatusBar } from "./StatusBar.js";
import { TaskPane } from "./TaskPane.js";

// Regression for #11040 / #10830: the cockpit xterm is ~43 cols. At that
// width the eliza-code TUI used to abort every frame — the composer row
// exceeded the terminal width (editor rendered at innerWidth, then wrapped in
// "│ > … │" chrome → width + 1) and fixed footer chrome overflowed too.
// The TUI's final render guard throws when any line's visible width exceeds
// the terminal width (see packages/tui/src/tui.ts: `visibleWidth(line) >
// width`), so an overflow is a hard crash, not a cosmetic glitch.
//
// The narrow-width guarantee has two seams and this suite bites both:
//   * ChatPane renders the editor at innerWidth - 3 so the composer row fits.
//   * MainScreen clips every assembled line via truncateToWidth so fixed-width
//     chrome can never overflow.

const PHONE_COLS = 43;

function makeScreen(cols: number, rows = 24) {
  const terminal = new VirtualTerminal(cols, rows);
  const tui = new TUI(terminal);
  const chatPane = new ChatPane({ onSubmit: async () => {}, tui });
  const statusBar = new StatusBar();
  // TaskPane is not rendered on the default (chat-focused) path; it only needs
  // to satisfy MainScreen's `syncFocus` call, so a runtime is never touched.
  const taskPane = new TaskPane({
    runtime: {} as unknown as AgentRuntime,
    tui,
  });
  const mainScreen = new MainScreen(terminal, statusBar, chatPane, taskPane);
  return { chatPane, mainScreen };
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
        elizaRoomId: stringToUuid("eliza-code-narrow-terminal-test-room"),
      },
    ],
    currentRoomId: "test-room",
    focusedPane: "chat",
    taskPaneVisibility: "hidden",
    inputValue: "",
    isLoading: false,
    isAgentTyping: false,
    pendingSubmissions: [],
  });
}

function plainText(lines: string[]): string {
  return lines.map((line) => stripVTControlCharacters(line)).join("\n");
}

function inputFrameLines(lines: string[]): string[] {
  const topBorderIdx = lines.findIndex((line) => line.includes("┌"));
  expect(topBorderIdx).toBeGreaterThanOrEqual(0);
  const bottomBorderIdx = lines.findIndex(
    (line, index) => index > topBorderIdx && line.includes("└"),
  );
  expect(bottomBorderIdx).toBeGreaterThan(topBorderIdx);
  return lines.slice(topBorderIdx + 1, bottomBorderIdx);
}

function typeIntoChat(chatPane: ChatPane, text: string): void {
  for (const char of text) {
    chatPane.handleInput(char);
  }
}

function addTranscriptMessages(count: number): void {
  const state = useStore.getState();
  for (let i = 1; i <= count; i++) {
    state.addMessage(
      state.currentRoomId,
      "assistant",
      `transcript line ${i.toString().padStart(2, "0")}`,
    );
  }
}

function firstVisibleTranscriptLine(rendered: string): string | undefined {
  return rendered.match(/transcript line \d{2}/)?.[0];
}

// Keep the shared zustand store deterministic across tests.
beforeEach(() => {
  resetChatStore();
});

afterEach(() => {
  resetChatStore();
});

describe("eliza-code TUI at cockpit phone width", () => {
  test("MainScreen never emits a line wider than the terminal (would crash the TUI)", () => {
    const { chatPane, mainScreen } = makeScreen(PHONE_COLS);
    // Chat focused → the help footer renders along with real message content,
    // so both child layout and MainScreen clipping are exercised.
    chatPane.syncFocus(true);
    const state = useStore.getState();
    state.addMessage(
      state.currentRoomId,
      "system",
      "Booting eliza-code interactive session on Eliza Cloud and attaching to the cockpit terminal.",
    );
    state.setInputValue(
      "please refactor the extremely long identifier names in this module now",
    );

    let lines: string[] = [];
    expect(() => {
      lines = mainScreen.render(PHONE_COLS);
    }).not.toThrow();

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Exactly the invariant the TUI render guard enforces before it throws.
      expect(visibleWidth(line)).toBeLessThanOrEqual(PHONE_COLS);
    }
  });

  test.each([
    39, 43, 47, 60,
  ])("MainScreen output fits within %i columns", (cols: number) => {
    const { chatPane, mainScreen } = makeScreen(cols);
    chatPane.syncFocus(true);
    const lines = mainScreen.render(cols);
    const widest = Math.max(...lines.map(visibleWidth));
    expect(widest).toBeLessThanOrEqual(cols);
  });

  test("ChatPane composer row fits inside the terminal width", () => {
    const { chatPane } = makeScreen(PHONE_COLS);
    chatPane.syncFocus(true);
    const lines = chatPane.renderContent(PHONE_COLS, 24);

    // The composer row is the line directly under the editor's top border.
    // Match glyphs directly (they survive the surrounding SGR color codes) so
    // no control-character ANSI-stripping regex is needed.
    const topBorderIdx = lines.findIndex((l) => l.includes("┌"));
    expect(topBorderIdx).toBeGreaterThanOrEqual(0);
    const composer = lines[topBorderIdx + 1];
    expect(composer).toContain(">");

    // Without the innerWidth - 3 fix this row is width + 1 (44) and the TUI
    // aborts; with the fix it is width - 2 (41).
    expect(visibleWidth(composer)).toBeLessThanOrEqual(PHONE_COLS);
  });

  test("ChatPane renders multiple visible composer rows without overflowing", () => {
    const { chatPane } = makeScreen(PHONE_COLS);
    chatPane.syncFocus(true);

    typeIntoChat(chatPane, "first line\nsecond line\nthird line");

    const lines = chatPane.renderContent(PHONE_COLS, 24);
    const composerLines = inputFrameLines(lines);
    const composerText = plainText(composerLines);

    expect(composerLines.length).toBeGreaterThanOrEqual(3);
    expect(composerText).toContain("first line");
    expect(composerText).toContain("second line");
    expect(composerText).toContain("third line");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(PHONE_COLS);
    }
  });

  test("ChatPane supports page and edge scrollback keys", () => {
    const { chatPane } = makeScreen(80, 18);
    chatPane.syncFocus(true);
    addTranscriptMessages(28);

    const bottom = plainText(chatPane.renderContent(80, 18));
    expect(bottom).toContain("transcript line 28");

    chatPane.handleInput("\x1b[5~"); // PageUp
    const pageUp = plainText(chatPane.renderContent(80, 18));
    expect(pageUp).toContain("[↑ ");
    expect(firstVisibleTranscriptLine(pageUp)).not.toBe(
      firstVisibleTranscriptLine(bottom),
    );

    chatPane.handleInput("\x1b[H"); // Home
    const top = plainText(chatPane.renderContent(80, 18));
    expect(top).toContain("transcript line 01");

    chatPane.handleInput("\x1b[F"); // End
    const backAtBottom = plainText(chatPane.renderContent(80, 18));
    expect(backAtBottom).toContain("transcript line 28");
    expect(backAtBottom).not.toContain("[↑ ");
  });

  test("ChatPane keeps the visible scrollback viewport pinned while new messages arrive", () => {
    const { chatPane } = makeScreen(80, 18);
    chatPane.syncFocus(true);
    addTranscriptMessages(28);
    chatPane.renderContent(80, 18);

    chatPane.handleInput("\x1b[5~"); // PageUp
    const beforeAppend = plainText(chatPane.renderContent(80, 18));
    const firstBeforeAppend = firstVisibleTranscriptLine(beforeAppend);
    expect(firstBeforeAppend).toBeDefined();

    const state = useStore.getState();
    state.addMessage(state.currentRoomId, "assistant", "transcript line 29");
    state.addMessage(state.currentRoomId, "assistant", "transcript line 30");

    const afterAppend = plainText(chatPane.renderContent(80, 18));
    expect(firstVisibleTranscriptLine(afterAppend)).toBe(firstBeforeAppend);
    expect(afterAppend).not.toContain("transcript line 30");
    expect(afterAppend).toContain("[↑ ");
  });

  test("ChatPane loading row advertises abort without overflowing narrow terminals", () => {
    const { chatPane } = makeScreen(PHONE_COLS);
    chatPane.syncFocus(true);
    useStore.getState().setLoading(true);

    const phoneLines = chatPane.renderContent(PHONE_COLS, 24);
    const phoneLoading = phoneLines.find((line) => line.includes("Processing"));
    expect(phoneLoading).toBeDefined();
    expect(visibleWidth(phoneLoading ?? "")).toBeLessThanOrEqual(PHONE_COLS);

    const wideLines = chatPane.renderContent(80, 24);
    const wideLoading = wideLines.find((line) => line.includes("Processing"));
    expect(wideLoading).toContain("Esc/Ctrl+C abort");
    expect(visibleWidth(wideLoading ?? "")).toBeLessThanOrEqual(80);
  });

  test("ChatPane keeps the type-ahead composer visible while a turn is running", () => {
    const { chatPane } = makeScreen(PHONE_COLS);
    chatPane.syncFocus(true);
    useStore.getState().setLoading(true);

    // Typing during the turn (queue-and-send) must be visible, not swallowed
    // behind the "Processing" row.
    typeIntoChat(chatPane, "queued follow-up");

    const lines = chatPane.renderContent(PHONE_COLS, 24);
    const rendered = plainText(lines);
    expect(plainText(inputFrameLines(lines))).toContain("queued follow-up");
    expect(rendered).not.toContain("Processing...");
    expect(rendered).toContain("Enter: queue");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(PHONE_COLS);
    }
  });

  test("ChatPane loading row shows the queued-submission count", () => {
    const { chatPane } = makeScreen(80);
    chatPane.syncFocus(true);
    useStore.getState().setLoading(true);
    useStore.setState({ pendingSubmissions: ["next thing", "and another"] });

    const wideLines = chatPane.renderContent(80, 24);
    const wideLoading = wideLines.find((line) => line.includes("Processing"));
    expect(wideLoading).toContain("2 queued");

    // Narrow terminals clip the suffix instead of overflowing (#11043 guard).
    const phoneLines = chatPane.renderContent(PHONE_COLS, 24);
    for (const line of phoneLines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(PHONE_COLS);
    }
  });

  test("ChatPane uses the TUI loader while the assistant is typing", () => {
    const { chatPane } = makeScreen(PHONE_COLS);
    chatPane.syncFocus(true);
    useStore.getState().setAgentTyping(true);

    try {
      const lines = chatPane.renderContent(PHONE_COLS, 24);
      const loaderLine = lines.find((line) =>
        line.includes("Processing (Esc/Ctrl+C abort)"),
      );
      expect(loaderLine).toBeDefined();
      expect(lines.join("\n")).not.toContain("Eliza typing");
      expect(visibleWidth(loaderLine ?? "")).toBeLessThanOrEqual(PHONE_COLS);
    } finally {
      useStore.getState().setAgentTyping(false);
      chatPane.renderContent(PHONE_COLS, 24);
      chatPane.dispose();
    }
  });

  test("ChatPane renders tool transcript lines without overflowing narrow terminals", () => {
    const { chatPane } = makeScreen(PHONE_COLS);
    chatPane.syncFocus(true);
    useStore
      .getState()
      .addMessage(
        useStore.getState().currentRoomId,
        "system",
        "edit src/foo.ts +12/-3",
        undefined,
        "tool",
      );

    const lines = chatPane.renderContent(PHONE_COLS, 24);
    const toolLine = lines.find((line) => line.includes("edit src/foo.ts"));
    expect(toolLine).toBeDefined();
    expect(toolLine).not.toContain("Eliza");
    expect(visibleWidth(toolLine ?? "")).toBeLessThanOrEqual(PHONE_COLS);
  });
});
