// Whole-app TUI e2e (issue #9969).
//
// Drives the REAL agent terminal shell through a REAL terminal emulator
// (`VirtualTerminal` via the harness) and asserts against the rendered grid —
// viewport text, cursor, and inverse-video focus cells — for every surface:
// chat, inline view mounting, slash-navigation, focused-control activation
// (code orchestration), the registered-view width contract, and the CLI boot
// marker. Replaces the old `TestTerminal` whose `text()` regex-stripped ANSI.
//
// Each surface emits a `.cast` recording + viewport/scrollback capture (the TUI
// lane's screen-recording + screen-capture evidence per #9944).
import {
  type Component,
  getTerminalView,
  listTerminalViewIds,
  registerTerminalView,
  type TerminalViewMountOptions,
  truncateToWidth,
  visibleWidth,
} from "@elizaos/tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAutonomousCli } from "../src/cli/index.ts";
import {
  bootShell,
  drive,
  flushTicks,
  hasInverseFocus,
  jsonResponse,
  KEY,
  type RecordingTerminal,
  waitForCall,
  writeArtifacts,
} from "./tui-harness.ts";

const view = (body: string): Component => ({
  render: (width) => [truncateToWidth(body, width)],
  handleInput: () => {},
  invalidate: () => {},
});

const joinViewport = (term: RecordingTerminal): string =>
  term.getViewport().join("\n");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("agent terminal tui — whole-app e2e", () => {
  it("keeps a bottom composer always visible and sends chat while a view is mounted", async () => {
    cleanups.push(registerTerminalView("wallet", view("WALLET BODY")));

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/api/views?viewType=tui")) {
          return jsonResponse({
            views: [
              {
                id: "messages",
                label: "Messages TUI",
                path: "/messages/tui",
                viewType: "tui",
              },
              {
                id: "wallet",
                label: "Wallet TUI",
                path: "/wallet/tui",
                viewType: "tui",
              },
            ],
          });
        }
        if (url.includes("/api/views/wallet/navigate"))
          return jsonResponse({ ok: true });
        if (url.endsWith("/api/conversations")) {
          return jsonResponse({ conversation: { id: "conv-terminal" } });
        }
        if (url.endsWith("/api/conversations/conv-terminal/messages")) {
          return jsonResponse({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    ) as unknown as typeof fetch;

    const { term, handle } = bootShell({ fetchImpl });
    cleanups.push(() => handle?.stop());
    expect(handle).not.toBeNull();
    await handle?.ready;
    await flushTicks();
    await term.flush();

    // (a) Default screen lists views AND pins the composer below the list.
    const boot = term.getViewport();
    expect(boot.join("\n")).toContain("elizaOS terminal tui");
    expect(boot.join("\n")).toContain("1. Messages TUI");
    const listRow = boot.findIndex((l) => l.includes("registered tui views"));
    const composerRow = boot.findIndex((l) => l.includes("chat"));
    expect(composerRow).toBeGreaterThan(listRow);
    expect(listRow).toBeGreaterThanOrEqual(0);

    // Open wallet via search (focus the view block first; "/" is a view keybinding).
    await drive(term, [KEY.CTRL_L, "/", "wal"]);
    expect(joinViewport(term)).toContain("filter: wal");
    await drive(term, [KEY.ENTER]);

    // (b) Type into the composer + Enter while the view is mounted.
    await drive(term, [KEY.CTRL_L, "hello over terminal", KEY.ENTER]);
    expect(
      await waitForCall(calls, (c) =>
        c.url.endsWith("/api/conversations/conv-terminal/messages"),
      ),
    ).toBe(true);
    const chatCall = calls.find((c) =>
      c.url.endsWith("/api/conversations/conv-terminal/messages"),
    );
    expect(JSON.parse(String(chatCall?.init?.body))).toMatchObject({
      text: "hello over terminal",
      source: "terminal-tui",
      metadata: { viewId: "wallet", viewType: "tui" },
    });

    // The view is still mounted (header + body on the real grid) with the composer below.
    await flushTicks();
    await term.flush();
    const after = joinViewport(term);
    expect(after).toContain("elizaOS terminal tui · Wallet TUI");
    expect(after).toContain("WALLET BODY");

    // Capture screen-recording + screen/output capture for this surface.
    const artifacts = writeArtifacts("chat-compose", term);
    expect(artifacts.cast).toMatch(/\.cast$/);
  });

  it("renders a registered terminal view inline with the composer below it", async () => {
    let rendered = 0;
    const liveView: Component = {
      render: (width) => [
        truncateToWidth("LIVE PHONE VIEW", width),
        truncateToWidth(`render #${++rendered}`, width),
      ],
      handleInput: () => {},
      invalidate: () => {},
    };
    cleanups.push(registerTerminalView("phone", liveView));

    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/api/views?viewType=tui")) {
        return jsonResponse({
          views: [
            {
              id: "phone",
              label: "Phone TUI",
              path: "/phone/tui",
              viewType: "tui",
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const { term, handle } = bootShell({ fetchImpl });
    cleanups.push(() => handle?.stop());
    await handle?.ready;
    await flushTicks();
    await term.flush();
    expect(joinViewport(term)).toContain("Phone TUI");

    // Quick-open (digit keys are view-block keybindings → focus the view).
    await drive(term, [KEY.CTRL_L, "1"]);
    const open = joinViewport(term);
    expect(open).toContain("LIVE PHONE VIEW");
    expect(open).toContain("chat"); // composer still pinned

    // Esc returns to the list.
    await drive(term, [KEY.ESC]);
    expect(joinViewport(term)).toContain("registered tui views");
  });

  it("routes a /navigate slash command through the composer and swaps the view in place", async () => {
    cleanups.push(registerTerminalView("wallet", view("WALLET BODY")));
    const calls: Array<{ url: string }> = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      calls.push({ url });
      if (url.endsWith("/api/views?viewType=tui")) {
        return jsonResponse({
          views: [
            {
              id: "wallet",
              label: "Wallet TUI",
              path: "/wallet/tui",
              viewType: "tui",
            },
          ],
        });
      }
      if (url.includes("/api/commands?surface=tui")) {
        return jsonResponse({
          commands: [
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
          ],
          surface: "tui",
          agentId: null,
          generatedAt: "2026-01-01T00:00:00.000Z",
        });
      }
      if (url.includes("/api/views/wallet/navigate"))
        return jsonResponse({ ok: true });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const { term, handle } = bootShell({ fetchImpl });
    cleanups.push(() => handle?.stop());
    await handle?.ready;
    await flushTicks();
    await term.flush();

    // Composer focused by default — type the slash command; autocomplete shows it.
    await drive(term, ["/wallet"]);
    expect(joinViewport(term)).toContain("wallet");
    await drive(term, [KEY.ENTER]);

    expect(
      await waitForCall(calls, (c) =>
        c.url.includes("/api/views/wallet/navigate"),
      ),
    ).toBe(true);
    const swapped = joinViewport(term);
    expect(swapped).toContain("elizaOS terminal tui · Wallet TUI");
    expect(swapped).toContain("WALLET BODY");
  });

  it("dispatches a focused view button activation to the agent (code orchestration: onActivate -> POST activate)", async () => {
    const activations: string[] = [];
    // A factory-backed view (mirrors the spatial component's activate path used
    // by task-coordinator/orchestrator) — the host builds it with onActivate.
    const factory = (options?: TerminalViewMountOptions): Component => ({
      render: (width) => [truncateToWidth("ACTIVATE ME", width)],
      handleInput: (data: string) => {
        if (data === "\r" || data === "\n") {
          activations.push("send-it");
          options?.onActivate?.("send-it");
        }
      },
      invalidate: () => {},
    });
    cleanups.push(registerTerminalView("task-coordinator", factory(), factory));

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/api/views?viewType=tui")) {
          return jsonResponse({
            views: [
              {
                id: "task-coordinator",
                label: "Task Coordinator TUI",
                path: "/task-coordinator/tui",
                viewType: "tui",
              },
            ],
          });
        }
        if (url.includes("/api/views/task-coordinator/navigate"))
          return jsonResponse({ ok: true });
        if (url.includes("/api/views/task-coordinator/activate")) {
          return jsonResponse({
            ok: true,
            viewId: "task-coordinator",
            elementId: "send-it",
          });
        }
        return new Response("not found", { status: 404 });
      },
    ) as unknown as typeof fetch;

    const { term, handle } = bootShell({ fetchImpl });
    cleanups.push(() => handle?.stop());
    await handle?.ready;
    await flushTicks();
    await term.flush();

    await drive(term, [KEY.CTRL_L, "1"]);
    expect(joinViewport(term)).toContain("ACTIVATE ME");

    await drive(term, [KEY.ENTER]); // Enter activates the focused control
    expect(activations).toEqual(["send-it"]);
    expect(
      await waitForCall(calls, (c) =>
        c.url.includes("/api/views/task-coordinator/activate"),
      ),
    ).toBe(true);
    const activateCall = calls.find((c) =>
      c.url.includes("/api/views/task-coordinator/activate"),
    );
    expect(JSON.parse(String(activateCall?.init?.body))).toMatchObject({
      elementId: "send-it",
    });

    writeArtifacts("orchestration-activate", term);
  });

  it("renders the focused view block with real inverse-video focus on the grid", async () => {
    // A focusable control that renders inverse-video when focused — proves the
    // real grid carries focus styling (the old regex-strip terminal could not).
    const focusView: Component = {
      render: (width) => [
        truncateToWidth("\x1b[7mFOCUSED BUTTON\x1b[27m", width),
      ],
      handleInput: () => {},
      invalidate: () => {},
    };
    cleanups.push(registerTerminalView("approve", focusView));

    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/api/views?viewType=tui")) {
        return jsonResponse({
          views: [
            {
              id: "approve",
              label: "Approve TUI",
              path: "/approve/tui",
              viewType: "tui",
            },
          ],
        });
      }
      if (url.includes("/api/views/approve/navigate"))
        return jsonResponse({ ok: true });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const { term, handle } = bootShell({ fetchImpl });
    cleanups.push(() => handle?.stop());
    await handle?.ready;
    await flushTicks();
    await term.flush();

    await drive(term, [KEY.CTRL_L, "1"]);
    expect(joinViewport(term)).toContain("FOCUSED BUTTON");
    expect(hasInverseFocus(term)).toBe(true);
  });

  it("enforces the visibleWidth(line) <= width contract for every registered view", async () => {
    // Register a spread of views (including deliberately long content) and
    // assert each renders within the cell budget at multiple widths — the
    // grid-level complement to the route-contract plugin-tui-view-coverage test.
    const longLabel =
      "this terminal view body is intentionally much wider than any sane terminal column budget to exercise truncation";
    cleanups.push(registerTerminalView("vt-short", view("ok")));
    cleanups.push(
      registerTerminalView("vt-long", {
        render: (width) => [
          truncateToWidth(longLabel, width),
          truncateToWidth(`${longLabel} second line`, width),
        ],
        handleInput: () => {},
        invalidate: () => {},
      }),
    );

    const ids = listTerminalViewIds();
    expect(ids).toContain("vt-short");
    expect(ids).toContain("vt-long");

    for (const id of ids) {
      const component = getTerminalView(id);
      if (!component) continue;
      for (const width of [80, 56, 40]) {
        const lines = component.render(width);
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("has a CLI smoke mode that starts the TUI and emits a boot marker", async () => {
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const logs: string[] = [];
    globalThis.fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/api/views?viewType=tui")) {
        return jsonResponse({
          views: [
            {
              id: "messages",
              label: "Messages TUI",
              path: "/messages/tui",
              viewType: "tui",
            },
          ],
        });
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
