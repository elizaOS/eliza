import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { SandboxService, SessionCwdService } from "../services/index.js";
import { SANDBOX_SERVICE, SESSION_CWD_SERVICE } from "../types.js";
import { resolveCryptoSpotPriceCommand, shellAction } from "./bash.js";

interface RuntimeOptions {
  blockedPaths?: string;
  shellTimeoutMs?: number;
  shellHistoryCommands?: string[];
  withShellHistoryService?: boolean;
}

async function makeRuntime(opts: RuntimeOptions = {}): Promise<{
  runtime: IAgentRuntime;
  sandbox: SandboxService;
  session: SessionCwdService;
  shellHistoryService?: {
    clearCommandHistory: ReturnType<typeof vi.fn>;
    getCommandHistory: ReturnType<typeof vi.fn>;
  };
}> {
  const settings: Record<string, unknown> = {};
  if (opts.blockedPaths)
    settings.CODING_TOOLS_BLOCKED_PATHS = opts.blockedPaths;
  if (opts.shellTimeoutMs !== undefined)
    settings.CODING_TOOLS_SHELL_TIMEOUT_MS = opts.shellTimeoutMs;

  const services = new Map<string, unknown>();
  const runtime = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    getSetting: vi.fn((key: string) => settings[key]),
    getService: vi.fn(<T>(type: string) => services.get(type) as T | null),
  } as IAgentRuntime;

  const sandbox = await SandboxService.start(runtime);
  const session = await SessionCwdService.start(runtime);
  services.set(SANDBOX_SERVICE, sandbox);
  services.set(SESSION_CWD_SERVICE, session);
  const shellHistoryService =
    opts.withShellHistoryService || opts.shellHistoryCommands
      ? {
          clearCommandHistory: vi.fn(),
          getCommandHistory: vi.fn((_conversationId: string, limit?: number) =>
            (opts.shellHistoryCommands ?? [])
              .slice(0, limit ?? opts.shellHistoryCommands?.length ?? 0)
              .map((command) => ({ command })),
          ),
        }
      : undefined;
  if (shellHistoryService) {
    services.set("shell", shellHistoryService);
  }

  return { runtime, sandbox, session, shellHistoryService };
}

function makeMessage(
  roomId = "11111111-aaaa-bbbb-cccc-222222222222",
  text = "",
): Memory {
  return {
    id: "33333333-3333-3333-3333-333333333333" as UUID,
    entityId: "44444444-4444-4444-4444-444444444444" as UUID,
    roomId: roomId as UUID,
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

describe("shellAction", () => {
  it("runs a simple foreground command (echo hello)", async () => {
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      { command: "echo hello" },
    );
    expect(result.success).toBe(true);
    expect(typeof result.text).toBe("string");
    expect(result.text).toContain("hello");
    expect(result.text).toContain("[exit 0]");
  });

  it("marks empty stdout and stderr explicitly for successful commands", async () => {
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      { command: "true" },
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("[exit 0]");
    expect(result.text).toContain("--- stdout ---\n(empty)");
    expect(result.text).toContain("--- stderr ---\n(empty)");
  });

  it("rejects a cwd under the blocklist", async () => {
    const tmpRoot = path.resolve(os.tmpdir());
    const blocked = path.join(tmpRoot, `blocked-${Date.now()}`);
    await fs.mkdir(blocked, { recursive: true });
    try {
      const { runtime } = await makeRuntime({ blockedPaths: blocked });
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(),
        undefined,
        { command: "pwd", cwd: blocked },
      );
      expect(result.success).toBe(false);
      expect(result.text).toContain("path_blocked");
    } finally {
      await fs.rm(blocked, { recursive: true, force: true });
    }
  });

  it("returns a timeout failure when the command exceeds its budget", async () => {
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      { command: "sleep 5", timeout: 200 },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("timeout");
  });

  it("respects an explicit cwd", async () => {
    const tmpRoot = path.resolve(os.tmpdir());
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      { command: "pwd", cwd: tmpRoot },
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain(tmpRoot);
  });

  it("uses session cwd instead of an unmentioned cwd for running-source checks", async () => {
    const roomId = "11111111-aaaa-bbbb-cccc-232323232323";
    const sessionRoot = path.resolve(
      process.cwd(),
      `.tmp-shell-runtime-session-${Date.now()}`,
    );
    const staleRoot = path.resolve(
      process.cwd(),
      `.tmp-shell-runtime-stale-${Date.now()}`,
    );
    await fs.mkdir(sessionRoot, { recursive: true });
    await fs.mkdir(staleRoot, { recursive: true });
    try {
      const { runtime, session } = await makeRuntime();
      session.setCwd(roomId, sessionRoot);
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          roomId,
          "Can you tell me what branch and commit the local source is running from?",
        ),
        undefined,
        { command: "pwd", cwd: staleRoot },
      );
      expect(result.success).toBe(true);
      expect(result.text).toContain(sessionRoot);
      expect(result.text).not.toContain(staleRoot);
      const data = result.data as Record<string, unknown> | undefined;
      expect(data?.cwd).toBe(sessionRoot);
    } finally {
      await fs.rm(sessionRoot, { recursive: true, force: true });
      await fs.rm(staleRoot, { recursive: true, force: true });
    }
  });

  it("strips unmentioned cd prefixes for running-source checks", async () => {
    const roomId = "11111111-aaaa-bbbb-cccc-252525252525";
    const sessionRoot = path.resolve(
      process.cwd(),
      `.tmp-shell-cd-session-${Date.now()}`,
    );
    const staleRoot = path.resolve(
      process.cwd(),
      `.tmp-shell-cd-stale-${Date.now()}`,
    );
    await fs.mkdir(sessionRoot, { recursive: true });
    await fs.mkdir(staleRoot, { recursive: true });
    try {
      const { runtime, session } = await makeRuntime();
      session.setCwd(roomId, sessionRoot);
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          roomId,
          "Can you tell me what branch and commit the local source is running from?",
        ),
        undefined,
        { command: `cd ${staleRoot} && pwd` },
      );
      expect(result.success).toBe(true);
      expect(result.text).toContain(`(cwd=${sessionRoot}`);
      expect(result.text).toContain(sessionRoot);
      expect(result.text).not.toContain(staleRoot);
      const data = result.data as Record<string, unknown> | undefined;
      expect(data?.cwd).toBe(sessionRoot);
    } finally {
      await fs.rm(sessionRoot, { recursive: true, force: true });
      await fs.rm(staleRoot, { recursive: true, force: true });
    }
  });

  it("rewrites unmentioned git -C paths for local submodule status checks", async () => {
    const roomId = "11111111-aaaa-bbbb-cccc-272727272727";
    const sessionRoot = path.resolve(
      process.cwd(),
      `.tmp-shell-submodule-session-${Date.now()}`,
    );
    const staleRoot = path.resolve(
      process.cwd(),
      `.tmp-shell-submodule-stale-${Date.now()}`,
    );
    await fs.mkdir(sessionRoot, { recursive: true });
    await fs.mkdir(staleRoot, { recursive: true });
    try {
      const { runtime, session } = await makeRuntime();
      session.setCwd(roomId, sessionRoot);
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          roomId,
          "is the vendored opencode submodule present and what commit is checked out? concise",
        ),
        undefined,
        { command: `git -C ${staleRoot} --version` },
      );
      expect(result.success).toBe(true);
      expect(result.text).toContain(`git -C '${sessionRoot}' --version`);
      expect(result.text).not.toContain(staleRoot);
      const data = result.data as Record<string, unknown> | undefined;
      expect(data?.cwd).toBe(sessionRoot);
    } finally {
      await fs.rm(sessionRoot, { recursive: true, force: true });
      await fs.rm(staleRoot, { recursive: true, force: true });
    }
  });

  it("keeps cd prefixes when the user names that path", async () => {
    const roomId = "11111111-aaaa-bbbb-cccc-262626262626";
    const sessionRoot = path.resolve(
      process.cwd(),
      `.tmp-shell-cd-explicit-session-${Date.now()}`,
    );
    const requestedRoot = path.resolve(
      process.cwd(),
      `.tmp-shell-cd-explicit-requested-${Date.now()}`,
    );
    await fs.mkdir(sessionRoot, { recursive: true });
    await fs.mkdir(requestedRoot, { recursive: true });
    try {
      const { runtime, session } = await makeRuntime();
      session.setCwd(roomId, sessionRoot);
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          roomId,
          `Can you tell me what branch is running from ${requestedRoot}?`,
        ),
        undefined,
        { command: `cd ${requestedRoot} && pwd` },
      );
      expect(result.success).toBe(true);
      expect(result.text).toContain(requestedRoot);
      const data = result.data as Record<string, unknown> | undefined;
      expect(data?.cwd).toBe(sessionRoot);
    } finally {
      await fs.rm(sessionRoot, { recursive: true, force: true });
      await fs.rm(requestedRoot, { recursive: true, force: true });
    }
  });

  it("respects an explicit cwd when the user names that path", async () => {
    const roomId = "11111111-aaaa-bbbb-cccc-242424242424";
    const sessionRoot = path.resolve(
      process.cwd(),
      `.tmp-shell-explicit-session-${Date.now()}`,
    );
    const requestedRoot = path.resolve(
      process.cwd(),
      `.tmp-shell-explicit-requested-${Date.now()}`,
    );
    await fs.mkdir(sessionRoot, { recursive: true });
    await fs.mkdir(requestedRoot, { recursive: true });
    try {
      const { runtime, session } = await makeRuntime();
      session.setCwd(roomId, sessionRoot);
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          roomId,
          `Can you tell me what branch is running from ${requestedRoot}?`,
        ),
        undefined,
        { command: "pwd", cwd: requestedRoot },
      );
      expect(result.success).toBe(true);
      expect(result.text).toContain(requestedRoot);
      const data = result.data as Record<string, unknown> | undefined;
      expect(data?.cwd).toBe(requestedRoot);
    } finally {
      await fs.rm(sessionRoot, { recursive: true, force: true });
      await fs.rm(requestedRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the session cwd when an explicit cwd is missing", async () => {
    const tmpRoot = path.resolve(process.cwd(), `.tmp-shell-cwd-${Date.now()}`);
    await fs.mkdir(tmpRoot, { recursive: true });
    try {
      const roomId = "11111111-aaaa-bbbb-cccc-333333333333";
      const { runtime, session } = await makeRuntime();
      session.setCwd(roomId, tmpRoot);
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(roomId),
        undefined,
        { command: "pwd", cwd: path.join(tmpRoot, "does-not-exist") },
      );
      expect(result.success).toBe(true);
      expect(result.text).toContain(tmpRoot);
      const data = result.data as Record<string, unknown> | undefined;
      expect(data?.cwd).toBe(tmpRoot);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("resets a stale session cwd before running a command", async () => {
    const roomId = "11111111-aaaa-bbbb-cccc-444444444444";
    const stale = path.join(process.cwd(), `.tmp-shell-stale-${Date.now()}`);
    const { runtime, session } = await makeRuntime();
    session.setCwd(roomId, stale);

    const result = await shellAction.handler?.(
      runtime,
      makeMessage(roomId),
      undefined,
      { command: "pwd" },
    );

    const defaultCwd = path.resolve(process.cwd());
    expect(result.success).toBe(true);
    expect(result.text).toContain(defaultCwd);
    expect(session.getCwd(roomId)).toBe(defaultCwd);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.cwd).toBe(defaultCwd);
  });

  it("quotes bare URLs with shell metacharacters before execution", async () => {
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      {
        command:
          'node -e "console.log(process.argv[1])" https://example.com/simple?ids=bitcoin&vs_currencies=usd',
      },
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain(
      "https://example.com/simple?ids=bitcoin&vs_currencies=usd",
    );
    expect(result.text).toContain(
      "'https://example.com/simple?ids=bitcoin&vs_currencies=usd'",
    );
  });

  it("leaves already quoted URLs unchanged", async () => {
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      {
        command:
          'node -e "console.log(process.argv[1])" "https://example.com/simple?ids=bitcoin&vs_currencies=usd"',
      },
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain(
      '"https://example.com/simple?ids=bitcoin&vs_currencies=usd"',
    );
  });

  it("replaces unreliable BTC spot-price endpoints with a neutral no-key source", () => {
    const coindesk = resolveCryptoSpotPriceCommand({
      messageText: "What is the current BTC price in USD?",
      command:
        "curl -s https://api.coindesk.com/v1/bpi/currentprice/BTC.json | grep rate_float",
    });
    expect(coindesk.rewritten).toBe(true);
    expect(coindesk.command).toContain("api.coingecko.com");
    expect(coindesk.command).toContain("ids=bitcoin");
    expect(coindesk.command).not.toContain("coindesk");

    const binance = resolveCryptoSpotPriceCommand({
      messageText: "What is the current BTC price in USD?",
      command:
        "curl -s https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
    });
    expect(binance.rewritten).toBe(true);
    expect(binance.command).toContain("api.coingecko.com");
    expect(binance.command).not.toContain("binance");
  });

  it("keeps non-price commands that happen to mention BTC endpoints", () => {
    const result = resolveCryptoSpotPriceCommand({
      messageText: "Show me this shell command.",
      command:
        "echo https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
    });
    expect(result.rewritten).toBe(false);
    expect(result.command).toContain("binance.com");
  });

  it("adds user-facing text for neutral crypto spot-price JSON", async () => {
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(
        "11111111-aaaa-bbbb-cccc-535353535353",
        "Can you check the current price of BTC in USD?",
      ),
      undefined,
      {
        command:
          'printf \'{"bitcoin":{"usd":77296}}\' # https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      },
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain('{"bitcoin":{"usd":77296}}');
    expect(result.userFacingText).toBe(
      "BTC price: $77,296.00 USD (source: CoinGecko).",
    );
  });

  it("returns command_failed when the command exits non-zero", async () => {
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      { command: "exit 7" },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("command_failed");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.exit_code).toBe(7);
  });

  it("returns command_failed when an earlier pipeline command fails", async () => {
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      { command: "false | true" },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("command_failed");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.output).toContain("[exit 1]");
  });

  it("clears shell history through the canonical SHELL action", async () => {
    const { runtime, shellHistoryService } = await makeRuntime({
      withShellHistoryService: true,
    });
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      { action: "clear_history" },
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("history has been cleared");
    expect(shellHistoryService?.clearCommandHistory).toHaveBeenCalledOnce();
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.action).toBe("clear_history");
  });

  it("views shell history through the canonical SHELL action", async () => {
    const { runtime, shellHistoryService } = await makeRuntime({
      shellHistoryCommands: ["git status", "bun test"],
    });
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      { action: "view_history", limit: 1 },
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("git status");
    expect(result.text).not.toContain("bun test");
    expect(shellHistoryService?.getCommandHistory).toHaveBeenCalledWith(
      expect.any(String),
      1,
    );
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.action).toBe("view_history");
  });
});
