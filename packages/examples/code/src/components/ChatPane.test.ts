// @vitest-environment node
//
// Unit coverage for the ChatPane public surface (submit pipeline, input
// routing, scrollback edges, transcript line building, composer visibility and
// the help line). Drives the real component over the VirtualTerminal + TUI +
// zustand store harness — no mocked collaborators. Complements the sibling
// suites (scrollback paging, polish, markdown, narrow-terminal), which own
// those behaviors; cases here pin the branches they do not.

import { TUI, visibleWidth } from "@elizaos/tui";
import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useStore } from "../lib/store.js";
import { VirtualTerminal } from "../testing/virtual-terminal.test.js";
import type { Message } from "../types.js";
import { ChatPane } from "./ChatPane.js";

const prevChalkLevel = chalk.level;

function makeChatPane(onSubmit: (text: string) => Promise<void>) {
  const terminal = new VirtualTerminal(80, 12);
  const tui = new TUI(terminal);
  return new ChatPane({ onSubmit, tui });
}

const noopSubmit = async () => {};

// The tui Editor inlines a reverse-video cursor marker (SGR + an OSC wrapper)
// into rendered composer rows; strip both for plain-text assertions. Patterns
// are built from char codes the same way ChatPane builds its SGR pattern.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const OSC_PATTERN = new RegExp(`${ESC}_[^${BEL}]*${BEL}`, "g");

function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "").replace(OSC_PATTERN, "");
}

// Plain single-spaced text of a rendered frame (ANSI stripped; the composer
// row concatenates the "> " prompt, editor padding, and draft text).
function plainText(s: string): string {
  return stripAnsi(s).replace(/\s+/g, " ");
}

function editorOf(cp: ChatPane): { getText(): string } {
  return (cp as unknown as { editor: { getText(): string } }).editor;
}

function typeText(cp: ChatPane, text: string): void {
  for (const ch of text) cp.handleInput(ch);
}

// Fresh singleton-store room (a sibling file may have left rooms:[] behind);
// returns the room id so handcrafted messages can target it.
function seedRoom(name = "Main"): string {
  useStore.setState({
    rooms: [],
    isLoading: false,
    isAgentTyping: false,
    pendingSubmissions: [],
    inputValue: "",
  });
  const room = useStore.getState().createRoom(name);
  useStore.getState().switchRoom(room.id);
  return room.id;
}

// Same formatting ChatPane applies to message timestamps.
function fmt(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

beforeEach(() => {
  chalk.level = 0; // deterministic plain text for substring assertions
  seedRoom();
});

afterEach(() => {
  chalk.level = prevChalkLevel;
  useStore.setState({
    rooms: [],
    isLoading: false,
    isAgentTyping: false,
    pendingSubmissions: [],
  });
  useStore.getState().setInputValue("");
});

describe("ChatPane composer", () => {
  test("typing while unfocused is ignored", () => {
    const cp = makeChatPane(noopSubmit);
    typeText(cp, "should not land");
    expect(editorOf(cp).getText()).toBe("");
    expect(useStore.getState().inputValue).toBe("");
  });

  test("submit trims the draft, delivers it, and clears the composer", async () => {
    const submitted: string[] = [];
    const cp = makeChatPane(async (text) => {
      submitted.push(text);
    });
    cp.syncFocus(true);

    typeText(cp, "  hello world  ");
    expect(useStore.getState().inputValue).toBe("  hello world  ");
    cp.handleInput("\r");
    await Promise.resolve();

    expect(submitted).toEqual(["hello world"]);
    expect(editorOf(cp).getText()).toBe("");
    expect(useStore.getState().inputValue).toBe("");
  });

  test("whitespace-only drafts are not submitted", async () => {
    const submitted: string[] = [];
    const cp = makeChatPane(async (text) => {
      submitted.push(text);
    });
    cp.syncFocus(true);

    typeText(cp, "   ");
    cp.handleInput("\r");
    await Promise.resolve();

    expect(submitted).toEqual([]);
    // The Editor clears itself on Enter even when ChatPane's guard rejects
    // the blank draft (nothing reaches history or onSubmit).
    expect(editorOf(cp).getText()).toBe("");
  });

  test("escape clears the draft and mirrors it to the store", () => {
    const cp = makeChatPane(noopSubmit);
    cp.syncFocus(true);

    typeText(cp, "draft");
    cp.handleInput("\x1b");

    expect(editorOf(cp).getText()).toBe("");
    expect(useStore.getState().inputValue).toBe("");
  });
});

describe("ChatPane scrollback routing", () => {
  function seedThirtyLines(): void {
    const roomId = seedRoom();
    for (let i = 0; i < 30; i++) {
      useStore
        .getState()
        .addMessage(roomId, "system", `MSG-${String(i).padStart(3, "0")}`);
    }
  }

  test("ctrl+up / ctrl+down scroll the transcript one line at a time", () => {
    seedThirtyLines();
    const cp = makeChatPane(noopSubmit);
    cp.syncFocus(true);
    const outAtBottom = cp.renderContent(80, 12).join("\n");
    expect(outAtBottom).toContain("MSG-029");
    expect(outAtBottom).not.toContain("[↑");

    cp.handleInput("\x1b[1;5A"); // ctrl+up
    const outUp = cp.renderContent(80, 12).join("\n");
    expect(outUp).toContain("[↑ 1]");
    expect(outUp).not.toContain("MSG-029");
    expect(outUp).toContain("MSG-028");

    cp.handleInput("\x1b[1;5B"); // ctrl+down
    const outDown = cp.renderContent(80, 12).join("\n");
    expect(outDown).toContain("MSG-029");
    expect(outDown).not.toContain("[↑");
  });

  test("home/end reach the editor, not scrollback, while the composer has text", () => {
    seedThirtyLines();
    const cp = makeChatPane(noopSubmit);
    cp.syncFocus(true);
    typeText(cp, "abc");

    cp.handleInput("\x1b[H"); // Home
    let out = plainText(cp.renderContent(80, 12).join("\n"));
    expect(out).toContain("MSG-029"); // stayed pinned to the newest
    expect(out).not.toContain("MSG-000"); // did not jump to the oldest
    expect(out).toContain("> abc"); // composer untouched

    cp.handleInput("\x1b[F"); // End
    out = plainText(cp.renderContent(80, 12).join("\n"));
    expect(out).toContain("MSG-029");
    expect(out).toContain("> abc");
  });
});

describe("ChatPane transcript rendering", () => {
  test("user and assistant messages carry speaker + clock headers", () => {
    const roomId = seedRoom();
    const user = useStore.getState().addMessage(roomId, "user", "ping");
    const agent = useStore.getState().addMessage(roomId, "assistant", "pong");
    const cp = makeChatPane(noopSubmit);
    cp.syncFocus(true);

    const out = cp.renderContent(100, 30).join("\n");
    expect(out).toContain(`You ${fmt(user.timestamp)}`);
    expect(out).toContain(`Eliza ${fmt(agent.timestamp)}`);
  });

  test("an invalid timestamp renders the bare speaker header", () => {
    const roomId = seedRoom();
    const ghost: Message = {
      id: "msg-invalid-ts",
      role: "user",
      content: "ghost line",
      timestamp: new Date("not-a-date"),
      roomId,
    };
    useStore.setState({
      rooms: [{ ...useStore.getState().getCurrentRoom(), messages: [ghost] }],
    });
    const cp = makeChatPane(noopSubmit);
    cp.syncFocus(true);

    const out = cp.renderContent(100, 30).join("\n");
    expect(out).toContain("You");
    expect(out).toContain("ghost line");
    expect(out).not.toMatch(/You \d/); // no clock time after the speaker
  });

  test("tool and system messages render without a speaker header", () => {
    const roomId = seedRoom();
    useStore
      .getState()
      .addMessage(roomId, "system", "TOOL-RAN-OK", undefined, "tool");
    useStore.getState().addMessage(roomId, "system", "SYS-NOTE-LINE");
    const cp = makeChatPane(noopSubmit);
    cp.syncFocus(true);

    const out = cp.renderContent(100, 30).join("\n");
    expect(out).toContain("TOOL-RAN-OK");
    expect(out).toContain("SYS-NOTE-LINE");
    expect(out).not.toContain("You ");
    expect(out).not.toContain("Eliza ");
  });

  test("an empty room shows the placeholder; a missing room shows Chat: Unknown", () => {
    seedRoom("Lobby");
    const cp = makeChatPane(noopSubmit);
    cp.syncFocus(true);

    let out = cp.renderContent(80, 12).join("\n");
    expect(out).toContain("Chat: Lobby");
    expect(out).toContain("(0)");
    expect(out).toContain("No messages.");

    useStore.setState({ currentRoomId: "no-such-room" });
    out = cp.renderContent(80, 12).join("\n");
    expect(out).toContain("Chat: Unknown");
    expect(out).toContain("No messages.");
  });

  test("markdown kicks in at a 40-column body; narrower falls back to plain wrap", () => {
    seedRoom();
    useStore
      .getState()
      .addMessage(
        useStore.getState().currentRoomId,
        "assistant",
        "# Title\n\nPlain body.",
      );
    const wide = makeChatPane(noopSubmit); // body width (46-4)-2 = 40
    const narrow = makeChatPane(noopSubmit); // body width (45-4)-2 = 39
    wide.syncFocus(true);
    narrow.syncFocus(true);

    const wideOut = wide.renderContent(46, 24).join("\n");
    expect(wideOut).toContain("Title");
    expect(wideOut).not.toContain("# Title"); // markdown marker consumed

    const narrowOut = narrow.renderContent(45, 24).join("\n");
    expect(narrowOut).toContain("# Title"); // verbatim plain text
  });
});

describe("ChatPane turn state", () => {
  test("loading hides the composer, queues report their depth, typing-ahead restores the composer", () => {
    seedRoom();
    const cp = makeChatPane(noopSubmit);
    cp.syncFocus(true);

    useStore.getState().setLoading(true);
    useStore.getState().enqueuePendingSubmission("first");
    useStore.getState().enqueuePendingSubmission("second");
    let out = cp.renderContent(80, 12).join("\n");
    expect(out).toContain("Processing... Esc/Ctrl+C abort • 2 queued");
    expect(out).not.toContain("> ");

    // Typing ahead (queue-and-send) keeps the composer visible instead.
    typeText(cp, "follow-up");
    out = plainText(cp.renderContent(80, 12).join("\n"));
    expect(out).toContain("> follow-up");
    expect(out).not.toContain("Processing...");

    useStore.getState().setLoading(false);
    out = plainText(cp.renderContent(80, 12).join("\n"));
    expect(out).toContain("> follow-up");
    expect(out).not.toContain("• 2 queued");
  });

  test("the help line reflects focus, loading, and slash-command state", () => {
    seedRoom();
    const cp = makeChatPane(noopSubmit);

    let out = cp.renderContent(80, 12).join("\n");
    expect(out).toContain("Tab: focus");

    cp.syncFocus(true);
    out = cp.renderContent(80, 12).join("\n");
    expect(out).toContain("Enter: send");

    useStore.getState().setLoading(true);
    out = cp.renderContent(80, 12).join("\n");
    expect(out).toContain("Enter: queue");

    useStore.getState().setLoading(false);
    useStore.getState().setInputValue("/deploy");
    out = cp.renderContent(80, 12).join("\n");
    expect(out).toContain("Enter: run");
  });

  test("dispose stops the typing loader and rendering keeps working", () => {
    seedRoom();
    useStore
      .getState()
      .addMessage(useStore.getState().currentRoomId, "assistant", "still here");
    const cp = makeChatPane(noopSubmit);
    cp.syncFocus(true);

    useStore.getState().setAgentTyping(true);
    let out = cp.renderContent(80, 12).join("\n");
    expect(out).toContain("Processing");

    cp.dispose();
    useStore.getState().setAgentTyping(false);
    out = cp.renderContent(80, 12).join("\n");
    expect(out).toContain("still here");
    expect(out).not.toContain("Processing");
  });
});

describe("ChatPane composer overflow", () => {
  test("a tall draft is windowed around the cursor without overflowing", () => {
    seedRoom();
    const cp = makeChatPane(noopSubmit);
    cp.syncFocus(true);

    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    typeText(cp, lines.join("\n"));
    const out = cp.renderContent(80, 20).join("\n");

    // Cursor sits after the last line, so the tail stays visible…
    expect(out).toContain("L10");
    // …the composer is capped at its configured maximum…
    const composerRows = out
      .split("\n")
      .filter((line) => line.startsWith("│")).length;
    expect(composerRows).toBeLessThanOrEqual(6);
    // …and nothing exceeds the pane width.
    for (const line of out.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});
