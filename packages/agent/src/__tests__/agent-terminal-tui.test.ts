import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Component,
  registerTerminalView,
  type Terminal,
  type TerminalViewMountOptions,
  truncateToWidth,
} from "@elizaos/tui";
import { describe, expect, it, vi } from "vitest";
import { runAutonomousCli } from "../cli/index.ts";
import { startAgentTerminalTui } from "../tui/agent-terminal-tui.ts";

const ESC = "";
const CTRL_L = "";
const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_PACKAGE_ROOT = resolve(__dirname, "../..");

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
    return this.writes.join("").replace(/\[[0-9;?]*[A-Za-z]/g, "");
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
 * fetches (create-conversation -> post-message).
 */
async function waitForCall<T extends { url?: string }>(
  calls: T[],
  predicate: (call: T) => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (calls.some(predicate)) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return calls.some(predicate);
}

async function waitForText(
  getText: () => string,
  text: string,
  timeoutMs = 5000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getText().includes(text)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return getText().includes(text);
}

/** The last frame the terminal rendered (the live screen), ANSI-stripped. */
function lastFrameLines(terminal: TestTerminal): string[] {
  // The TUI writes whole frames; the final write that contains the composer
  // separator line is the current screen. Splitting the joined output on the
  // composer separator is brittle, so just strip ANSI off the full buffer and
  // return its lines — assertions look for the relative ordering of markers.
  return terminal.text().split(/\r?\n/);
}

describe("agent terminal tui", () => {
  it("sends the configured API token on terminal client requests", async () => {
    const terminal = new TestTerminal();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/api/views?viewType=tui")) {
          return response({ views: [] });
        }
        if (url.includes("/api/commands?surface=tui")) {
          return response({ commands: [], surface: "tui" });
        }
        return new Response("not found", { status: 404 });
      },
    ) as unknown as typeof fetch;

    const handle = startAgentTerminalTui({
      apiBaseUrl: "http://127.0.0.1:2138",
      apiToken: "terminal-token",
      terminal,
      fetchImpl,
    });
    await handle?.ready;

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.init?.headers).toMatchObject({
        Authorization: "Bearer terminal-token",
      });
    }

    handle?.stop();
  });

  it("keeps a bottom composer always visible and sends chat while a view is mounted", async () => {
    // wallet is a registered terminal view so opening it mounts inline.
    const walletView: Component = {
      render: (width) => [truncateToWidth("WALLET BODY", width)],
      handleInput: () => {},
      invalidate: () => {},
    };
    const unregisterWallet = registerTerminalView("wallet", walletView);
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
        if (url.includes("/api/views/wallet/navigate")) {
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

    // (a) The default screen lists views AND pins the composer at the bottom.
    const boot = lastFrameLines(terminal);
    expect(boot.join("\n")).toContain("elizaOS terminal tui");
    expect(boot.join("\n")).toContain("1. Messages TUI");
    // The composer prompt + its label sit on the last rows of the frame.
    const composerIdx = boot.lastIndexOf(
      boot.filter((l) => l.includes("chat")).at(-1) ?? "",
    );
    const listIdx = boot.lastIndexOf(
      boot.filter((l) => l.includes("registered tui views")).at(-1) ?? "",
    );
    expect(composerIdx).toBeGreaterThan(listIdx);

    // Open the wallet view via search (composer is focused by default; the
    // top-level "/" search is a view-block keybinding, so focus the view first).
    terminal.send(CTRL_L); // focus the view block
    terminal.send("/");
    terminal.send("wal");
    await flushTicks();
    const searchText = terminal.text();
    expect(searchText.slice(searchText.lastIndexOf("search views"))).toContain(
      "filter: wal",
    );
    terminal.send("\r");
    await flushTicks();

    // (b) Type into the composer + Enter while a view is mounted: a message
    // send fires and the view stays mounted.
    terminal.send(CTRL_L); // focus the composer
    terminal.send("hello from terminal tui");
    terminal.send("\r");
    expect(
      await waitForCall(calls, (call) =>
        call.url.endsWith("/api/conversations/conv-terminal/messages"),
      ),
    ).toBe(true);

    const chatCall = calls.find((call) =>
      call.url.endsWith("/api/conversations/conv-terminal/messages"),
    );
    expect(JSON.parse(String(chatCall?.init?.body))).toMatchObject({
      text: "hello from terminal tui",
      source: "terminal-tui",
      metadata: { viewId: "wallet", viewType: "tui" },
    });

    // The view is still mounted (its header is still on screen) and the
    // composer is still rendered below it.
    await flushTicks();
    const after = terminal.text();
    expect(after).toContain("elizaOS terminal tui · Wallet TUI");
    expect(after).toContain("WALLET BODY");

    handle?.stop();
    unregisterWallet();
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

    // The registered view is flagged in the list.
    expect(terminal.text()).toContain("Phone TUI");

    // Quick-open it (digit keys are view-block keybindings → focus the view).
    terminal.send(CTRL_L);
    terminal.send("1");
    await flushTicks();
    const open = terminal.text();
    expect(open).toContain("LIVE PHONE VIEW");
    // The composer is still rendered (chat-at-bottom) while the view is up.
    expect(open).toContain("chat");

    // Esc returns to the list.
    terminal.send(ESC);
    await flushTicks();
    expect(terminal.text()).toContain("registered tui views");

    handle?.stop();
    unregister();
  });

  it("routes a /navigate slash command through the composer and swaps the view in place", async () => {
    const walletView: Component = {
      render: (width) => [truncateToWidth("WALLET BODY", width)],
      handleInput: () => {},
      invalidate: () => {},
    };
    const unregisterWallet = registerTerminalView("wallet", walletView);
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
                id: "wallet",
                label: "Wallet TUI",
                path: "/wallet/tui",
                viewType: "tui",
              },
            ],
          });
        }
        if (url.includes("/api/commands?surface=tui")) {
          return response({
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
            generatedAt: new Date().toISOString(),
          });
        }
        if (url.includes("/api/views/wallet/navigate")) {
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
    await handle?.ready;
    await flushTicks();

    // Composer is focused by default — type the slash command and submit. The
    // autocomplete catalog comes from /api/commands (a navigate target).
    terminal.send("/wallet");
    // The editor shows its slash autocomplete while typing "/".
    expect(terminal.text()).toContain("wallet");
    terminal.send("\r");
    await flushTicks();

    // navigate-view dispatch swapped the mounted view in place (no list teardown).
    expect(
      await waitForCall(calls, (call) =>
        call.url.includes("/api/views/wallet/navigate"),
      ),
    ).toBe(true);
    expect(terminal.text()).toContain("elizaOS terminal tui · Wallet TUI");
    expect(terminal.text()).toContain("WALLET BODY");

    handle?.stop();
    unregisterWallet();
  });

  it("dispatches a focused view button activation to the agent (onActivate -> POST activate)", async () => {
    const activations: string[] = [];
    // Register a factory-backed view: the host builds it with its own
    // onActivate, which the component fires on Enter (mirroring the spatial
    // component's activate path).
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
    const unregister = registerTerminalView("approve", factory(), factory);

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
                id: "approve",
                label: "Approve TUI",
                path: "/approve/tui",
                viewType: "tui",
              },
            ],
          });
        }
        if (url.includes("/api/views/approve/navigate")) {
          return response({ ok: true });
        }
        if (url.includes("/api/views/approve/activate")) {
          return response({
            ok: true,
            viewId: "approve",
            elementId: "send-it",
          });
        }
        return new Response("not found", { status: 404 });
      },
    ) as unknown as typeof fetch;

    const handle = startAgentTerminalTui({
      apiBaseUrl: "http://127.0.0.1:2138",
      terminal,
      fetchImpl,
    });
    await handle?.ready;
    await flushTicks();

    // Focus the view block, open it, then activate its focused control.
    terminal.send(CTRL_L);
    terminal.send("1");
    await flushTicks();
    expect(terminal.text()).toContain("ACTIVATE ME");

    terminal.send("\r"); // Enter activates the focused control
    expect(activations).toEqual(["send-it"]);
    expect(
      await waitForCall(calls, (call) =>
        call.url.includes("/api/views/approve/activate"),
      ),
    ).toBe(true);
    const activateCall = calls.find((call) =>
      call.url.includes("/api/views/approve/activate"),
    );
    expect(JSON.parse(String(activateCall?.init?.body))).toMatchObject({
      elementId: "send-it",
    });

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

  it("drives the packaged CLI through a real pseudo-terminal", async () => {
    let ptyModule: typeof import("@lydell/node-pty");
    try {
      ptyModule = await import("@lydell/node-pty");
    } catch {
      console.warn("Skipping real PTY TUI smoke: @lydell/node-pty unavailable");
      return;
    }

    const requests: Array<{
      method?: string;
      url?: string;
      authorization?: string;
      body: string;
    }> = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          body,
        });
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/views?viewType=tui") {
          res.end(
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
          );
          return;
        }
        if (req.url === "/api/commands?surface=tui") {
          res.end(JSON.stringify({ commands: [], surface: "tui" }));
          return;
        }
        if (req.url === "/api/conversations" && req.method === "POST") {
          res.end(JSON.stringify({ conversation: { id: "conv-pty" } }));
          return;
        }
        if (
          req.url === "/api/conversations/conv-pty/messages" &&
          req.method === "POST"
        ) {
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("test server did not bind to a TCP port");
    }

    let output = "";
    const pty = ptyModule.spawn(
      "bun",
      ["run", "src/bin.ts", "tui", "--api", `http://127.0.0.1:${address.port}`],
      {
        cwd: AGENT_PACKAGE_ROOT,
        cols: 92,
        rows: 28,
        env: {
          ...process.env,
          ELIZA_TERMINAL_TUI: "1",
          ELIZA_API_TOKEN: "pty-token",
          NODE_NO_WARNINGS: "1",
        },
      },
    );
    pty.onData((data) => {
      output += data;
    });

    try {
      expect(await waitForText(() => output, "elizaos-tui-ready")).toBe(true);
      expect(await waitForText(() => output, "Messages TUI")).toBe(true);
      pty.write("hello from real pty\r");
      expect(
        await waitForCall(
          requests,
          (request) =>
            request.url === "/api/conversations/conv-pty/messages" &&
            request.body.includes("hello from real pty"),
          5000,
        ),
      ).toBe(true);
      pty.resize(100, 32);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      pty.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(
      requests.every((request) => request.authorization === "Bearer pty-token"),
    ).toBe(true);
  }, 15_000);
});
