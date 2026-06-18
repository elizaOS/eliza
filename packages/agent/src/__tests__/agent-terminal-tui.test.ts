import {
  type Component,
  registerTerminalView,
  type Terminal,
  truncateToWidth,
} from "@elizaos/tui";
import { describe, expect, it, vi } from "vitest";
import { runAutonomousCli } from "../cli/index.ts";
import { startAgentTerminalTui } from "../tui/agent-terminal-tui.ts";

class TestTerminal implements Terminal {
  private inputHandler?: (data: string) => void;
  readonly writes: string[] = [];

  start(onInput: (data: string) => void): void {
    this.inputHandler = onInput;
  }

  stop(): void {
    this.inputHandler = undefined;
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.writes.push(data);
  }

  get columns(): number {
    return 100;
  }

  get rows(): number {
    return 28;
  }

  get kittyProtocolActive(): boolean {
    return true;
  }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}

  send(data: string): void {
    this.inputHandler?.(data);
  }

  text(): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escape sequences
    return this.writes.join("").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  }
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function flushTicks(): Promise<void> {
  // Drain a few macrotasks so chained awaited fetches (e.g. create-conversation
  // then post-message) all settle before assertions run.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Poll until a request matching `predicate` has been issued. Deterministic
 * replacement for guessing tick counts when an action triggers chained awaited
 * fetches (create-conversation → post-message).
 */
async function waitForCall(
  calls: Array<{ url: string }>,
  predicate: (call: { url: string }) => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (calls.some(predicate)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return calls.some(predicate);
}

describe("agent terminal tui", () => {
  it("starts in prod-compatible terminal mode and supports keyboard view/chat actions", async () => {
    const terminal = new TestTerminal();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/api/views?viewType=tui")) {
          return response({
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
        if (url.endsWith("/api/views/wallet/navigate?viewType=tui")) {
          return response({ ok: true });
        }
        if (url.endsWith("/api/conversations")) {
          return response({ conversation: { id: "conv-terminal" } });
        }
        if (url.endsWith("/api/conversations/conv-terminal/messages")) {
          return response({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    ) as unknown as typeof fetch;

    const handle = startAgentTerminalTui({
      apiBaseUrl: "http://127.0.0.1:2138",
      terminal,
      fetchImpl,
    });

    expect(handle).not.toBeNull();
    await handle?.ready;
    await flushTicks();

    expect(terminal.text()).toContain("elizaOS terminal tui");
    expect(terminal.text()).toContain("↑/↓ select");
    expect(terminal.text()).toContain("1. Messages TUI");
    expect(terminal.text()).toContain("2. Wallet TUI");

    terminal.send("/");
    terminal.send("wal");
    await flushTicks();
    const searchRender = terminal
      .text()
      .slice(terminal.text().lastIndexOf("search views"));
    expect(searchRender).toContain("filter: wal");
    expect(searchRender).toContain("2. Wallet TUI");
    expect(searchRender).not.toContain("1. Messages TUI");

    terminal.send("\r");
    expect(
      await waitForCall(calls, (call) =>
        call.url.endsWith("/api/views/wallet/navigate?viewType=tui"),
      ),
    ).toBe(true);

    terminal.send("c");
    terminal.send("hello over ssh");
    terminal.send("\r");
    await waitForCall(calls, (call) =>
      call.url.endsWith("/api/conversations/conv-terminal/messages"),
    );

    const chatCall = calls.find((call) =>
      call.url.endsWith("/api/conversations/conv-terminal/messages"),
    );
    expect(chatCall).toBeTruthy();
    expect(JSON.parse(String(chatCall?.init?.body))).toMatchObject({
      text: "hello over ssh",
      source: "terminal-tui",
      metadata: { viewId: "wallet", viewType: "tui" },
    });

    handle?.stop();
  });

  it("renders a registered terminal view inline instead of only navigating", async () => {
    let rendered = 0;
    const liveView: Component = {
      render: (width) => [
        truncateToWidth("LIVE PHONE VIEW", width),
        truncateToWidth(`render #${++rendered}`, width),
      ],
      handleInput: () => {},
      invalidate: () => {},
    };
    const unregister = registerTerminalView("phone", liveView);

    const terminal = new TestTerminal();
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/api/views?viewType=tui")) {
        return response({
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

    const handle = startAgentTerminalTui({
      apiBaseUrl: "http://127.0.0.1:2138",
      terminal,
      fetchImpl,
    });
    await handle?.ready;
    await flushTicks();

    // The registered view is flagged in the list…
    expect(terminal.text()).toContain("Phone TUI ▣");

    // …and quick-opening it renders the view's real content inline.
    terminal.send("1");
    await flushTicks();
    expect(terminal.text()).toContain("LIVE PHONE VIEW");
    expect(terminal.text()).toContain("esc/q returns to views");

    // Esc returns to the list (no GUI-navigate fetch was issued for it).
    terminal.send("");
    await flushTicks();
    expect(terminal.text()).toContain("registered tui views");

    handle?.stop();
    unregister();
  });

  it("has a CLI smoke mode that starts the TUI and emits a boot marker", async () => {
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const logs: string[] = [];
    globalThis.fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/api/views?viewType=tui")) {
        return response({
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
