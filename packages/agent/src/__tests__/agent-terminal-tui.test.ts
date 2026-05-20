import type { Terminal } from "@elizaos/tui";
import { describe, expect, it, vi } from "vitest";
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
    const ansiEscape = new RegExp(
      `${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`,
      "g",
    );
    return this.writes.join("").replace(ansiEscape, "");
  }
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function flushTicks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    await flushTicks();
    expect(
      calls.some((call) =>
        call.url.endsWith("/api/views/wallet/navigate?viewType=tui"),
      ),
    ).toBe(true);

    terminal.send("c");
    terminal.send("hello over ssh");
    terminal.send("\n");
    await flushTicks();

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
});
