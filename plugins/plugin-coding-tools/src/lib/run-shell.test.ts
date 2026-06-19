import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type ElizaCapabilityRouter,
  type IAgentRuntime,
  UnavailableCapabilityRouter,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runShell } from "./run-shell.js";

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
] as const;

let savedEnv: Record<string, string | undefined>;
let savedPlatformDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  savedPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
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
});
