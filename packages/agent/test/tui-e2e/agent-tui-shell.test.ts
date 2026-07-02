/**
 * Whole-app TUI e2e: drives the real agent terminal shell through a
 * `VirtualTerminal` (real `@xterm/headless` emulation) and asserts against the
 * rendered grid — viewport text, cursor position, and inverse-video focus —
 * instead of a regex-stripped fake terminal. This is the grid-level complement
 * to the route-contract coverage in `plugin-tui-view-coverage.test.ts`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Component,
  listTerminalViewIds,
  registerTerminalView,
  type TerminalViewMountOptions,
  truncateToWidth,
} from "@elizaos/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAutonomousCli } from "../../src/cli/index.ts";
import {
  assertWidthContract,
  bootShell,
  chatRoutes,
  drive,
  inverseRuns,
  KEYS,
  okViewRoutes,
  type RecordedCall,
  type StubRoute,
  screenText,
  serializeSnapshot,
  type,
  viewport,
  viewsRoute,
} from "./harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures");

/** Track registered views so the process-global registry stays clean. */
const cleanups: Array<() => void> = [];
function register(
  id: string,
  component: Component,
  factory?: (options?: TerminalViewMountOptions) => Component,
): void {
  cleanups.push(registerTerminalView(id, component, factory));
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function commandsRoute(commands: unknown[]): StubRoute {
  return {
    match: (url) => url.includes("/api/commands?surface=tui"),
    respond: () => ({ commands, surface: "tui", agentId: null }),
  };
}

function staticView(lines: string[]): Component {
  return {
    render: (width) => lines.map((line) => truncateToWidth(line, width)),
    handleInput: () => {},
    invalidate: () => {},
  };
}

/** Compare a frame against a committed golden fixture (UPDATE_TUI_SNAPSHOTS=1 rewrites). */
function expectGoldenFrame(name: string, actual: string): void {
  const file = join(fixtureDir, `${name}.snap`);
  if (process.env.UPDATE_TUI_SNAPSHOTS === "1") {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  let expected: string;
  try {
    expected = readFileSync(file, "utf8");
  } catch {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(file, actual);
    expected = actual;
  }
  expect(actual).toBe(expected);
}

describe("agent terminal tui — whole-app e2e (real terminal grid)", () => {
  it("boots: lists views in the grid with the composer pinned to the bottom rows", async () => {
    register("wallet", staticView(["WALLET BODY"]));
    const { terminal } = await bootShell({
      routes: [
        viewsRoute([
          { id: "messages", label: "Messages TUI" },
          { id: "wallet", label: "Wallet TUI" },
        ]),
      ],
    });

    const lines = viewport(terminal);
    const text = lines.join("\n");
    expect(text).toContain("elizaOS terminal tui");
    expect(text).toContain("1. Messages TUI");
    expect(text).toContain("2. Wallet TUI");

    // The composer block is pinned below the registered-views list.
    const listRow = lines.findIndex((l) => l.includes("registered tui views"));
    const chatRow = lines.findIndex((l) => l.startsWith("chat"));
    expect(listRow).toBeGreaterThanOrEqual(0);
    expect(chatRow).toBeGreaterThan(listRow);

    // Width contract holds for every rendered row at 80 columns.
    assertWidthContract(lines, terminal.columns);

    // Byte-stable golden frame (fixed 80x24, stubbed inputs).
    expectGoldenFrame("boot", serializeSnapshot(terminal));
  });

  it("sends chat from the composer while a view is mounted, and renders the sent line", async () => {
    register("wallet", staticView(["WALLET BODY"]));
    const { terminal, calls } = await bootShell({
      routes: [
        viewsRoute([
          { id: "messages", label: "Messages TUI" },
          { id: "wallet", label: "Wallet TUI" },
        ]),
        ...okViewRoutes,
        ...chatRoutes(),
      ],
    });

    // Open wallet via view-block search (composer owns input by default).
    await drive(terminal, [KEYS.CTRL_L, "/"]);
    await type(terminal, "wal");
    expect(screenText(terminal)).toContain("filter: wal");
    await drive(terminal, [KEYS.ENTER]);
    expect(screenText(terminal)).toContain("elizaOS terminal tui · Wallet TUI");
    expect(screenText(terminal)).toContain("WALLET BODY");

    // Focus the composer, type a message, submit.
    await drive(terminal, [KEYS.CTRL_L]);
    await type(terminal, "hello from the terminal");
    await drive(terminal, [KEYS.ENTER]);

    const conversationCall = findCall(calls, (c) =>
      c.url.endsWith("/api/conversations"),
    );
    expect(conversationCall?.body).toMatchObject({
      title: "Terminal session",
      metadata: { source: "terminal-tui" },
    });

    const chatCall = findCall(calls, (c) =>
      c.url.endsWith("/api/conversations/conv-terminal/messages"),
    );
    expect(chatCall?.body).toMatchObject({
      text: "hello from the terminal",
      source: "terminal-tui",
      metadata: { viewId: "wallet", viewType: "tui" },
    });

    // The rendered grid shows the sent line, and the view is still mounted.
    const text = screenText(terminal);
    expect(text).toContain("sent: hello from the terminal");
    expect(text).toContain("WALLET BODY");
  });

  it("bracketed paste round-trips the composer: split chunks render inline, large pastes collapse to a marker but submit the full text", async () => {
    const { terminal, calls } = await bootShell({
      routes: [viewsRoute([]), ...okViewRoutes, ...chatRoutes()],
    });

    // A real terminal delivers a paste in arbitrary chunks: the start marker,
    // content, and end marker can arrive in separate stdin reads. Drive the
    // exact byte sequences ProcessTerminal would forward, split mid-paste, so
    // the editor's pasteBuffer accumulation branch runs — not just the
    // single-chunk happy path.
    await drive(terminal, ["\x1b[200~pasted one ", "and two\x1b[201~"]);
    expect(screenText(terminal)).toContain("pasted one and two");

    await drive(terminal, [KEYS.ENTER]);
    const smallPasteCall = findCall(calls, (c) =>
      c.url.endsWith("/api/conversations/conv-terminal/messages"),
    );
    expect(smallPasteCall?.body).toMatchObject({
      text: "pasted one and two",
      source: "terminal-tui",
    });

    // A >10-line paste must collapse to a "[paste #N +M lines]" marker in the
    // rendered grid (the composer stays compact) while the SUBMITTED text is
    // the full expanded paste — the marker is a display affordance, never data
    // loss.
    const bigLines = Array.from(
      { length: 12 },
      (_, i) => `line-${String(i + 1).padStart(2, "0")}`,
    );
    const bigPaste = bigLines.join("\n");
    await drive(terminal, [`\x1b[200~${bigPaste}\x1b[201~`]);
    const collapsed = screenText(terminal);
    expect(collapsed).toContain("[paste #1 +12 lines]");
    expect(collapsed).not.toContain("line-07");

    await drive(terminal, [KEYS.ENTER]);
    const messageCalls = calls.filter((c) =>
      c.url.endsWith("/api/conversations/conv-terminal/messages"),
    );
    const bigPasteCall = messageCalls[messageCalls.length - 1];
    expect(bigPasteCall?.body).toMatchObject({ text: bigPaste });
  });

  it("quick-opens a registered view inline (digit key) and Esc returns to the list", async () => {
    let renders = 0;
    register("phone", {
      render: (width) => [
        truncateToWidth("LIVE PHONE VIEW", width),
        truncateToWidth(`render #${++renders}`, width),
      ],
      handleInput: () => {},
      invalidate: () => {},
    });
    const { terminal } = await bootShell({
      routes: [
        viewsRoute([{ id: "phone", label: "Phone TUI" }]),
        ...okViewRoutes,
      ],
    });

    expect(screenText(terminal)).toContain("Phone TUI");

    // Digit keys are view-block keybindings → focus the view block first.
    await drive(terminal, [KEYS.CTRL_L, "1"]);
    const open = screenText(terminal);
    expect(open).toContain("LIVE PHONE VIEW");
    expect(open).toContain("chat"); // composer still pinned below

    await drive(terminal, [KEYS.ESC]);
    expect(screenText(terminal)).toContain("registered tui views");
  });

  it("routes a /navigate slash command through the composer and swaps the view in place", async () => {
    register("wallet", staticView(["WALLET BODY"]));
    const { terminal, calls } = await bootShell({
      routes: [
        viewsRoute([{ id: "wallet", label: "Wallet TUI" }]),
        commandsRoute([
          {
            key: "wallet",
            nativeName: "wallet",
            description: "Open the wallet view",
            textAliases: ["/wallet"],
            scope: "both",
            acceptsArgs: false,
            args: [],
            requiresAuth: false,
            requiresElevated: false,
            target: { kind: "navigate", viewId: "wallet" },
          },
        ]),
        ...okViewRoutes,
      ],
    });

    await type(terminal, "/wallet");
    await drive(terminal, [KEYS.ENTER]);

    expect(
      findCall(calls, (c) => c.url.includes("/api/views/wallet/navigate")),
    ).toBeTruthy();
    const text = screenText(terminal);
    expect(text).toContain("elizaOS terminal tui · Wallet TUI");
    expect(text).toContain("WALLET BODY");
  });

  it("code orchestration: opening + activating the task-coordinator view dispatches POST /activate", async () => {
    const activations: string[] = [];
    const factory = (options?: TerminalViewMountOptions): Component => ({
      render: (width) => [
        truncateToWidth("TASK COORDINATOR", width),
        truncateToWidth("[ open-thread ]", width),
      ],
      handleInput: (data) => {
        if (data === KEYS.ENTER) {
          activations.push("open-thread");
          options?.onActivate?.("open-thread");
        }
      },
      invalidate: () => {},
    });
    register("task-coordinator", factory(), factory);

    const { terminal, calls } = await bootShell({
      routes: [
        viewsRoute([{ id: "task-coordinator", label: "Task Coordinator TUI" }]),
        ...okViewRoutes,
      ],
    });

    await drive(terminal, [KEYS.CTRL_L, "1"]);
    expect(screenText(terminal)).toContain("TASK COORDINATOR");

    await drive(terminal, [KEYS.ENTER]);
    expect(activations).toEqual(["open-thread"]);

    const activateCall = findCall(calls, (c) =>
      c.url.includes("/api/views/task-coordinator/activate"),
    );
    expect(activateCall?.body).toMatchObject({ elementId: "open-thread" });
  });

  it("mounts every registered terminal view through the shell and enforces the width contract", async () => {
    // A representative spread: plain single-line, multi-line, and a wide line
    // that the view must truncate to the terminal width itself.
    register("alpha", staticView(["ALPHA VIEW"]));
    register(
      "bravo",
      staticView(["BRAVO line 1", "BRAVO line 2", "BRAVO line 3"]),
    );
    register("charlie", staticView(["C".repeat(200)])); // must be truncated to width
    const ids = ["alpha", "bravo", "charlie"];

    for (const width of [80, 56, 40]) {
      // Every id the registry reports must mount and obey the width contract at
      // this terminal width.
      for (const id of ids) {
        expect(listTerminalViewIds()).toContain(id);
        const { terminal, handle } = await bootShell({
          routes: [
            viewsRoute(ids.map((v) => ({ id: v, label: `${v} TUI` }))),
            ...okViewRoutes,
          ],
          columns: width,
        });
        // Open this view by id via search filter, then assert it rendered.
        await drive(terminal, [KEYS.CTRL_L, "/"]);
        await type(terminal, id);
        await drive(terminal, [KEYS.ENTER]);
        const lines = viewport(terminal);
        assertWidthContract(lines, width);
        expect(lines.join("\n")).toContain(`${id} TUI`);
        handle.stop();
      }
    }
  });

  it("shows inverse-video focus on the composer cursor and moves it on input", async () => {
    register("wallet", staticView(["WALLET BODY"]));
    const { terminal } = await bootShell({
      routes: [viewsRoute([{ id: "wallet", label: "Wallet TUI" }])],
    });

    // The composer is focused by default; its fake cursor is an inverse cell.
    const runsBefore = inverseRuns(terminal);
    expect(runsBefore.length).toBeGreaterThan(0);
    const cursorBefore = terminal.getCursorPosition();

    await type(terminal, "abc");
    const cursorAfter = terminal.getCursorPosition();
    // Typing advanced the rendered cursor and the composer still shows it.
    expect(
      cursorAfter.x !== cursorBefore.x || cursorAfter.y !== cursorBefore.y,
    ).toBe(true);
    expect(inverseRuns(terminal).length).toBeGreaterThan(0);
  });

  it("CLI tui-smoke boots the shell and prints the readiness marker", async () => {
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const logs: string[] = [];
    globalThis.fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/api/views?viewType=tui")) {
        return new Response(
          JSON.stringify({
            views: [
              {
                id: "messages",
                label: "Messages TUI",
                path: "/messages/tui",
                viewType: "tui",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    console.log = vi.fn((message?: unknown) => {
      logs.push(String(message ?? ""));
    });

    try {
      await runAutonomousCli([
        "node",
        "eliza-autonomous",
        "tui-smoke",
        "--api",
        "http://127.0.0.1:31337",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }

    expect(logs.join("\n")).toContain("elizaOS terminal tui");
    expect(logs.join("\n")).toContain(
      "elizaos-tui-ready api=http://127.0.0.1:31337",
    );
  });
});

function findCall(
  calls: RecordedCall[],
  predicate: (call: RecordedCall) => boolean,
): RecordedCall | undefined {
  return calls.find(predicate);
}
