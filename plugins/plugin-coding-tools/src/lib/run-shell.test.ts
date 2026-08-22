/** Tests for the `runShell` child-process wrapper, using the core capability router doubles. */
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type ElizaCapabilityRouter,
  type IAgentRuntime,
  UnavailableCapabilityRouter,
} from "@elizaos/core";
import { captureHostExecutionBaseline } from "@elizaos/shared/host-execution-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runShell } from "./run-shell.js";

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "PATH",
  "HOME",
  "SHELL",
] as const;

let savedEnv: Record<string, string | undefined>;
let savedPlatformDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  savedPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  captureHostExecutionBaseline();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedPlatformDescriptor) {
    Object.defineProperty(process, "platform", savedPlatformDescriptor);
  }
});

function runtimeWithRouter(router: ElizaCapabilityRouter): IAgentRuntime {
  return {
    getService: (serviceType: string) =>
      serviceType === CAPABILITY_ROUTER_SERVICE_TYPE ? router : null,
  } as IAgentRuntime;
}

function remoteRouter(): {
  router: ElizaCapabilityRouter;
  runCommand: ReturnType<typeof vi.fn>;
} {
  const runCommand = vi.fn(async () => ({
    output: "remote coded\n",
    exitCode: 0,
    timedOut: false,
  }));
  const router = {
    environment: "server",
    availability: async () => ({
      environment: "server",
      available: true,
      capabilities: {
        fs: true,
        pty: true,
        git: true,
        model: false,
        plugin: false,
      },
    }),
    fs: {
      list: vi.fn(),
      readText: vi.fn(),
      writeText: vi.fn(),
    },
    pty: { runCommand },
    git: {
      status: vi.fn(),
      diff: vi.fn(),
      commandRun: vi.fn(),
    },
    model: {
      status: vi.fn(),
    },
    plugin: new UnavailableCapabilityRouter("server").plugin,
  } satisfies ElizaCapabilityRouter;
  return { router, runCommand };
}

describe("plugin-coding-tools runShell mobile routing", () => {
  it("routes iOS coding commands through a Remote capability router", async () => {
    process.env.ELIZA_PLATFORM = "ios";
    process.env.ELIZA_BUILD_VARIANT = "store";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    const { router, runCommand } = remoteRouter();

    const result = await runShell(runtimeWithRouter(router), {
      command: "codex exec 'touch changed.txt'",
      cwd: "/workspace",
      timeoutMs: 10_000,
    });

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: "remote coded\n",
      stderr: "",
      durationMs: expect.any(Number),
      sandbox: "capability-router",
      timedOut: false,
    });
    expect(runCommand).toHaveBeenCalledWith({
      command: "codex exec 'touch changed.txt'",
      cwd: "/workspace",
      timeoutMs: 10_000,
    });
  });

  it("rejects over-limit capability-router output without returning a prefix", async () => {
    process.env.ELIZA_PLATFORM = "ios";
    process.env.ELIZA_BUILD_VARIANT = "store";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    const { router, runCommand } = remoteRouter();
    runCommand.mockResolvedValueOnce({
      output: "x".repeat(1_000_001),
      exitCode: 0,
      timedOut: false,
    });

    const result = await runShell(runtimeWithRouter(router), {
      command: "noisy-command",
      cwd: "/workspace",
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({
      stdout: "",
      stderr: "",
      outputLimitExceeded: true,
      sandbox: "capability-router",
    });
  });

  it("rejects iOS coding commands when no Remote capability router is available", async () => {
    process.env.ELIZA_PLATFORM = "ios";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";

    await expect(
      runShell({ getService: () => null } as IAgentRuntime, {
        command: "codex exec 'touch changed.txt'",
        cwd: "/workspace",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(
      "Local coding tools are unavailable on iOS because the runtime does not expose shell, coding, or orchestrator subprocess capabilities.",
    );
  });
});

describe("plugin-coding-tools runShell local-safe sandbox routing", () => {
  it("routes Windows local-safe commands through the runtime sandbox manager", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    process.env.ELIZA_RUNTIME_MODE = "local-safe";

    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: "sandboxed\n",
      stderr: "",
      durationMs: 7,
      executedInSandbox: true,
    }));
    const runtime = {
      getService: () => null,
      getSandboxManager: () => ({
        engine: { engineType: "docker" },
        exec,
      }),
    } as unknown as IAgentRuntime;

    const result = await runShell(runtime, {
      command: "echo sandboxed",
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(exec).toHaveBeenCalledWith({
      command: "echo sandboxed",
      workdir: "/workspace",
      timeoutMs: 10_000,
    });
    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: "sandboxed\n",
      stderr: "",
      durationMs: 7,
      sandbox: "docker",
      timedOut: false,
    });
  });

  it("rejects over-limit sandbox output without returning a prefix", async () => {
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    const runtime = {
      getService: () => null,
      getSandboxManager: () => ({
        engine: { engineType: "docker" },
        exec: vi.fn(async () => ({
          exitCode: 0,
          stdout: "x".repeat(1_000_001),
          stderr: "",
          durationMs: 7,
          executedInSandbox: true,
        })),
      }),
    } as unknown as IAgentRuntime;

    const result = await runShell(runtime, {
      command: "noisy-command",
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result).toMatchObject({
      stdout: "",
      stderr: "",
      outputLimitExceeded: true,
      sandbox: "docker",
    });
  });
});

describe("plugin-coding-tools host execution authority", () => {
  it("decodes split multibyte stdout and stderr as UTF-8 streams", async () => {
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    const script = [
      'const value = Buffer.from("\u4f60");',
      "process.stdout.write(value.subarray(0, 1));",
      "process.stderr.write(value.subarray(0, 2));",
      "setTimeout(() => {",
      "  process.stdout.write(value.subarray(1));",
      "  process.stderr.write(value.subarray(2));",
      "}, 50);",
    ].join("");

    const result = await runShell({ getService: () => null } as IAgentRuntime, {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\u4f60");
    expect(result.stderr).toBe("\u4f60");
  });

  it("uses the captured PATH without forwarding mutable PATH, HOME, or SHELL", async () => {
    const bootPath = process.env.PATH;
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    process.env.PATH = "/tmp/runtime-bin";
    process.env.HOME = "/tmp/runtime-home";
    process.env.SHELL = "/tmp/runtime-shell";

    const result = await runShell({ getService: () => null } as IAgentRuntime, {
      command: "printf '%s' \"$PATH|$HOME|$SHELL\"",
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("|")[0]).toBe(bootPath);
    expect(result.stdout).not.toContain("/tmp/runtime-home");
    expect(result.stdout).not.toContain("/tmp/runtime-shell");
  });
});
