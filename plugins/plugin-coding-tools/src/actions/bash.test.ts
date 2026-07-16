/**
 * Tests for the SHELL action: command execution, timeout clamping, history, and the
 * CHAT command-rewrite behaviour, driven against a real shell and a local HTTP
 * server in-process.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  type ActionResult,
  CAPABILITY_ROUTER_SERVICE_TYPE,
  CapabilityError,
  type ElizaCapabilityRouter,
  type IAgentRuntime,
  type Memory,
  UnavailableCapabilityRouter,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

// These tests exercise the SHELL action through `pwd`, `cd`, `git -C`, and
// inline pipelines. The action itself does run on Windows (it routes to
// `powershell.exe -Command` via `resolveHostShell()`), but the assertions
// here pin the *bash* output shape — output formatting, exit-code framing,
// pipeline composition, and rewrite heuristics that target POSIX commands.
// Porting each assertion to a per-platform expected value would be
// invasive and is out of scope for the Windows compatibility lane; skip
// the suite on Windows and trust the equivalent Linux/macOS runs.
const describeIfPosix = process.platform === "win32" ? describe.skip : describe;

import codingToolsPlugin from "../index.js";
import { runShell } from "../lib/run-shell.js";
import { availableToolsProvider } from "../providers/available-tools.js";
import {
  BackgroundShellService,
  SandboxService,
  SessionCwdService,
} from "../services/index.js";
import {
  BACKGROUND_SHELL_SERVICE,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../types.js";
import {
  type CommandPlatform,
  localResourceUserFacingText,
  resolveCommandPlatform,
  resolveCryptoSpotPriceCommand,
  resolveDiskInspectionCommand,
  resolveLocalStatusCommand,
  resolveSourceInspectionCommand,
  shellAction,
} from "./bash.js";

const execFileAsync = promisify(execFile);

interface RuntimeOptions {
  blockedPaths?: string;
  shellTimeoutMs?: number;
  shellHistoryCommands?: string[];
  withShellHistoryService?: boolean;
  capabilityRouter?: ElizaCapabilityRouter;
  backgroundBufferChars?: number;
}

async function makeRuntime(opts: RuntimeOptions = {}): Promise<{
  runtime: IAgentRuntime;
  sandbox: SandboxService;
  session: SessionCwdService;
  backgroundShell: BackgroundShellService;
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
  if (opts.backgroundBufferChars !== undefined) {
    settings.CODING_TOOLS_BACKGROUND_SHELL_BUFFER_CHARS =
      opts.backgroundBufferChars;
  }

  const services = new Map<string, unknown>();
  const runtime = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    getSetting: vi.fn((key: string) => settings[key]),
    getService: vi.fn(<T>(type: string) => services.get(type) as T | null),
  } as IAgentRuntime;

  const sandbox = await SandboxService.start(runtime);
  const session = await SessionCwdService.start(runtime);
  const backgroundShell = await BackgroundShellService.start(runtime);
  services.set(SANDBOX_SERVICE, sandbox);
  services.set(SESSION_CWD_SERVICE, session);
  services.set(BACKGROUND_SHELL_SERVICE, backgroundShell);
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
  if (opts.capabilityRouter) {
    services.set(CAPABILITY_ROUTER_SERVICE_TYPE, opts.capabilityRouter);
  }

  return { runtime, sandbox, session, backgroundShell, shellHistoryService };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  runtime: IAgentRuntime,
  message: Memory,
  handle: string,
  predicate: (data: Record<string, unknown>, text: string) => boolean,
): Promise<ActionResult> {
  let last: ActionResult | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await shellAction.handler?.(runtime, message, undefined, {
      action: "poll_background",
      handle,
    });
    if (!result) throw new Error("SHELL handler missing");
    last = result;
    if (
      predicate(
        (result.data as Record<string, unknown> | undefined) ?? {},
        result.text ?? "",
      )
    ) {
      return result;
    }
    await delay(50);
  }
  throw new Error(`condition not met; last=${last?.text ?? "(none)"}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function unavailableCapability(
  capability: "fs" | "pty" | "git" | "model",
  method: string,
): never {
  throw new CapabilityError({
    code: "CAPABILITY_UNAVAILABLE",
    message: `${capability} unavailable`,
    capability,
    method,
  });
}

function makeShellRouter(
  runCommand: ElizaCapabilityRouter["pty"]["runCommand"],
): ElizaCapabilityRouter {
  const unavailable = new UnavailableCapabilityRouter("desktop");
  return {
    environment: "desktop",
    availability: async () => ({
      environment: "desktop",
      available: true,
      capabilities: {
        fs: false,
        pty: true,
        git: false,
        model: false,
      },
    }),
    fs: {
      list: async () => unavailableCapability("fs", "fs.list"),
      readText: async () => unavailableCapability("fs", "fs.readText"),
      writeText: async () => unavailableCapability("fs", "fs.writeText"),
    },
    pty: { runCommand },
    git: {
      status: async () => unavailableCapability("git", "git.status"),
      diff: async () => unavailableCapability("git", "git.diff"),
      commandRun: async () => unavailableCapability("git", "git.command.run"),
    },
    model: {
      status: async () => unavailableCapability("model", "model.status"),
    },
    plugin: unavailable.plugin,
  };
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

describeIfPosix("shellAction", () => {
  it("runs local-safe commands through the configured sandbox backend", async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: "sandboxed\n",
      stderr: "",
      durationMs: 12,
      executedInSandbox: true,
    }));
    const runtime = {
      getSetting: vi.fn((key: string) =>
        key === "ELIZA_RUNTIME_MODE" ? "local-safe" : undefined,
      ),
      getService: vi.fn(() => null),
      getSandboxManager: vi.fn(() => ({
        exec,
        engine: { engineType: "docker" },
      })),
    } as unknown as IAgentRuntime;

    const result = await runShell(runtime, {
      command: "printf sandboxed",
      cwd: process.cwd(),
      timeoutMs: 1_000,
    });

    expect(exec).toHaveBeenCalledWith({
      command: "printf sandboxed",
      workdir: "/workspace",
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "sandboxed\n",
      sandbox: "docker",
      timedOut: false,
    });
  });

  it("reports the apple-container sandbox backend", async () => {
    const runtime = {
      getSetting: vi.fn((key: string) =>
        key === "ELIZA_RUNTIME_MODE" ? "local-safe" : undefined,
      ),
      getService: vi.fn(() => null),
      getSandboxManager: vi.fn(() => ({
        engine: { engineType: "apple-container" },
        exec: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
          executedInSandbox: true,
        }),
      })),
    } as unknown as IAgentRuntime;

    const result = await runShell(runtime, {
      command: "true",
      cwd: process.cwd(),
      timeoutMs: 1_000,
    });
    expect(result.sandbox).toBe("apple-container");
  });

  it("maps nested local-safe paths and reports an unknown sandbox backend", async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
      executedInSandbox: true,
    }));
    const runtime = {
      getSetting: vi.fn((key: string) =>
        key === "ELIZA_RUNTIME_MODE" ? "local-safe" : undefined,
      ),
      getService: vi.fn(() => null),
      getSandboxManager: vi.fn(() => ({ exec })),
    } as unknown as IAgentRuntime;
    const cwd = path.join(process.cwd(), "src");

    const result = await runShell(runtime, {
      command: "true",
      cwd,
      timeoutMs: 1_000,
    });

    expect(exec).toHaveBeenCalledWith({
      command: "true",
      workdir: "/workspace/src",
      timeoutMs: 1_000,
    });
    expect(result.sandbox).toBe("none");
  });

  it("refuses local-safe execution without a sandbox manager", async () => {
    const runtime = {
      getSetting: vi.fn((key: string) =>
        key === "ELIZA_RUNTIME_MODE" ? "local-safe" : undefined,
      ),
      getService: vi.fn(() => null),
    } as unknown as IAgentRuntime;

    await expect(
      runShell(runtime, {
        command: "pwd",
        cwd: process.cwd(),
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("requires SandboxManager");
  });

  it("refuses local-safe execution outside the sandbox workspace", async () => {
    const exec = vi.fn();
    const runtime = {
      getSetting: vi.fn((key: string) =>
        key === "ELIZA_RUNTIME_MODE" ? "local-safe" : undefined,
      ),
      getService: vi.fn(() => null),
      getSandboxManager: vi.fn(() => ({ exec })),
    } as unknown as IAgentRuntime;

    await expect(
      runShell(runtime, {
        command: "pwd",
        cwd: os.tmpdir(),
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("outside process workspace");
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses cloud shell execution before touching the host", async () => {
    const runtime = {
      getSetting: vi.fn((key: string) =>
        key === "ELIZA_RUNTIME_MODE" ? "cloud" : undefined,
      ),
      getService: vi.fn(() => null),
    } as unknown as IAgentRuntime;

    await expect(
      runShell(runtime, {
        command: "pwd",
        cwd: process.cwd(),
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("disabled in cloud mode");
  });

  it("exposes coding tools through the provider and plugin auto-enable policy", async () => {
    const providerResult = await availableToolsProvider.get(
      {} as IAgentRuntime,
      makeMessage(),
      {} as State,
    );
    expect(providerResult.text).toContain("start_background");
    expect(providerResult.data?.codingTools).toEqual([
      "FILE",
      "SHELL",
      "WORKTREE",
    ]);

    const shouldEnable = codingToolsPlugin.autoEnable?.shouldEnable;
    expect(shouldEnable).toBeTypeOf("function");
    expect(
      shouldEnable?.(
        { ELIZA_RUNTIME_MODE: "local-yolo" },
        { features: { codingTools: true } },
      ),
    ).toBe(true);
    expect(
      shouldEnable?.(
        { ELIZA_BUILD_VARIANT: "store" },
        { features: { codingTools: true } },
      ),
    ).toBe(false);
    expect(
      shouldEnable?.(
        { ELIZA_PLATFORM: "ios" },
        { features: { "coding-agent": true } },
      ),
    ).toBe(false);
  });

  it("prefers capability router for command execution when available", async () => {
    const calls: Array<{ command: string; cwd?: string; timeoutMs?: number }> =
      [];
    const router = makeShellRouter(async (params) => {
      calls.push(params);
      return {
        output: "routed shell output\n",
        exitCode: 0,
        timedOut: false,
      };
    });
    const { runtime } = await makeRuntime({ capabilityRouter: router });
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      { command: "echo local shell output" },
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("routed shell output");
    expect(result.text).not.toContain("--- stdout ---\nlocal shell output");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("echo local shell output");
  });

  it("runs a simple foreground command (echo hello)", async () => {
    const router = makeShellRouter(async () => ({
      output: "alpha.txt\nsecret",
      exitCode: 0,
      timedOut: false,
    }));
    const { runtime } = await makeRuntime({ capabilityRouter: router });
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
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.command).toBe("echo hello");
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

  it("starts, polls, writes to, lists, and kills a background shell session", async () => {
    const { runtime } = await makeRuntime();
    const message = makeMessage();
    const start = await shellAction.handler?.(runtime, message, undefined, {
      action: "start_background",
      command:
        "printf 'ready\\n'; while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done",
    });

    expect(start?.success).toBe(true);
    const startData = start?.data as Record<string, unknown>;
    const handle = startData.handle as string;
    const session = startData.session as Record<string, unknown>;
    const pid = session.pid as number;
    expect(handle).toMatch(/^bgsh_/);
    expect(isProcessAlive(pid)).toBe(true);

    await pollUntil(runtime, message, handle, (_data, text) =>
      text.includes("ready"),
    );

    const write = await shellAction.handler?.(runtime, message, undefined, {
      action: "write_background",
      handle,
      stdin: "alpha\n",
    });
    expect(write?.success).toBe(true);

    await pollUntil(runtime, message, handle, (_data, text) =>
      text.includes("got:alpha"),
    );

    const list = await shellAction.handler?.(runtime, message, undefined, {
      action: "list_background",
    });
    expect(list?.success).toBe(true);
    expect(list?.text).toContain(handle);

    const killed = await shellAction.handler?.(runtime, message, undefined, {
      action: "kill_background",
      handle,
    });
    expect(killed?.success).toBe(true);
    expect(killed?.text).toContain("status=killed");
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("returns incremental background output using stream offsets", async () => {
    const { runtime } = await makeRuntime();
    const message = makeMessage();
    const start = await shellAction.handler?.(runtime, message, undefined, {
      action: "start_background",
      command:
        "for i in 0 1 2; do printf 'tick-%s\\n' \"$i\"; sleep 0.06; done",
    });
    const handle = (start?.data as Record<string, unknown>).handle as string;

    const first = await pollUntil(runtime, message, handle, (_data, text) =>
      text.includes("tick-0"),
    );
    const firstData = first.data as Record<string, unknown>;
    const stdout = firstData.stdout as Record<string, unknown>;
    const nextOffset = stdout.endOffset as number;

    const second = await pollUntil(
      runtime,
      message,
      handle,
      (_data, text) => text.includes("tick-1") || text.includes("tick-2"),
    );
    expect(second.text).toContain("tick-");

    const incremental = await shellAction.handler?.(
      runtime,
      message,
      undefined,
      {
        action: "poll_background",
        handle,
        stdout_offset: nextOffset,
      },
    );
    expect(incremental?.success).toBe(true);
    expect(incremental?.text).not.toContain("tick-0");

    await pollUntil(
      runtime,
      message,
      handle,
      (data) => data.status === "exited",
    );
  });

  it("reports buffer truncation when background output exceeds the cap", async () => {
    const { runtime } = await makeRuntime({ backgroundBufferChars: 20 });
    const message = makeMessage();
    const start = await shellAction.handler?.(runtime, message, undefined, {
      action: "start_background",
      command: "printf 'abcdefghijklmnopqrstuvwxyz'",
    });
    const handle = (start?.data as Record<string, unknown>).handle as string;

    const poll = await pollUntil(runtime, message, handle, (data) => {
      const stdout = data.stdout as Record<string, unknown> | undefined;
      return (
        data.status === "exited" &&
        typeof stdout?.truncatedBefore === "number" &&
        stdout.truncatedBefore > 0
      );
    });
    const data = poll.data as Record<string, unknown>;
    const stdout = data.stdout as Record<string, unknown>;
    expect(stdout.text).toBe("ghijklmnopqrstuvwxyz");
    expect(stdout.startOffset).toBe(6);
    expect(stdout.endOffset).toBe(26);
    expect(stdout.truncatedBefore).toBe(6);
  });

  it("reaps background sessions during service teardown", async () => {
    const { runtime, backgroundShell } = await makeRuntime();
    const message = makeMessage();
    const start = await shellAction.handler?.(runtime, message, undefined, {
      action: "start_background",
      command: "sleep 30",
    });
    const session = (start?.data as Record<string, unknown>).session as Record<
      string,
      unknown
    >;
    const pid = session.pid as number;
    expect(isProcessAlive(pid)).toBe(true);

    await backgroundShell.stop();
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("fails honestly instead of host-spawning background sessions through capability router", async () => {
    const router = makeShellRouter(async () => ({
      output: "foreground only\n",
      exitCode: 0,
      timedOut: false,
    }));
    const { runtime } = await makeRuntime({ capabilityRouter: router });
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      {
        action: "start_background",
        command: "sleep 30",
      },
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toContain("capability-router");
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

  it("times out shell pipelines without waiting for orphaned children", async () => {
    const started = Date.now();
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      { command: "sleep 5 | cat", timeout: 200 },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("timeout");
    expect(Date.now() - started).toBeLessThan(2_500);
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

  it("replaces broad disk cleanup scans with a bounded candidate probe", () => {
    const result = resolveDiskInspectionCommand({
      messageText:
        "check disk space on / and /home and name the biggest cleanup candidate you can see",
      command:
        "df -h / /home && echo '---' && du -sh /* 2>/dev/null | sort -hr | head -n 5",
      platform: "linux",
    });

    expect(result.rewritten).toBe(true);
    expect(result.command).toContain("df -h / /home");
    expect(result.command).toContain("/tmp");
    expect(result.command).toContain("$HOME/.cache");
    expect(result.command).not.toContain("/*");
    expect(result.command).not.toContain("/home/*");
  });

  it("keeps disk and memory probes together for mixed resource checks", () => {
    const result = resolveDiskInspectionCommand({
      messageText:
        "check disk space and free RAM on this server, summarize the biggest cleanup candidate and memory availability",
      command: "free -m",
      platform: "linux",
    });

    expect(result.rewritten).toBe(true);
    expect(result.command).toContain("df -h / /home");
    expect(result.command).toContain("cleanup candidates");
    expect(result.command).toContain("free -m");
  });

  it("keeps targeted disk commands unchanged", () => {
    const command = "df -h / /home; du -sh /tmp 2>/dev/null";
    const result = resolveDiskInspectionCommand({
      messageText: "check disk space and cleanup candidates",
      command,
    });

    expect(result).toEqual({ command, rewritten: false });
  });

  it("canonicalizes local bot health endpoint probes", () => {
    const result = resolveLocalStatusCommand({
      messageText:
        "check the local bot health endpoint and summarize ready status and plugin counts, concise",
      command: "curl -s http://localhost:3000/health",
      platform: "linux",
    });

    expect(result.rewritten).toBe(true);
    expect(result.kind).toBe("health");
    expect(result.command).toContain("ELIZA_API_PORT");
    expect(result.command).toContain("/api/health");
  });

  it("canonicalizes RAM status probes", () => {
    const result = resolveLocalStatusCommand({
      messageText: "how much RAM is free right now? concise",
      command: "top -b -n 1 | head",
      platform: "linux",
    });

    expect(result).toEqual({
      command: "free -m",
      kind: "memory",
      rewritten: true,
    });
  });

  it("does not let RAM canonicalization erase disk probes", () => {
    const command = "df -h / /home && free -h";
    const result = resolveLocalStatusCommand({
      messageText:
        "check disk space and free RAM on this server, summarize both",
      command,
    });

    expect(result).toEqual({ command, kind: "memory", rewritten: false });
  });

  it("bounds broad local source searches to the current workspace", () => {
    const result = resolveSourceInspectionCommand({
      messageText:
        "does the vendored opencode source include Cerebras endpoint detection? concise",
      command: 'grep -R "Cerebras" /home/example -n 2>/dev/null | head -n 20',
      platform: "linux",
    });

    expect(result.rewritten).toBe(true);
    expect(result.command).toContain("git grep -n --recurse-submodules");
    expect(result.command).toContain("rg -n");
    expect(result.command).toContain("'Cerebras'");
    expect(result.command).toContain(
      "plugins/plugin-agent-orchestrator/vendor/opencode",
    );
    expect(result.command).not.toContain("grep -R");
    expect(result.command).not.toContain("/home/example");
    expect(result.command).not.toContain("head -n");
  });

  it("bounds broad local source directory walks to the requested source root", () => {
    const result = resolveSourceInspectionCommand({
      messageText:
        "does the local vendored opencode source include gpt-oss Cerebras reasoning replay handling? answer with what you find",
      command: "find /home/example -type d -name '*opencode*' 2>/dev/null",
      platform: "linux",
    });

    expect(result.rewritten).toBe(true);
    expect(result.command).toContain('find "$SEARCH_ROOT" -maxdepth 5');
    expect(result.command).toContain("sed -n '1,120p'");
    expect(result.command).toContain(
      "plugins/plugin-agent-orchestrator/vendor/opencode",
    );
    expect(result.command).not.toContain("/home/example");
  });

  it("bounds recursive source directory walks from the current directory", () => {
    const result = resolveSourceInspectionCommand({
      messageText:
        "does the local vendored opencode source include gpt-oss Cerebras reasoning replay handling? answer with what you find",
      command: "ls -R . | head -n 50",
      platform: "linux",
    });

    expect(result.rewritten).toBe(true);
    expect(result.command).toContain('find "$SEARCH_ROOT" -maxdepth 5');
    expect(result.command).toContain("sed -n '1,120p'");
    expect(result.command).toContain(
      "plugins/plugin-agent-orchestrator/vendor/opencode",
    );
    expect(result.command).not.toContain("ls -R");
    expect(result.command).not.toContain("head -n");
  });

  it("bounds recursive source directory walks from absolute home paths", () => {
    const result = resolveSourceInspectionCommand({
      messageText:
        "does the local vendored opencode source include gpt-oss Cerebras reasoning replay handling? answer with what you find",
      command: "ls -R /home/example | grep -i opencode -n",
      platform: "linux",
    });

    expect(result.rewritten).toBe(true);
    expect(result.command).toContain('find "$SEARCH_ROOT" -maxdepth 5');
    expect(result.command).toContain(
      "plugins/plugin-agent-orchestrator/vendor/opencode",
    );
    expect(result.command).not.toContain("ls -R");
    expect(result.command).not.toContain("/home/example");
  });

  it("bounds relative recursive source grep pipelines", () => {
    const result = resolveSourceInspectionCommand({
      messageText:
        "does the local vendored opencode source include gpt-oss Cerebras reasoning replay handling? answer with what you find",
      command:
        'grep -R "cerebrasReasoning" -n plugins/plugin-agent-orchestrator/vendor/opencode | head -n 20',
      platform: "linux",
    });

    expect(result.rewritten).toBe(true);
    expect(result.command).toContain("git grep -n --recurse-submodules");
    expect(result.command).toContain("'cerebrasReasoning'");
    expect(result.command).toContain(
      "plugins/plugin-agent-orchestrator/vendor/opencode",
    );
    expect(result.command).not.toContain("grep -R");
    expect(result.command).not.toContain("head -n");
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

  it("projects safe small list stdout without shell meta-narration", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-list-"));
    await fs.writeFile(path.join(tempDir, "alpha.txt"), "alpha", "utf8");
    await fs.writeFile(path.join(tempDir, "beta.txt"), "beta", "utf8");
    const { runtime } = await makeRuntime();

    try {
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          "11111111-aaaa-bbbb-cccc-585858585858",
          "list the files in this test directory",
        ),
        undefined,
        { command: "ls -1", cwd: tempDir },
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain("$ ls -1");
      expect(result.text).toContain("--- stdout ---");
      expect(result.userFacingText).toBe("alpha.txt\nbeta.txt");
      expect(result.verifiedUserFacing).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("projects safe small grep stdout without shell meta-narration", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-grep-"));
    await fs.writeFile(
      path.join(tempDir, "weather.txt"),
      "weather: clear\nweather: windy\n",
      "utf8",
    );
    const { runtime } = await makeRuntime();

    try {
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          "11111111-aaaa-bbbb-cccc-595959595959",
          "grep the weather lines",
        ),
        undefined,
        { command: "grep -n weather weather.txt", cwd: tempDir },
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain("$ grep -n weather weather.txt");
      expect(result.userFacingText).toBe("1:weather: clear\n2:weather: windy");
      expect(result.verifiedUserFacing).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not verify compound stdout even when it starts with a safe command", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-compound-"));
    await fs.writeFile(path.join(tempDir, "alpha.txt"), "alpha", "utf8");
    const { runtime } = await makeRuntime();

    try {
      for (const command of ["ls -1; printf secret", "pwd && printf secret"]) {
        const result = await shellAction.handler?.(
          runtime,
          makeMessage(
            "11111111-aaaa-bbbb-cccc-606060606060",
            "show me the command output",
          ),
          undefined,
          { command, cwd: tempDir },
        );

        expect(result.userFacingText).toBeUndefined();
        expect(result.verifiedUserFacing).toBeUndefined();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not verify verbose git history or diff stdout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-git-"));
    const { runtime } = await makeRuntime();

    try {
      await execFileAsync("git", ["init"], { cwd: tempDir });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], {
        cwd: tempDir,
      });
      await execFileAsync("git", ["config", "user.name", "Test User"], {
        cwd: tempDir,
      });
      await fs.writeFile(path.join(tempDir, "file.txt"), "before\n", "utf8");
      await execFileAsync("git", ["add", "file.txt"], { cwd: tempDir });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: tempDir });
      await fs.writeFile(path.join(tempDir, "file.txt"), "after\n", "utf8");

      for (const command of ["git diff", "git log --oneline -1"]) {
        const result = await shellAction.handler?.(
          runtime,
          makeMessage(
            "11111111-aaaa-bbbb-cccc-616161616161",
            "show me the git output",
          ),
          undefined,
          { command, cwd: tempDir },
        );

        expect(result.success).toBe(true);
        expect(result.userFacingText).toBeUndefined();
        expect(result.verifiedUserFacing).toBeUndefined();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("adds user-facing text for local health JSON", async () => {
    const previousPort = process.env.ELIZA_API_PORT;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ready":true,"plugins":{"loaded":24,"failed":0}}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("test server did not expose a TCP port");
    }
    process.env.ELIZA_API_PORT = String(address.port);
    const { runtime } = await makeRuntime();
    try {
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          "11111111-aaaa-bbbb-cccc-545454545454",
          "check the local bot health endpoint and summarize ready status and plugin counts, concise",
        ),
        undefined,
        {
          command: "curl -s http://localhost:3000/health",
        },
      );

      expect(result.success).toBe(true);
      expect(result.userFacingText).toBe(
        "Health: ready=true; plugins loaded=24, failed=0.",
      );
    } finally {
      if (previousPort === undefined) delete process.env.ELIZA_API_PORT;
      else process.env.ELIZA_API_PORT = previousPort;
      server.close();
    }
  });

  it("preserves local health JSON returned with a non-2xx status", async () => {
    const previousPort = process.env.ELIZA_API_PORT;
    const server = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"ready":false,"plugins":{"loaded":23,"failed":1}}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("test server did not expose a TCP port");
    }
    process.env.ELIZA_API_PORT = String(address.port);
    const { runtime } = await makeRuntime();
    try {
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          "11111111-aaaa-bbbb-cccc-565656565656",
          "check the local bot health endpoint and summarize ready status and plugin counts, concise",
        ),
        undefined,
        {
          command: "curl -fsS http://localhost:3000/health",
        },
      );

      expect(result.success).toBe(true);
      expect(result.userFacingText).toBe(
        "Health: ready=false; plugins loaded=23, failed=1.",
      );
    } finally {
      if (previousPort === undefined) delete process.env.ELIZA_API_PORT;
      else process.env.ELIZA_API_PORT = previousPort;
      server.close();
    }
  });

  it("adds user-facing text for RAM status output", async () => {
    if (process.platform !== "linux") return;
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(
        "11111111-aaaa-bbbb-cccc-555555555555",
        "how much RAM is free right now? concise",
      ),
      undefined,
      { command: "top -b -n 1 | head" },
    );

    expect(result.success).toBe(true);
    expect(result.userFacingText).toMatch(
      /^Free RAM: \d+ MB \(\d+ MB available\) of \d+ MB total\.$/,
    );
  });

  it("adds user-facing text for mixed disk and RAM output", async () => {
    if (process.platform !== "linux") return;
    const previousHome = process.env.HOME;
    const tmpHome = path.resolve(
      process.cwd(),
      `.tmp-shell-home-${Date.now()}`,
    );
    await fs.mkdir(path.join(tmpHome, ".cache"), { recursive: true });
    await fs.writeFile(path.join(tmpHome, ".cache", "probe.txt"), "cache");
    process.env.HOME = tmpHome;
    try {
      const { runtime } = await makeRuntime();
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          "11111111-aaaa-bbbb-cccc-575757575757",
          "check disk space and free RAM on this server, summarize the biggest cleanup candidate and memory availability",
        ),
        undefined,
        { command: "free -m" },
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain("df -h / /home");
      expect(result.text).toContain("timeout 3s du -sh");
      expect(result.text).toContain("free -m");
      expect(result.userFacingText).toContain("Root disk:");
      expect(result.userFacingText).toContain("Biggest cleanup candidate:");
      expect(result.userFacingText).toMatch(/Free RAM: \d+ MB/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
    // This test runs the REAL disk-intent shell pipeline, which scans /tmp and
    // /var/tmp with `du`. On a busy host with a large /tmp those scans can run
    // well past the 15s package default (the shell's own hard timeout is 120s),
    // so give this real-I/O case its own generous budget.
  }, 90_000);

  it("runs explicit coding sub-agent shell commands without message-text rewrites", async () => {
    const previousMode = process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "shell-coding-subagent-"),
    );
    await fs.writeFile(path.join(tempDir, "sentinel.txt"), "sentinel", "utf8");
    process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = "true";

    try {
      const { runtime } = await makeRuntime();
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          "11111111-aaaa-bbbb-cccc-636363636363",
          "check disk space and free RAM on this server, summarize cleanup candidates and memory availability",
        ),
        undefined,
        { command: "ls -1", cwd: tempDir },
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain("$ ls -1");
      expect(result.text).toContain("sentinel.txt");
      expect(result.text).not.toContain("df -h / /home");
      expect(result.text).not.toContain("--- memory ---");
      expect(result.userFacingText).toBe("sentinel.txt");
      expect(result.verifiedUserFacing).toBe(true);
    } finally {
      if (previousMode === undefined) {
        delete process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
      } else {
        process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = previousMode;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not project a message-intent resource summary for a coding sub-agent", async () => {
    // The sub-agent's message text is its brief + the coding preamble ("make
    // real changes on disk"), which false-matched disk+memory intent. A `cat`
    // of a df-shaped source line must NOT surface as the tool's userFacingText
    // on the sub-agent path — the sub-agent synthesizes its own deliverable.
    const previousMode = process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "shell-subagent-resource-"),
    );
    // A real df-shaped mount line, so only the sub-agent exemption (not the
    // field-shape validation) can suppress the projection here.
    await fs.writeFile(
      path.join(tempDir, "notes.txt"),
      "/dev/root 95G 48G 47G 51% /\n",
      "utf8",
    );
    process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = "true";

    try {
      const { runtime } = await makeRuntime();
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(
          "11111111-aaaa-bbbb-cccc-616161616161",
          "You are Eliza Code, you make real changes on disk; memory available: add multiple claude subscriptions with round robin, check disk space and free RAM",
        ),
        undefined,
        { command: "cat notes.txt", cwd: tempDir },
      );

      expect(result.success).toBe(true);
      expect(result.userFacingText ?? "").not.toContain("Root disk:");
      expect(result.userFacingText ?? "").not.toContain("Free RAM:");
    } finally {
      if (previousMode === undefined) {
        delete process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
      } else {
        process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = previousMode;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not treat later output section markers as cleanup candidates", () => {
    const stdout = [
      "Filesystem      Size  Used Avail Use% Mounted on",
      "/dev/root        95G   48G   47G  51% /",
      "",
      "--- cleanup candidates ---",
      "--- memory ---",
      "               total        used        free      shared  buff/cache   available",
      "Mem:           32000        8000        2000         100       22000       24000",
    ].join("\n");

    const result = localResourceUserFacingText({
      message: makeMessage(
        "11111111-aaaa-bbbb-cccc-585858585858",
        "check disk space and free RAM on this server, summarize the biggest cleanup candidate and memory availability",
      ),
      stdout,
    });

    expect(result).toContain("Root disk: 51% used, 47G available.");
    expect(result).toContain(
      "Free RAM: 2000 MB (24000 MB available) of 32000 MB total.",
    );
    expect(result).not.toContain("Biggest cleanup candidate:");
    expect(result).not.toContain("memory ---");
  });

  it("does not project a `cat`'d source file as a disk summary (live 2026-07-16 leak)", () => {
    // A sub-agent investigating the account pool `cat`'d a source file whose
    // lines ended in `/` with ≥6 whitespace tokens; the old positional match
    // read arbitrary tokens as df columns and produced
    // "Root disk: records used, `LinkedAccountConfig` available.", which the
    // orchestrator then relayed as the deliverable. The message text matches
    // both disk+memory intent (the coding-agent preamble says "on disk"), so
    // the gate is not what protects here — the field-shape validation is.
    const stdout = [
      "// Users link multiple accounts; the LinkedAccountConfig store",
      "// tracks how many records used LinkedAccountConfig available /",
      "export const strategies = ['round-robin', 'priority'] // rotation /",
      "Mem: the in-memory cache holds tokens per accountId /",
    ].join("\n");

    const result = localResourceUserFacingText({
      message: makeMessage(
        "11111111-aaaa-bbbb-cccc-595959595959",
        "You are Eliza Code. You make real changes on disk. Memory available for the task: add multiple claude subscriptions with round robin mode",
      ),
      stdout,
    });

    expect(result).toBeUndefined();
  });

  it("ignores an ls-style line ending in / even when disk intent is present", () => {
    const result = localResourceUserFacingText({
      message: makeMessage(
        "11111111-aaaa-bbbb-cccc-606060606060",
        "check disk space and free RAM on this server, cleanup candidates and memory availability",
      ),
      stdout:
        "drwxr-xr-x  5 user group 4096 records LinkedAccountConfig available /",
    });
    expect(result).toBeUndefined();
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
    expect(data?.command).toBe("exit 7");
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

// These run on every platform (including win32): they pass an explicit
// `platform` so the canned-command dialect is asserted deterministically,
// independent of the host shell the test runner happens to be on.
describe("platform-aware canned resource commands", () => {
  describe("windows (PowerShell)", () => {
    it("rewrites memory probes to a Win32_OperatingSystem query (no `free`)", () => {
      const result = resolveLocalStatusCommand({
        messageText: "how much RAM is free right now? concise",
        command: "top -b -n 1 | head",
        platform: "windows",
      });
      expect(result.kind).toBe("memory");
      expect(result.rewritten).toBe(true);
      expect(result.command).toContain("Win32_OperatingSystem");
      expect(result.command).toContain("Mem:");
      expect(result.command).not.toContain("free -m");
    });

    it("rewrites health probes to Invoke-WebRequest against /api/health", () => {
      const result = resolveLocalStatusCommand({
        messageText:
          "check the local bot health endpoint and summarize ready status and plugin counts, concise",
        command: "curl -s http://localhost:3000/health",
        platform: "windows",
      });
      expect(result.kind).toBe("health");
      expect(result.rewritten).toBe(true);
      expect(result.command).toContain("Invoke-WebRequest");
      expect(result.command).toContain("/api/health");
      expect(result.command).toContain("ELIZA_API_PORT");
      expect(result.command).not.toContain("curl");
    });

    it("rewrites combined disk+memory probes to PowerShell with both markers", () => {
      const result = resolveDiskInspectionCommand({
        messageText:
          "check disk space and free RAM on this server, summarize the biggest cleanup candidate and memory availability",
        command: "free -m",
        platform: "windows",
      });
      expect(result.rewritten).toBe(true);
      expect(result.command).toContain("Get-PSDrive");
      expect(result.command).toContain("--- cleanup candidates ---");
      expect(result.command).toContain("--- memory ---");
      expect(result.command).toContain("Win32_OperatingSystem");
      expect(result.command).not.toContain("free -m");
      expect(result.command).not.toContain("df -h");
    });
  });

  describe("macos", () => {
    it("rewrites memory probes to a vm_stat/sysctl synthesis (no Linux `free`)", () => {
      const result = resolveLocalStatusCommand({
        messageText: "how much RAM is free right now? concise",
        command: "top -l 1 | head",
        platform: "macos",
      });
      expect(result.kind).toBe("memory");
      expect(result.rewritten).toBe(true);
      expect(result.command).toContain("vm_stat");
      expect(result.command).toContain("hw.memsize");
      expect(result.command).not.toContain("free -m");
    });

    it("uses a macOS cleanup-candidate set for broad disk scans", () => {
      const result = resolveDiskInspectionCommand({
        messageText:
          "check disk space on / and name the biggest cleanup candidate you can see",
        command: "df -h / && du -sh /* 2>/dev/null | sort -hr | head -n 5",
        platform: "macos",
      });
      expect(result.rewritten).toBe(true);
      expect(result.command).toContain("Library/Caches");
      expect(result.command).toContain(".Trash");
      expect(result.command).not.toContain("free -m");
    });
  });

  describe("linux", () => {
    it("keeps the POSIX `free -m` memory probe", () => {
      const result = resolveLocalStatusCommand({
        messageText: "how much RAM is free right now? concise",
        command: "top -b -n 1 | head",
        platform: "linux",
      });
      expect(result).toEqual({
        command: "free -m",
        kind: "memory",
        rewritten: true,
      });
    });

    it("keeps the POSIX df/du bounded disk scan", () => {
      const result = resolveDiskInspectionCommand({
        messageText:
          "check disk space on / and /home and name the biggest cleanup candidate you can see",
        command:
          "df -h / /home && du -sh /* 2>/dev/null | sort -hr | head -n 5",
        platform: "linux",
      });
      expect(result.rewritten).toBe(true);
      expect(result.command).toContain("df -h / /home");
      expect(result.command).toContain("$HOME/.cache");
      expect(result.command).not.toContain("Win32_OperatingSystem");
    });
  });

  describe("resolveCommandPlatform", () => {
    it("resolves the host shell to a known platform dialect", () => {
      const platform: CommandPlatform = resolveCommandPlatform();
      expect(["windows", "macos", "linux"]).toContain(platform);
    });
  });

  describe("windows (PowerShell) source inspection", () => {
    it("rewrites a broad source grep to a PowerShell git-grep/rg/Select-String chain (no POSIX find)", () => {
      const result = resolveSourceInspectionCommand({
        messageText:
          "does the vendored opencode source include Cerebras endpoint detection? concise",
        command: 'grep -R "Cerebras" /home/example -n 2>/dev/null | head -n 20',
        platform: "windows",
      });
      expect(result.rewritten).toBe(true);
      expect(result.command).toContain("git grep -n --recurse-submodules");
      expect(result.command).toContain("Get-Command rg");
      expect(result.command).toContain("Select-String");
      expect(result.command).toContain("$LASTEXITCODE");
      expect(result.command).toContain("'Cerebras'");
      // none of the POSIX-only forms survive
      expect(result.command).not.toContain("command -v");
      expect(result.command).not.toContain("2>/dev/null");
      expect(result.command).not.toContain("|| true");
      expect(result.command).not.toContain('[ -d "$SEARCH_ROOT" ]');
    });

    it("rewrites a broad source directory walk to a PowerShell Get-ChildItem listing (no sed)", () => {
      const result = resolveSourceInspectionCommand({
        messageText:
          "does the local vendored opencode source include gpt-oss Cerebras reasoning replay handling? answer with what you find",
        command: "find /home/example -type d -name '*opencode*' 2>/dev/null",
        platform: "windows",
      });
      expect(result.rewritten).toBe(true);
      expect(result.command).toContain("Get-ChildItem");
      expect(result.command).toContain("-notmatch");
      expect(result.command).toContain("node_modules");
      expect(result.command).not.toContain("sed -n");
      expect(result.command).not.toContain('find "$SEARCH_ROOT"');
    });
  });
});
