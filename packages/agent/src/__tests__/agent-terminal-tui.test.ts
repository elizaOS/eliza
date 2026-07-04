/**
 * Drives the agent terminal TUI (`startAgentTerminalTui`) end to end: a
 * bottom-pinned composer that stays visible while a registered terminal view is
 * mounted inline, quick-open and `/`-search view switching, slash-command
 * `/navigate` dispatch, focused-control activation posted back to the agent, the
 * `tui-smoke` CLI boot marker, and a real `@lydell/node-pty` spawn of
 * `bin.ts tui`. Harness realism: view rendering and the CLI/PTY code paths run
 * for real against a `TestTerminal`; only the agent HTTP backend is a local mock
 * (a `vi.fn` fetch or an in-process `node:http` server) returning canned
 * views/commands/conversation payloads and recording the outbound calls.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const bunExecutable = "bun";

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

function stripAnsi(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escape sequences from captured terminal frames
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startTerminalMockServer(): Promise<{
  url: string;
  logs: string[];
  messages: unknown[];
  close: () => Promise<void>;
}> {
  const logs: string[] = [];
  const messages: unknown[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    logs.push(`${req.method ?? "GET"} ${url.pathname}${url.search}`);

    function json(status: number, body: unknown): void {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    }

    if (req.method === "GET" && url.pathname === "/api/views") {
      json(200, {
        views: [
          {
            id: "wallet",
            label: "Wallet TUI",
            path: "/wallet/tui",
            viewType: "tui",
          },
        ],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/commands") {
      json(200, {
        commands: [],
        surface: "tui",
        agentId: null,
        generatedAt: new Date(0).toISOString(),
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/views/wallet/navigate"
    ) {
      await readRequestBody(req);
      json(200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/conversations") {
      await readRequestBody(req);
      json(200, { conversation: { id: "conv-pty" } });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/conversations/conv-pty/messages"
    ) {
      const raw = await readRequestBody(req);
      messages.push(JSON.parse(raw));
      json(200, { ok: true });
      return;
    }

    json(404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    logs,
    messages,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function waitForText(
  getText: () => string,
  needle: string,
  timeoutMs = 10_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = getText();
    if (text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const text = getText();
  throw new Error(
    `Timed out waiting for terminal text: ${needle}\n--- captured ---\n${text.slice(-4000)}`,
  );
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

/** The last frame the terminal rendered (the live screen), ANSI-stripped. */
function lastFrameLines(terminal: TestTerminal): string[] {
  // The TUI writes whole frames; the final write that contains the composer
  // separator line is the current screen. Splitting the joined output on the
  // composer separator is brittle, so just strip ANSI off the full buffer and
  // return its lines — assertions look for the relative ordering of markers.
  return terminal.text().split(/\r?\n/);
}

describe("agent terminal tui", () => {
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

  it("drives the terminal TUI through a real PTY", async () => {
    const pty = await import("@lydell/node-pty");
    const server = await startTerminalMockServer();
    const tempDir = await mkdtemp(path.join(tmpdir(), "eliza-tui-pty-"));
    const preloadPath = path.join(tempDir, "register-terminal-view.mjs");
    const tuiSourceUrl = pathToFileURL(
      path.join(repoRoot, "packages/tui/src/index.ts"),
    ).href;
    await writeFile(
      preloadPath,
      [
        `import { registerTerminalView, truncateToWidth } from ${JSON.stringify(tuiSourceUrl)};`,
        'registerTerminalView("wallet", {',
        "  render(width) {",
        '    return [truncateToWidth("PTY WALLET BODY", width), truncateToWidth("PTY WIDTH " + width, width)];',
        "  },",
        "  handleInput() {},",
        "  invalidate() {},",
        "});",
        "",
      ].join("\n"),
    );

    let output = "";
    const term = pty.spawn(
      bunExecutable,
      [
        "--conditions=eliza-source",
        "--preload",
        preloadPath,
        "packages/agent/src/bin.ts",
        "tui",
        "--api",
        server.url,
      ],
      {
        name: "xterm-256color",
        cols: 96,
        rows: 28,
        cwd: repoRoot,
        env: {
          ...process.env,
          ELIZA_TERMINAL_TUI: "1",
          NODE_NO_WARNINGS: "1",
        },
      },
    );

    try {
      term.onData((data) => {
        output += data;
      });

      await waitForText(() => stripAnsi(output), "elizaOS terminal tui");
      await waitForText(() => stripAnsi(output), "Wallet TUI");

      term.write("\f");
      term.write("1");
      await waitForText(() => stripAnsi(output), "PTY WALLET BODY");
      await waitForText(
        () => server.logs.join("\n"),
        "POST /api/views/wallet/navigate",
      );

      term.resize(72, 20);
      await waitForText(() => stripAnsi(output), "PTY WIDTH");

      term.write("\f");
      term.write("hello from real pty");
      term.write("\r");
      await waitForText(
        () => server.logs.join("\n"),
        "POST /api/conversations/conv-pty/messages",
      );

      expect(server.messages).toHaveLength(1);
      expect(server.messages[0]).toMatchObject({
        text: "hello from real pty",
        source: "terminal-tui",
        metadata: { viewId: "wallet", viewType: "tui" },
      });
    } finally {
      term.kill();
      await server.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
