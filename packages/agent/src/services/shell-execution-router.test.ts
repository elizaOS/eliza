import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runShell } from "./shell-execution-router.ts";
import { createVirtualFilesystemService } from "./virtual-filesystem.ts";

const MODE_ENV_KEYS = [
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "ELIZA_PLATFORM",
] as const;

describe("runShell", () => {
  let saved: Partial<
    Record<(typeof MODE_ENV_KEYS)[number], string | undefined>
  > = {};
  let tmpDir: string;
  let oldStateDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-shell-router-"));
    oldStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = tmpDir;
    saved = {};
    for (const key of MODE_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of MODE_ENV_KEYS) {
      const previous = saved[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    if (oldStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = oldStateDir;
    }
    await fsp.rm(tmpDir, { recursive: true, force: true });
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

  it("local-yolo defaults to local-yolo when no mode is set", async () => {
    const result = await runShell({
      command: "/bin/sh",
      args: ["-c", "echo hello"],
      toolName: "test:default",
      timeoutMs: 5_000,
    });
    expect(result.sandbox).toBe("host");
    expect(result.stdout).toBe("hello\n");
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

  it("local-yolo rejects vfs:// cwd because it uses the normal host filesystem", async () => {
    const vfs = createVirtualFilesystemService({ projectId: "host-vfs" });
    await vfs.initialize();
    await vfs.writeFile("src/input.txt", "ready");

    await expect(
      runShell({
        command: "/bin/sh",
        args: ["-c", "printf host > generated.txt"],
        cwd: "vfs://host-vfs/src",
        toolName: "test:vfs-host",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("local-yolo uses the normal host filesystem");
  });

  it("local-safe materializes vfs:// cwd into the sandbox filesystem and imports changes back", async () => {
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    const sandboxRoot = path.join(tmpDir, "sandbox-workspace");
    const vfs = createVirtualFilesystemService({ projectId: "sandbox-vfs" });
    await vfs.initialize();
    await vfs.writeFile("src/input.txt", "ready");

    const run = vi.fn().mockImplementation(async (request) => {
      const hostCwd = path.join(
        sandboxRoot,
        request.workdir.replace(/^\/workspace\/?/, ""),
      );
      await expect(fsp.readFile(path.join(hostCwd, "input.txt"), "utf-8"))
        .resolves.toBe("ready");
      await fsp.writeFile(path.join(hostCwd, "generated.txt"), "sandbox");
      return {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 7,
        executedInSandbox: true,
      };
    });
    const fakeManager = {
      run,
      getWorkspaceRoot: () => sandboxRoot,
      getContainerWorkspacePath: (hostPath: string) =>
        `/workspace/${path.relative(sandboxRoot, hostPath).replace(/\\/g, "/")}`,
      engine: { engineType: "docker" },
    };

    const result = await runShell(
      {
        command: "cat",
        args: ["input.txt"],
        cwd: "vfs://sandbox-vfs/src",
        toolName: "test:vfs-safe",
        timeoutMs: 5_000,
      },
      // biome-ignore lint/suspicious/noExplicitAny: deliberate stub for unit test
      { sandboxManager: fakeManager as any },
    );

    expect(result.sandbox).toBe("docker");
    expect(run).toHaveBeenCalledWith({
      cmd: "cat",
      args: ["input.txt"],
      workdir: "/workspace/vfs-projects/sandbox-vfs/files/src",
      env: undefined,
      timeoutMs: 5_000,
    });
    await expect(vfs.readFile("src/generated.txt")).resolves.toBe("sandbox");
  });

  it("uses the constrained builtin VFS shell on iOS sandbox mode when no native sandbox manager is available", async () => {
    process.env.ELIZA_PLATFORM = "ios";
    const vfs = createVirtualFilesystemService({ projectId: "ios-vfs" });
    await vfs.initialize();
    await vfs.writeFile("src/input.txt", "ready");

    const result = await runShell(
      {
        command: "/bin/sh",
        args: ["-c", "echo mobile > generated.txt"],
        cwd: "vfs://ios-vfs/src",
        toolName: "test:vfs-mobile",
      },
      { sandboxManager: null },
    );

    expect(result.sandbox).toBe("vfs");
    expect(result.exitCode).toBe(0);
    await expect(vfs.readFile("src/generated.txt")).resolves.toBe("mobile\n");
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
