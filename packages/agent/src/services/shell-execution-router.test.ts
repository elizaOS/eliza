import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveShellExecutionMode,
  runShell,
} from "./shell-execution-router.ts";

const MODE_ENV_KEYS = [
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "ELIZA_DISTRIBUTION_PROFILE",
  "ELIZA_PLATFORM",
] as const;

describe("runShell", () => {
  let saved: Partial<
    Record<(typeof MODE_ENV_KEYS)[number], string | undefined>
  > = {};

  beforeEach(() => {
    saved = {};
    for (const key of MODE_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MODE_ENV_KEYS) {
      const previous = saved[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("local-yolo runs commands on the host", async () => {
    const result = await runShell({
      command: "/bin/sh",
      args: ["-c", "printf hello"],
      toolName: "test:host",
      timeoutMs: 5_000,
    });
    expect(result.sandbox).toBe("host");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
  });

  it("local-yolo defaults to local-yolo for unrestricted direct desktop when no mode is set", async () => {
    const result = await runShell({
      command: "/bin/sh",
      args: ["-c", "echo hello"],
      toolName: "test:default",
      timeoutMs: 5_000,
    });
    expect(result.sandbox).toBe("host");
    expect(result.stdout).toBe("hello\n");
  });

  it("store builds do not fall back to host local-yolo when no mode is set", async () => {
    process.env.ELIZA_DISTRIBUTION_PROFILE = "store";
    expect(resolveShellExecutionMode()).toBe("local-safe");
    await expect(
      runShell(
        {
          command: "/bin/sh",
          args: ["-c", "printf should-not-run"],
          toolName: "test:store-default",
        },
        { sandboxManager: null },
      ),
    ).rejects.toThrow("local-safe mode requires SandboxManager");
  });

  it("mobile builds do not fall back to host local-yolo when no mode is set", async () => {
    process.env.ELIZA_PLATFORM = "ios";
    expect(resolveShellExecutionMode()).toBe("local-safe");
    await expect(
      runShell(
        {
          command: "/bin/sh",
          args: ["-c", "printf should-not-run"],
          toolName: "test:mobile-default",
        },
        { sandboxManager: null },
      ),
    ).rejects.toThrow("local-safe mode requires SandboxManager");
  });

  it("store builds clamp explicit local-yolo before host execution", async () => {
    process.env.ELIZA_DISTRIBUTION_PROFILE = "store";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    expect(resolveShellExecutionMode()).toBe("local-safe");
    await expect(
      runShell(
        {
          command: "/bin/sh",
          args: ["-c", "printf should-not-run"],
          toolName: "test:store-explicit-yolo",
        },
        { sandboxManager: null },
      ),
    ).rejects.toThrow("local-safe mode requires SandboxManager");
  });

  it("ctx mode local-yolo is preserved for unrestricted desktop but clamped for mobile", () => {
    expect(
      resolveShellExecutionMode({
        mode: "local-yolo",
        distributionProfile: "unrestricted",
        platform: "darwin",
      }),
    ).toBe("local-yolo");
    expect(
      resolveShellExecutionMode({
        mode: "local-yolo",
        distributionProfile: "unrestricted",
        platform: "android",
      }),
    ).toBe("local-safe");
  });

  it("cloud rejects local shell execution with the documented error", async () => {
    process.env.ELIZA_RUNTIME_MODE = "cloud";
    await expect(
      runShell({
        command: "echo",
        args: ["nope"],
        toolName: "test:cloud",
      }),
    ).rejects.toThrow("Local shell execution disabled in cloud mode.");
  });

  it("local-safe forwards command, args, env, cwd, and timeout to SandboxManager.run", async () => {
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 7,
      executedInSandbox: true,
    });
    const fakeManager = {
      run,
      // engineType is read by the router to label the sandbox backend.
      engine: { engineType: "docker" },
    };

    const result = await runShell(
      {
        command: "git",
        args: ["status", "--porcelain"],
        cwd: "/workspace",
        env: { GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: 12_345,
        toolName: "test:safe",
      },
      // biome-ignore lint/suspicious/noExplicitAny: deliberate stub for unit test
      { sandboxManager: fakeManager as any },
    );

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      cmd: "git",
      args: ["status", "--porcelain"],
      workdir: "/workspace",
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 12_345,
    });
    expect(result.sandbox).toBe("docker");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("local-safe throws when no SandboxManager is available", async () => {
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    await expect(
      runShell(
        {
          command: "echo",
          args: ["hi"],
          toolName: "test:safe-missing",
        },
        { sandboxManager: null },
      ),
    ).rejects.toThrow("local-safe mode requires SandboxManager");
  });

  it("honours timeoutMs by killing the child and reporting non-zero exit", async () => {
    const start = Date.now();
    const result = await runShell({
      command: "/bin/sh",
      args: ["-c", "sleep 5"],
      toolName: "test:timeout",
      timeoutMs: 200,
    });
    const elapsed = Date.now() - start;
    expect(result.exitCode).not.toBe(0);
    expect(result.sandbox).toBe("host");
    expect(elapsed).toBeLessThan(1000);
    expect(result.durationMs).toBeLessThan(1000);
  });
});
