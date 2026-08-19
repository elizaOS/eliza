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
  AgentRuntime,
  CAPABILITY_ROUTER_SERVICE_TYPE,
  CapabilityError,
  type Character,
  logger as coreLogger,
  type ElizaCapabilityRouter,
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
  UnavailableCapabilityRouter,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const originalEchoTranscript = process.env.ELIZA_SHELL_ECHO_TRANSCRIPT;

afterEach(() => {
  if (originalEchoTranscript === undefined) {
    delete process.env.ELIZA_SHELL_ECHO_TRANSCRIPT;
  } else {
    process.env.ELIZA_SHELL_ECHO_TRANSCRIPT = originalEchoTranscript;
  }
});

const execFileAsync = promisify(execFile);

async function createRecursiveDeleteCommand(): Promise<{
  command: string;
  target: string;
}> {
  const target = await fs.mkdtemp(
    path.join(os.tmpdir(), "coding-tools-destructive-gate-"),
  );
  const quotedTarget =
    process.platform === "win32"
      ? `'${target.replaceAll("'", "''")}'`
      : `'${target.replaceAll("'", "'\\''")}'`;
  return {
    target,
    command:
      process.platform === "win32"
        ? `Remove-Item -LiteralPath ${quotedTarget} -Recurse -Force`
        : `rm -rf ${quotedTarget}`,
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    // error-policy:J3 filesystem probe; a missing path is the explicit signal.
    return false;
  }
}

async function withShellTimeoutEnv<T>(
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const key = "CODING_TOOLS_SHELL_TIMEOUT_MS";
  const previousValue = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await run();
  } finally {
    if (previousValue === undefined) delete process.env[key];
    else process.env[key] = previousValue;
  }
}

interface RuntimeOptions {
  blockedPaths?: string;
  shellTimeoutMs?: unknown;
  shellHistoryCommands?: string[];
  withShellHistoryService?: boolean;
  capabilityRouter?: ElizaCapabilityRouter;
  backgroundBufferChars?: number;
  configuredSecret?: string;
}

type RuntimeSecretFragment = Parameters<
  IAgentRuntime["locateConfiguredSecretFragmentTaint"]
>[0][number];

function requireActionResult(result: ActionResult | undefined): ActionResult {
  if (!result) throw new Error("Expected SHELL action result");
  return result;
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
  const character = {
    name: "coding-tools-test",
    ...(opts.configuredSecret
      ? { settings: { secrets: { TEST_SECRET: opts.configuredSecret } } }
      : {}),
  } as Character;
  const secretOwner = new AgentRuntime({ character });
  const runtime = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    actions: [shellAction],
    character,
    getSetting: vi.fn((key: string) => settings[key]),
    getService: vi.fn(<T>(type: string) => services.get(type) as T | null),
    redactSecrets: vi.fn((text: string) =>
      opts.configuredSecret
        ? text.replaceAll(opts.configuredSecret, "[REDACTED:TEST_SECRET]")
        : text,
    ),
    locateConfiguredSecretFragmentTaint: vi.fn(
      (fragments: readonly RuntimeSecretFragment[]) =>
        secretOwner.locateConfiguredSecretFragmentTaint(fragments),
    ),
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
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
      "WEB_FETCH",
      "WEB_SEARCH",
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

  it("caps only the visible callback for long foreground output", async () => {
    process.env.ELIZA_SHELL_ECHO_TRANSCRIPT = "1";
    const lines = Array.from(
      { length: 300 },
      (_, index) =>
        `foreground-${index.toString().padStart(3, "0")}-xxxxxxxxxxxxxxxxxxxx`,
    );
    const router = makeShellRouter(async () => ({
      output: lines.join("\n"),
      exitCode: 0,
      timedOut: false,
    }));
    const { runtime } = await makeRuntime({ capabilityRouter: router });
    const posts: Array<{ text: string; source?: string }> = [];

    const result = requireActionResult(
      await shellAction.handler?.(
        runtime,
        makeMessage(),
        undefined,
        { command: "printf long-output" },
        async (content) => {
          posts.push(content as { text: string; source?: string });
          return [];
        },
      ),
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain(lines[0]);
    expect(result.text).toContain(lines[150]);
    expect(result.text).toContain(lines[299]);
    expect(result.text).not.toContain("lines omitted — ask to see more");

    expect(posts).toHaveLength(1);
    expect(posts[0].source).toBe("coding-tools");
    expect(posts[0].text.startsWith("```")).toBe(true);
    expect(posts[0].text.trimEnd().endsWith("```")).toBe(true);
    expect(posts[0].text).toContain(lines[0]);
    expect(posts[0].text).not.toContain(lines[150]);
    expect(posts[0].text).toContain(lines[299]);
    expect(posts[0].text).toMatch(/\[\d+ lines omitted — ask to see more\]/);
    expect(posts[0].text.length).toBeLessThan(1700);
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
    const handle = (requireActionResult(start).data as Record<string, unknown>)
      .handle as string;

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

  it("fences every user-facing background/history relay (#16563)", async () => {
    process.env.ELIZA_SHELL_ECHO_TRANSCRIPT = "1";
    const { runtime } = await makeRuntime();
    const message = makeMessage();
    const posts: Array<{ text: string; source?: string }> = [];
    const cb = async (content: unknown) => {
      posts.push(content as { text: string; source?: string });
      return [];
    };

    // start_background echoes `$ command` — the literal italics-eaten shape
    // from #16542's repro when the command carries paired asterisks.
    const start = await shellAction.handler?.(
      runtime,
      message,
      undefined,
      {
        action: "start_background",
        command: "printf 'globs: *.md and *.ts'",
      },
      cb,
    );
    const handle = (requireActionResult(start).data as Record<string, unknown>)
      .handle as string;

    await shellAction.handler?.(
      runtime,
      message,
      undefined,
      { action: "poll_background", handle },
      cb,
    );
    await shellAction.handler?.(
      runtime,
      message,
      undefined,
      { action: "list_background" },
      cb,
    );
    // view_history needs the shell-history service this harness does not
    // register; its relay shares the same fencePreformatted call (#16563).

    expect(posts.length).toBe(3);
    for (const post of posts) {
      expect(post.source).toBe("coding-tools");
      expect(post.text.startsWith("```")).toBe(true);
      expect(post.text.trimEnd().endsWith("```")).toBe(true);
    }

    await pollUntil(
      runtime,
      message,
      handle,
      (data) => data.status === "exited",
    );
  });

  it("caps only the visible callback for long background polls", async () => {
    const { runtime } = await makeRuntime();
    const message = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, message, undefined, {
        action: "start_background",
        command:
          'i=0; while [ "$i" -lt 300 ]; do printf \'background-%03d-xxxxxxxxxxxxxxxxxxxx\\n\' "$i"; i=$((i + 1)); done',
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    await pollUntil(
      runtime,
      message,
      handle,
      (data) => data.status === "exited",
    );
    const posts: Array<{ text: string; source?: string }> = [];

    const result = requireActionResult(
      await shellAction.handler?.(
        runtime,
        message,
        undefined,
        { action: "poll_background", handle },
        async (content) => {
          posts.push(content as { text: string; source?: string });
          return [];
        },
      ),
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("background-000-xxxxxxxxxxxxxxxxxxxx");
    expect(result.text).toContain("background-150-xxxxxxxxxxxxxxxxxxxx");
    expect(result.text).toContain("background-299-xxxxxxxxxxxxxxxxxxxx");
    expect(result.text).not.toContain("lines omitted — ask to see more");

    expect(posts).toHaveLength(1);
    expect(posts[0].source).toBe("coding-tools");
    expect(posts[0].text.startsWith("```")).toBe(true);
    expect(posts[0].text.trimEnd().endsWith("```")).toBe(true);
    expect(posts[0].text).toContain("background-000-xxxxxxxxxxxxxxxxxxxx");
    expect(posts[0].text).not.toContain("background-150-xxxxxxxxxxxxxxxxxxxx");
    expect(posts[0].text).toContain("background-299-xxxxxxxxxxxxxxxxxxxx");
    expect(posts[0].text).toMatch(/\[\d+ lines omitted — ask to see more\]/);
    expect(posts[0].text.length).toBeLessThan(1700);
  });

  it("reports buffer truncation when background output exceeds the cap", async () => {
    const { runtime } = await makeRuntime({ backgroundBufferChars: 20 });
    const message = makeMessage();
    const start = await shellAction.handler?.(runtime, message, undefined, {
      action: "start_background",
      command: "printf 'abcdefghijklmnopqrstuvwxyz'",
    });
    const handle = (requireActionResult(start).data as Record<string, unknown>)
      .handle as string;

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
    const session = (requireActionResult(start).data as Record<string, unknown>)
      .session as Record<string, unknown>;
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

  it("redacts a configured bare secret from foreground text, callback, data, and user-facing output", async () => {
    process.env.ELIZA_SHELL_ECHO_TRANSCRIPT = "1";
    const secret = "orchid42";
    const router = makeShellRouter(async () => ({
      output: `${secret}\n`,
      exitCode: 0,
      timedOut: false,
    }));
    const { runtime } = await makeRuntime({
      capabilityRouter: router,
      configuredSecret: secret,
    });
    const posts: Array<{ text: string }> = [];

    const result = requireActionResult(
      await shellAction.handler?.(
        runtime,
        makeMessage(),
        undefined,
        { command: `rg Authorization --token ${secret}` },
        async (content) => {
          posts.push(content as { text: string });
          return [];
        },
      ),
    );

    const exposed = JSON.stringify({ result, posts });
    expect(exposed).not.toContain(secret);
  });

  it("applies pattern redaction even without a configured literal secret", async () => {
    const token = "token-value-123456789";
    const router = makeShellRouter(async () => ({
      output: `Bearer ${token}\n`,
      exitCode: 0,
      timedOut: false,
    }));
    const { runtime } = await makeRuntime({ capabilityRouter: router });

    const result = requireActionResult(
      await shellAction.handler?.(runtime, makeMessage(), undefined, {
        command: `printf 'Bearer ${token}'`,
      }),
    );

    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("redacts cwd validation and destructive-confirmation failures", async () => {
    const secret = "orchid42";
    const blockedCwd = path.join(process.cwd(), secret);
    const { runtime } = await makeRuntime({
      blockedPaths: blockedCwd,
      configuredSecret: secret,
    });

    const cwdFailure = requireActionResult(
      await shellAction.handler?.(runtime, makeMessage(), undefined, {
        command: "true",
        cwd: blockedCwd,
      }),
    );
    const destructiveFailure = requireActionResult(
      await shellAction.handler?.(runtime, makeMessage(), undefined, {
        command: `mkfs.${secret} /tmp/${secret}`,
      }),
    );

    expect(cwdFailure.success).toBe(false);
    expect(destructiveFailure.success).toBe(false);
    expect(JSON.stringify({ cwdFailure, destructiveFailure })).not.toContain(
      secret,
    );
  });

  it("builds planner summaries only from the redacted result command", async () => {
    const secret = "summary-secret";
    const router = makeShellRouter(async () => ({
      output: "ok\n",
      exitCode: 0,
      timedOut: false,
    }));
    const { runtime } = await makeRuntime({
      capabilityRouter: router,
      configuredSecret: secret,
    });
    const params = { command: `printf '%s' '${secret}'` };
    const result = requireActionResult(
      await shellAction.handler?.(runtime, makeMessage(), undefined, params),
    );

    const summary = shellAction.summarize?.(result, params);
    expect(summary).toContain("[REDACTED:TEST_SECRET]");
    expect(summary).not.toContain(secret);
  });

  it("redacts cwd values in structured shell logs", async () => {
    const secret = "log-secret";
    const missingCwd = path.join(process.cwd(), `${secret}-missing`);
    const router = makeShellRouter(async () => ({
      output: "ok\n",
      exitCode: 0,
      timedOut: false,
    }));
    const { runtime } = await makeRuntime({
      capabilityRouter: router,
      configuredSecret: secret,
    });
    const logger = coreLogger as unknown as Record<
      "debug" | "info" | "warn",
      (...args: unknown[]) => void
    >;
    const original = {
      debug: logger.debug,
      info: logger.info,
      warn: logger.warn,
    };
    const logs: unknown[] = [];
    logger.debug = (...args) => logs.push(args);
    logger.info = (...args) => logs.push(args);
    logger.warn = (...args) => logs.push(args);

    try {
      const result = requireActionResult(
        await shellAction.handler?.(runtime, makeMessage(), undefined, {
          command: "true",
          cwd: missingCwd,
        }),
      );
      expect(result.success).toBe(true);
    } finally {
      logger.debug = original.debug;
      logger.info = original.info;
      logger.warn = original.warn;
    }

    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(JSON.stringify(logs)).toContain("[REDACTED:TEST_SECRET]");
  });

  it("redacts a configured bare secret from every background session projection", async () => {
    const secret = "violet73";
    const { runtime } = await makeRuntime({ configuredSecret: secret });
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command: `printf '%s\\n' '${secret}'`,
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    const poll = await pollUntil(
      runtime,
      actor,
      handle,
      (data) => data.status === "exited",
    );
    const partialPoll = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "poll_background",
        handle,
        stdout_offset: 3,
      }),
    );
    const list = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "list_background",
      }),
    );

    const exposed = JSON.stringify({ start, poll, partialPoll, list });
    expect(exposed).not.toContain(secret);
    expect(
      (
        (partialPoll.data as Record<string, unknown>).stdout as Record<
          string,
          unknown
        >
      ).startOffset,
    ).toBe(3);
  });

  it("omits tainted output when the former fragment marker is itself a secret", async () => {
    const secret = "[REDACTED:configured-secret-fragment]";
    const { runtime } = await makeRuntime();
    runtime.character.settings = {
      secrets: { "configured-secret-fragment": secret },
    };
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command:
          "printf '[REDACTED:'; sleep 0.05; printf 'configured-secret-fragment]'",
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    const poll = await pollUntil(
      runtime,
      actor,
      handle,
      (data) => data.status === "exited",
    );
    const stdout = (poll.data as Record<string, unknown>).stdout as Record<
      string,
      unknown
    >;

    expect(stdout.text).toBe("");
    expect(JSON.stringify(poll)).not.toContain(secret);
  });

  it("maps a configured secret across ordered stdout and stderr fragments without breaking offsets", async () => {
    const secret = "marigold9";
    const { runtime } = await makeRuntime({ configuredSecret: secret });
    const actor = makeMessage();
    const command = [
      "printf '\\x6d\\x61\\x72\\x69X'",
      "sleep 0.05",
      "printf '\\x67\\x6f\\x6c\\x64\\x39' >&2",
      "sleep 0.05",
      "printf 'later-safe'",
    ].join("; ");
    const posts: Array<{ text: string }> = [];
    const callback = async (content: unknown) => {
      posts.push(content as { text: string });
      return [];
    };
    const start = requireActionResult(
      await shellAction.handler?.(
        runtime,
        actor,
        undefined,
        { action: "start_background", command },
        callback,
      ),
    );
    expect((start.data as Record<string, unknown>).command).toBe(command);
    const handle = (start.data as Record<string, unknown>).handle as string;
    const poll = await pollUntil(
      runtime,
      actor,
      handle,
      (data) => data.status === "exited",
    );
    const data = poll.data as Record<string, unknown>;
    const stdout = data.stdout as Record<string, unknown>;
    const stderr = data.stderr as Record<string, unknown>;

    expect(JSON.stringify({ stdout, stderr })).not.toContain("mari");
    expect(JSON.stringify({ stdout, stderr })).not.toContain("gold9");
    expect(stdout.text).toBe("Xlater-safe");
    expect(stderr.text).toBe("");
    expect(stdout.startOffset).toBe(0);
    expect(stdout.endOffset).toBe("mariXlater-safe".length);
    expect(stderr.startOffset).toBe(0);
    expect(stderr.endOffset).toBe("gold9".length);
    expect(
      vi
        .mocked(runtime.locateConfiguredSecretFragmentTaint)
        .mock.calls.some(
          ([fragments]) =>
            fragments.map((fragment) => fragment.source).join(",") ===
              "stdout,stderr,stdout" &&
            fragments[0]?.startOffset === 0 &&
            fragments[1]?.startOffset === 0 &&
            fragments[2]?.startOffset === "mariX".length,
        ),
    ).toBe(true);

    const repeated = requireActionResult(
      await shellAction.handler?.(
        runtime,
        actor,
        undefined,
        {
          action: "poll_background",
          handle,
          stdout_offset: 0,
          stderr_offset: 0,
        },
        callback,
      ),
    );
    expect(repeated.data).toMatchObject({ stdout, stderr });
    const list = requireActionResult(
      await shellAction.handler?.(
        runtime,
        actor,
        undefined,
        { action: "list_background" },
        callback,
      ),
    );
    expect(JSON.stringify({ repeated, list, posts })).not.toContain("mari");
    expect(JSON.stringify({ repeated, list, posts })).not.toContain("gold9");

    const afterTaint = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "poll_background",
        handle,
        stdout_offset: 4,
        stderr_offset: 99,
      }),
    );
    const afterData = afterTaint.data as Record<string, unknown>;
    expect(afterData.stdout).toMatchObject({
      text: "Xlater-safe",
      startOffset: 4,
      endOffset: "mariXlater-safe".length,
    });
    expect(afterData.stderr).toMatchObject({
      text: "",
      startOffset: "gold9".length,
      endOffset: "gold9".length,
    });
    expect(JSON.stringify(afterTaint)).not.toContain(secret);
  });

  it("keeps a split configured secret tainted through tiny visible caps", async () => {
    const secret = "marigold9";
    const { runtime } = await makeRuntime({
      configuredSecret: secret,
      backgroundBufferChars: 5,
    });
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command:
          "printf '\\x6d\\x61\\x72\\x69X'; sleep 0.05; printf '\\x67\\x6f\\x6c\\x64\\x39' >&2; sleep 0.05; printf 'later-safe'",
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    const poll = await pollUntil(
      runtime,
      actor,
      handle,
      (data) => data.status === "exited",
    );
    const data = poll.data as Record<string, unknown>;

    expect(
      JSON.stringify({ stdout: data.stdout, stderr: data.stderr }),
    ).not.toContain("mari");
    expect(
      JSON.stringify({ stdout: data.stdout, stderr: data.stderr }),
    ).not.toContain("gold9");
    expect(data.stdout).toMatchObject({
      text: "-safe",
      startOffset: "mariXlater-safe".length - 5,
      endOffset: "mariXlater-safe".length,
    });
    expect((data.stderr as Record<string, unknown>).text).toBe("");
  });

  it("preserves same-stream event boundaries around harmless bytes", async () => {
    const secret = "marigold9";
    const { runtime } = await makeRuntime({ configuredSecret: secret });
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command:
          "printf '\\x6d\\x61\\x72\\x69X'; sleep 0.05; printf '\\x67\\x6f\\x6c\\x64\\x39'; sleep 0.05; printf 'later-safe'",
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    const poll = await pollUntil(
      runtime,
      actor,
      handle,
      (data) => data.status === "exited",
    );
    const stdout = (poll.data as Record<string, unknown>).stdout as Record<
      string,
      unknown
    >;

    expect(stdout.startOffset).toBe(0);
    expect(stdout.endOffset).toBe("mariXgold9later-safe".length);
    expect(stdout.text).toContain("X");
    expect(stdout.text).toContain("later-safe");
    expect(JSON.stringify(stdout)).not.toContain("mari");
    expect(JSON.stringify(stdout)).not.toContain("gold9");
    expect(
      vi
        .mocked(runtime.locateConfiguredSecretFragmentTaint)
        .mock.calls.some(
          ([fragments]) =>
            fragments.map((fragment) => fragment.source).join(",") ===
            "stdout,stdout,stdout",
        ),
    ).toBe(true);
  });

  it("taints both public stream presentation orders", async () => {
    const secret = "marigold9";
    const { runtime } = await makeRuntime({ configuredSecret: secret });
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command:
          "printf '\\x67\\x6f\\x6c\\x64\\x39' >&2; sleep 0.05; printf '\\x6d\\x61\\x72\\x69X'",
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    const poll = await pollUntil(
      runtime,
      actor,
      handle,
      (data) => data.status === "exited",
    );
    const data = poll.data as Record<string, unknown>;
    const exposed = JSON.stringify({
      stdout: data.stdout,
      stderr: data.stderr,
    });

    expect(exposed).not.toContain("mari");
    expect(exposed).not.toContain("gold9");
    expect((data.stdout as Record<string, unknown>).text).toBe("X");
    expect((data.stderr as Record<string, unknown>).text).toBe("");
  });

  it("fails closed when the runtime cannot complete fragment analysis", async () => {
    const { runtime } = await makeRuntime();
    vi.mocked(runtime.locateConfiguredSecretFragmentTaint).mockReturnValue({
      status: "incomplete",
      reason: "resource-limit",
      ranges: [],
      maxSecretLength: 128,
      profileRevision: 1,
    });
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command: "printf 'safe-output'",
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    const poll = await pollUntil(
      runtime,
      actor,
      handle,
      (data) => data.status === "exited",
    );

    expect(
      ((poll.data as Record<string, unknown>).stdout as Record<string, unknown>)
        .text,
    ).toBe("");
    expect(poll.text).not.toContain("safe-output");
  });

  it("bounds an incomplete scan and releases later safe output", async () => {
    const { runtime } = await makeRuntime();
    vi.mocked(runtime.locateConfiguredSecretFragmentTaint).mockImplementation(
      (fragments: readonly RuntimeSecretFragment[]) =>
        fragments.some((fragment) => fragment.text.includes("unsafe"))
          ? {
              status: "incomplete",
              reason: "resource-limit",
              ranges: [],
              maxSecretLength: 8,
              profileRevision: 1,
            }
          : {
              status: "complete",
              ranges: [],
              maxSecretLength: 8,
              profileRevision: 1,
            },
    );
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command:
          "printf 'unsafe'; sleep 0.05; printf '12345678'; sleep 0.05; printf 'later-safe'",
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    const poll = await pollUntil(
      runtime,
      actor,
      handle,
      (data) => data.status === "exited",
    );
    const stdout = (poll.data as Record<string, unknown>).stdout as Record<
      string,
      unknown
    >;

    expect(stdout.text).toBe("later-safe");
    expect(stdout.text).not.toContain("unsafe");
    expect(stdout.text).not.toContain("12345678");
  });

  it("does not let one stream consume another stream's recovery window", async () => {
    const { runtime, backgroundShell } = await makeRuntime();
    let injectedIncomplete = false;
    vi.mocked(runtime.locateConfiguredSecretFragmentTaint).mockImplementation(
      (fragments: readonly RuntimeSecretFragment[]) => {
        if (
          !injectedIncomplete &&
          fragments.some((fragment) => fragment.text.includes("TRIGGER"))
        ) {
          injectedIncomplete = true;
          return {
            status: "incomplete",
            reason: "resource-limit",
            ranges: [],
            maxSecretLength: 9,
            profileRevision: 1,
          };
        }
        return {
          status: "complete",
          ranges: [],
          maxSecretLength: 9,
          profileRevision: 1,
        };
      },
    );
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command: [
          "printf '\\x6d\\x61\\x72\\x69'",
          "sleep 0.15",
          "printf 'TRIGGER' >&2",
          "sleep 0.15",
          "printf 'yyyyyyyyy'",
          "sleep 0.15",
          "printf '\\x67\\x6f\\x6c\\x64\\x39' >&2",
        ].join("; "),
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    const first = await pollUntil(runtime, actor, handle, (data) => {
      const stdout = data.stdout as Record<string, unknown> | undefined;
      const stderr = data.stderr as Record<string, unknown> | undefined;
      return stdout?.text === "mari" && stderr?.text === "";
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const status = backgroundShell
        .list(String(actor.roomId))
        .find((candidate) => candidate.handle === handle)?.status;
      if (status === "exited") break;
      await delay(25);
    }
    const later = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "poll_background",
        handle,
        stdout_offset: 4,
        stderr_offset: 0,
      }),
    );
    const firstStdout = (
      (first.data as Record<string, unknown>).stdout as Record<string, unknown>
    ).text as string;
    const laterData = later.data as Record<string, unknown>;
    const laterStderr = (laterData.stderr as Record<string, unknown>)
      .text as string;

    expect(injectedIncomplete).toBe(true);
    expect(firstStdout).toBe("mari");
    expect(laterStderr).toBe("");
    expect(laterStderr).not.toContain("gold9");
    expect(firstStdout + laterStderr).not.toContain("marigold9");
    expect((laterData.stdout as Record<string, unknown>).text).not.toContain(
      "yyyyyyyyy",
    );
  });

  it("keeps an eviction-split configured secret inside the private overlap", async () => {
    const secret = "violet73";
    const payload = `${"a".repeat(26)}${secret}${"z".repeat(16)}`;
    const { runtime } = await makeRuntime({
      backgroundBufferChars: 20,
      configuredSecret: secret,
    });
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command: `printf '%s' '${payload}'`,
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    const poll = await pollUntil(runtime, actor, handle, (data) => {
      const stdout = data.stdout as Record<string, unknown> | undefined;
      return data.status === "exited" && stdout?.truncatedBefore === 30;
    });
    const stdout = (poll.data as Record<string, unknown>).stdout as Record<
      string,
      unknown
    >;

    expect(stdout.text).toBe("z".repeat(16));
    expect(stdout.startOffset).toBe(30);
    expect(JSON.stringify(poll)).not.toContain(secret);
    expect(JSON.stringify(poll)).not.toContain(secret.slice(4));
  });

  it("expands the private overlap when a configured secret rotates", async () => {
    const rotatedSecret = "rotated-secret-value-LEAK_SENTINEL_9Q";
    const payload = `${"a".repeat(10)}${rotatedSecret}${"z".repeat(8)}`;
    const { runtime } = await makeRuntime({ backgroundBufferChars: 20 });
    runtime.character.settings = {
      secrets: { ROTATED_SECRET: rotatedSecret },
    };
    vi.mocked(runtime.redactSecrets).mockImplementation((text: string) =>
      text.replaceAll(rotatedSecret, "[REDACTED:ROTATED_SECRET]"),
    );
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command: `printf '%s' '${payload}'`,
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    const poll = await pollUntil(runtime, actor, handle, (data) => {
      const stdout = data.stdout as Record<string, unknown> | undefined;
      return (
        data.status === "exited" &&
        stdout?.truncatedBefore === payload.length - 20
      );
    });

    expect(
      ((poll.data as Record<string, unknown>).stdout as Record<string, unknown>)
        .text,
    ).toBe("z".repeat(8));
    expect(JSON.stringify(poll)).not.toContain(rotatedSecret.slice(-12));
  });

  it("invalidates retained output on secret rotation and recovers in a fresh session", async () => {
    const rotatedSecret = "marigold9";
    const { runtime, backgroundShell } = await makeRuntime();
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command:
          "printf '\\x6d\\x61\\x72\\x69X'; sleep 0.05; printf '\\x67\\x6f\\x6c\\x64\\x39' >&2",
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const session = backgroundShell
        .list(String(actor.roomId))
        .find((candidate) => candidate.handle === handle);
      if (session?.status === "exited") break;
      await delay(25);
    }
    expect(
      backgroundShell
        .list(String(actor.roomId))
        .find((candidate) => candidate.handle === handle)?.status,
    ).toBe("exited");

    runtime.character.settings = {
      secrets: { ROTATED_SECRET: rotatedSecret },
    };
    vi.mocked(runtime.redactSecrets).mockImplementation((text: string) =>
      text.replaceAll(rotatedSecret, "[REDACTED:ROTATED_SECRET]"),
    );

    const poll = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "poll_background",
        handle,
        stdout_offset: 0,
        stderr_offset: 0,
      }),
    );
    const data = poll.data as Record<string, unknown>;
    expect(
      JSON.stringify({ stdout: data.stdout, stderr: data.stderr }),
    ).not.toContain("mari");
    expect(
      JSON.stringify({ stdout: data.stdout, stderr: data.stderr }),
    ).not.toContain("gold9");
    expect((data.stdout as Record<string, unknown>).text).toBe("");
    expect((data.stderr as Record<string, unknown>).text).toBe("");

    const freshStart = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command: "printf 'later-safe'",
      }),
    );
    const freshHandle = (freshStart.data as Record<string, unknown>)
      .handle as string;
    const freshPoll = await pollUntil(
      runtime,
      actor,
      freshHandle,
      (freshData) => freshData.status === "exited",
    );
    expect(freshPoll.text).toContain("later-safe");
  });

  it("omits invalidated output when a rotated secret equals the former marker", async () => {
    const marker = "[REDACTED:fragment-scan-incomplete]";
    const { runtime, backgroundShell } = await makeRuntime();
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command: "printf 'retained-output'",
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const session = backgroundShell
        .list(String(actor.roomId))
        .find((candidate) => candidate.handle === handle);
      if (session?.status === "exited") break;
      await delay(25);
    }

    runtime.character.settings = {
      secrets: { "fragment-scan-incomplete": marker },
    };
    const poll = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "poll_background",
        handle,
        stdout_offset: 0,
      }),
    );

    expect(JSON.stringify(poll)).not.toContain(marker);
    expect(
      ((poll.data as Record<string, unknown>).stdout as Record<string, unknown>)
        .text,
    ).toBe("");
  });

  it("omits output for an oversized profile containing the former marker", async () => {
    const marker = "[REDACTED:fragment-scan-incomplete]";
    const { runtime } = await makeRuntime();
    runtime.character.settings = {
      secrets: Object.fromEntries(
        Array.from({ length: 129 }, (_, index) => [
          index === 0 ? "fragment-scan-incomplete" : `SECRET_${index}`,
          index === 0
            ? marker
            : `secret-value-${index.toString().padStart(3, "0")}`,
        ]),
      ),
    };
    const actor = makeMessage();
    const start = requireActionResult(
      await shellAction.handler?.(runtime, actor, undefined, {
        action: "start_background",
        command: "printf 'safe-output'",
      }),
    );
    const handle = (start.data as Record<string, unknown>).handle as string;
    const poll = await pollUntil(
      runtime,
      actor,
      handle,
      (data) => data.status === "exited",
    );

    expect(JSON.stringify(poll)).not.toContain(marker);
    expect(
      ((poll.data as Record<string, unknown>).stdout as Record<string, unknown>)
        .text,
    ).toBe("");
  });
});

describe("shell structured operation routing", () => {
  it.each([
    [
      "show command history under /tmp/history",
      "printf structured-view-authority",
      "structured-view-authority",
    ],
    [
      "clear shell history under /tmp/history",
      "printf structured-clear-authority",
      "structured-clear-authority",
    ],
  ])(
    "executes a structured command despite history-like message text: %s",
    async (text, command, output) => {
      const calls: Array<{ command: string }> = [];
      const router = makeShellRouter(async (params) => {
        calls.push(params);
        return { output: `${output}\n`, exitCode: 0, timedOut: false };
      });
      const { runtime, shellHistoryService } = await makeRuntime({
        capabilityRouter: router,
        withShellHistoryService: true,
      });

      const result = await executePlannedToolCall(
        runtime,
        {
          message: makeMessage(undefined, text),
          activeContexts: ["code"],
          userRoles: ["OWNER"],
        },
        { name: "SHELL", params: { command } },
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain(output);
      expect(calls).toEqual([expect.objectContaining({ command })]);
      expect(shellHistoryService?.getCommandHistory).not.toHaveBeenCalled();
      expect(shellHistoryService?.clearCommandHistory).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["non-string", { nested: "command" }],
  ] as const)(
    "rejects a %s command without inferring a history operation",
    async (_label, command) => {
      const calls: Array<{ command: string }> = [];
      const router = makeShellRouter(async (params) => {
        calls.push(params);
        return { output: "unexpected\n", exitCode: 0, timedOut: false };
      });
      const { runtime, shellHistoryService } = await makeRuntime({
        capabilityRouter: router,
        withShellHistoryService: true,
      });

      const result = await shellAction.handler?.(
        runtime,
        makeMessage(undefined, "show and clear shell command history"),
        undefined,
        { command },
      );

      expect(result?.success).toBe(false);
      expect(result?.text).toContain("missing_param");
      expect(calls).toHaveLength(0);
      expect(shellHistoryService?.getCommandHistory).not.toHaveBeenCalled();
      expect(shellHistoryService?.clearCommandHistory).not.toHaveBeenCalled();
    },
  );

  it("keeps explicit structured history actions available", async () => {
    const { runtime, shellHistoryService } = await makeRuntime({
      shellHistoryCommands: ["git status"],
      withShellHistoryService: true,
    });
    const message = makeMessage(undefined, "unrelated prose");

    const viewed = await shellAction.handler?.(runtime, message, undefined, {
      action: "view_history",
    });
    const cleared = await shellAction.handler?.(runtime, message, undefined, {
      action: "clear_history",
    });

    expect(viewed?.success).toBe(true);
    expect(viewed?.text).toContain("git status");
    expect(cleared?.success).toBe(true);
    expect(shellHistoryService?.getCommandHistory).toHaveBeenCalledOnce();
    expect(shellHistoryService?.clearCommandHistory).toHaveBeenCalledOnce();
  });

  it("denies a non-owner planned command before shell dispatch", async () => {
    const calls: Array<{ command: string }> = [];
    const router = makeShellRouter(async (params) => {
      calls.push(params);
      return { output: "unexpected\n", exitCode: 0, timedOut: false };
    });
    const { runtime, shellHistoryService } = await makeRuntime({
      capabilityRouter: router,
      withShellHistoryService: true,
    });

    const result = await executePlannedToolCall(
      runtime,
      {
        message: makeMessage(undefined, "show shell history"),
        activeContexts: ["code"],
        userRoles: ["USER"],
      },
      { name: "SHELL", params: { command: "printf must-not-run" } },
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("not allowed");
    expect(calls).toHaveLength(0);
    expect(shellHistoryService?.getCommandHistory).not.toHaveBeenCalled();
    expect(shellHistoryService?.clearCommandHistory).not.toHaveBeenCalled();
  });
});

describe("shell timeout operator setting", () => {
  it.each(["", "0", "-1", "45.5", "9007199254740992", "600001", "1e3", " 200"])(
    "rejects malformed timeout setting %j before starting the shell",
    async (shellTimeoutMs) => {
      const markerRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "coding-tools-timeout-setting-"),
      );
      const marker = path.join(markerRoot, "started");
      const script = path.join(markerRoot, "write-marker.mjs");
      await fs.writeFile(
        script,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "started");\n`,
      );

      try {
        const { runtime } = await makeRuntime({ shellTimeoutMs });
        const result = await shellAction.handler?.(
          runtime,
          makeMessage(),
          undefined,
          {
            command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
          },
        );

        expect(result?.success).toBe(false);
        expect(result?.text).toContain("invalid_param");
        expect(result?.text).toContain("CODING_TOOLS_SHELL_TIMEOUT_MS");
        await expect(fs.access(marker)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await fs.rm(markerRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    [undefined, 120_000],
    [null, 120_000],
    ["200", 200],
    [100, 100],
    [600_000, 600_000],
  ] as const)(
    "passes the omitted or valid setting %j to foreground execution as %j ms",
    async (shellTimeoutMs, expectedTimeoutMs) => {
      const calls: Array<{ timeoutMs?: number }> = [];
      const router = makeShellRouter(async (params) => {
        calls.push(params);
        return { output: "ok\n", exitCode: 0, timedOut: false };
      });
      const { runtime } = await makeRuntime({
        shellTimeoutMs,
        capabilityRouter: router,
      });

      const result = await shellAction.handler?.(
        runtime,
        makeMessage(),
        undefined,
        { command: "echo ok" },
      );

      expect(result?.success).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.timeoutMs).toBe(expectedTimeoutMs);
    },
  );

  it("prefers the per-call timeout over the operator default", async () => {
    const calls: Array<{ timeoutMs?: number }> = [];
    const router = makeShellRouter(async (params) => {
      calls.push(params);
      return { output: "ok\n", exitCode: 0, timedOut: false };
    });
    const { runtime } = await makeRuntime({
      shellTimeoutMs: "600000",
      capabilityRouter: router,
    });

    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      { command: "echo ok", timeout: 250 },
    );

    expect(result?.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(250);
  });

  it("uses the environment timeout when the runtime setting is omitted", async () => {
    await withShellTimeoutEnv("200", async () => {
      const calls: Array<{ timeoutMs?: number }> = [];
      const router = makeShellRouter(async (params) => {
        calls.push(params);
        return { output: "ok\n", exitCode: 0, timedOut: false };
      });
      const { runtime } = await makeRuntime({
        shellTimeoutMs: null,
        capabilityRouter: router,
      });

      const result = await shellAction.handler?.(
        runtime,
        makeMessage(),
        undefined,
        { command: "echo ok" },
      );

      expect(result?.success).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.timeoutMs).toBe(200);
    });
  });

  it("rejects a malformed environment timeout before dispatch", async () => {
    await withShellTimeoutEnv("45.5", async () => {
      const calls: Array<{ timeoutMs?: number }> = [];
      const router = makeShellRouter(async (params) => {
        calls.push(params);
        return { output: "unexpected\n", exitCode: 0, timedOut: false };
      });
      const { runtime } = await makeRuntime({
        shellTimeoutMs: null,
        capabilityRouter: router,
      });

      const result = await shellAction.handler?.(
        runtime,
        makeMessage(),
        undefined,
        { command: "echo must-not-run" },
      );

      expect(result?.success).toBe(false);
      expect(result?.text).toContain("CODING_TOOLS_SHELL_TIMEOUT_MS");
      expect(calls).toHaveLength(0);
    });
  });

  it("prefers the explicit runtime setting over the environment", async () => {
    await withShellTimeoutEnv("200", async () => {
      const calls: Array<{ timeoutMs?: number }> = [];
      const router = makeShellRouter(async (params) => {
        calls.push(params);
        return { output: "ok\n", exitCode: 0, timedOut: false };
      });
      const { runtime } = await makeRuntime({
        shellTimeoutMs: "300",
        capabilityRouter: router,
      });

      const result = await shellAction.handler?.(
        runtime,
        makeMessage(),
        undefined,
        { command: "echo ok" },
      );

      expect(result?.success).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.timeoutMs).toBe(300);
    });
  });

  it("rejects invalid background settings without starting a child", async () => {
    const markerRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "coding-tools-background-timeout-setting-"),
    );
    const marker = path.join(markerRoot, "started");
    const script = path.join(markerRoot, "write-marker.mjs");
    await fs.writeFile(
      script,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "started");\n`,
    );

    try {
      const { runtime } = await makeRuntime({ shellTimeoutMs: "0" });
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(),
        undefined,
        {
          action: "start_background",
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
        },
      );

      expect(result?.success).toBe(false);
      expect(result?.text).toContain("CODING_TOOLS_SHELL_TIMEOUT_MS");
      await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(markerRoot, { recursive: true, force: true });
    }
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

describe("destructive-bulk confirm gate", () => {
  it("blocks an unconfirmed recursive delete with needs_confirmation", async () => {
    const { command, target } = await createRecursiveDeleteCommand();
    const { runtime } = await makeRuntime();
    try {
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(undefined, "clean up the old projects"),
        undefined,
        { command },
      );
      expect(result.success).toBe(false);
      expect(result.text).toContain("needs_confirmation");
      expect(result.text).toContain("confirm=true");
      const data = result.data as Record<string, unknown> | undefined;
      expect(data?.destructive_reason).toBe("recursive delete");
      expect(await pathExists(target)).toBe(true);
    } finally {
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "blocks GNU long-form recursive delete before shell execution",
    async () => {
      const { command, target } = await createRecursiveDeleteCommand();
      const { runtime } = await makeRuntime();
      try {
        const result = await shellAction.handler?.(
          runtime,
          makeMessage(undefined, "clean up the old projects"),
          undefined,
          { command: command.replace("rm -rf", "rm --recursive --force") },
        );
        expect(result.success).toBe(false);
        expect(result.text).toContain("needs_confirmation");
        expect(result.data).toMatchObject({
          destructive_reason: "recursive delete",
        });
        expect(await pathExists(target)).toBe(true);
      } finally {
        await fs.rm(target, { recursive: true, force: true });
      }
    },
  );

  it("runs the same command when confirm=true", async () => {
    const { command, target } = await createRecursiveDeleteCommand();
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(undefined, "yes do it"),
      undefined,
      {
        command,
        confirm: true,
      },
    );
    expect(result.success).toBe(true);
    expect(await pathExists(target)).toBe(false);
  });

  it("is exempt on the coding sub-agent path (task briefs carry confirmation)", async () => {
    const { command, target } = await createRecursiveDeleteCommand();
    process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE = "1";
    try {
      const { runtime } = await makeRuntime();
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(undefined, "build step"),
        undefined,
        { command },
      );
      expect(result.success).toBe(true);
      expect(await pathExists(target)).toBe(false);
    } finally {
      delete process.env.ELIZA_PLANNER_FULL_ACTION_SURFACE;
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it("honors the ELIZA_SHELL_DESTRUCTIVE_CONFIRM=0 escape hatch", async () => {
    const { command, target } = await createRecursiveDeleteCommand();
    process.env.ELIZA_SHELL_DESTRUCTIVE_CONFIRM = "0";
    try {
      const { runtime } = await makeRuntime();
      const result = await shellAction.handler?.(
        runtime,
        makeMessage(undefined, "clean up"),
        undefined,
        { command },
      );
      expect(result.success).toBe(true);
      expect(await pathExists(target)).toBe(false);
    } finally {
      delete process.env.ELIZA_SHELL_DESTRUCTIVE_CONFIRM;
      await fs.rm(target, { recursive: true, force: true });
    }
  });

  it("never gates ordinary commands", async () => {
    const { runtime } = await makeRuntime();
    const result = await shellAction.handler?.(
      runtime,
      makeMessage(undefined, "whats here"),
      undefined,
      { command: 'node -e "process.exit(0)"' },
    );
    expect(result.success).toBe(true);
  });
});
