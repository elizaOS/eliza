import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRuntime } from "@elizaos/core";
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
// "│ > … │" chrome → width + 1) and the 47-col help footer overflowed too.
// The TUI's final render guard throws when any line's visible width exceeds
// the terminal width (see packages/tui/src/tui.ts: `visibleWidth(line) >
// width`), so an overflow is a hard crash, not a cosmetic glitch.
//
// The fix has two seams and this suite bites both:
//   * ChatPane renders the editor at innerWidth - 3 so the composer row fits.
//   * MainScreen clips every assembled line via truncateToWidth so fixed-width
//     chrome (the 47-col footer) can never overflow.

const PHONE_COLS = 43;

function makeScreen(cols: number) {
  const terminal = new VirtualTerminal(cols, 24);
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

// Keep the shared zustand store deterministic across tests.
afterEach(() => {
  useStore.getState().setInputValue("");
  useStore.getState().setLoading(false);
});

describe("eliza-code TUI at cockpit phone width", () => {
  test("MainScreen never emits a line wider than the terminal (would crash the TUI)", () => {
    const { chatPane, mainScreen } = makeScreen(PHONE_COLS);
    // Chat focused → the full 47-col help footer renders (the fixed-width
    // overflow the clip seam guards). Add a long message so the message area
    // has real content too.
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
  ])("MainScreen output fits within %i columns", (cols) => {
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
