/**
 * Drives runShell's routing between host execution and sandbox backends across
 * runtime modes (local-yolo / local-safe / cloud / mobile) and vfs:// working
 * directories. Runs real host child processes for the host path and pairs a fake
 * SandboxManager with a real VirtualFilesystemService for the sandbox paths.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetShellRouterBrokerForTests,
  runShell,
} from "./shell-execution-router.ts";
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
    __resetShellRouterBrokerForTests();
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
    __resetShellRouterBrokerForTests();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // These host-exec tests verify ROUTING (host vs sandbox) + mode defaulting,
  // not POSIX-shell semantics. `runShell` spawns command/args directly (no
  // shell), so a hardcoded `/bin/sh` fails to spawn on Windows (exitCode -1,
  // empty stdout). Use the running runtime binary (`process.execPath`, present
  // on every platform) with `-e` to emit deterministic, separator-stable output
  // (`console.log` writes LF, not CRLF, on Windows too).
  it("local-yolo runs commands on the host", async () => {
    const result = await runShell({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello')"],
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
      command: process.execPath,
      args: ["-e", "console.log('hello')"],
      toolName: "test:default",
      timeoutMs: 5_000,
    });
    expect(result.sandbox).toBe("host");
    expect(result.stdout).toBe("hello\n");
  });

  it("strips dangerous spawn env vars from the host child, passes benign ones", async () => {
    const result = await runShell({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({" +
          "ld:process.env.LD_PRELOAD??null," +
          "opt:process.env.NODE_OPTIONS??null," +
          "npm:process.env.NPM_CONFIG_REGISTRY??null," +
          "safe:process.env.SAFE_PASSTHROUGH??null}))",
      ],
      env: {
        LD_PRELOAD: "/tmp/evil.so",
        NODE_OPTIONS: "--max-old-space-size=128",
        NPM_CONFIG_REGISTRY: "http://attacker.test",
        SAFE_PASSTHROUGH: "ok",
      },
      toolName: "test:env-sanitize",
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ld).toBeNull(); // LD_PRELOAD stripped
    expect(parsed.opt).toBeNull(); // NODE_OPTIONS stripped
    expect(parsed.npm).toBeNull(); // NPM_CONFIG_* prefix stripped
    expect(parsed.safe).toBe("ok"); // benign caller var passes through
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
      engineType: "docker",
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
      // biome-ignore lint/suspicious/noExplicitAny: deliberate fake for unit test
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

  it("local-safe routes through SandboxManager on Windows when a backend is available", async () => {
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("win32");
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "windows-safe",
      stderr: "",
      durationMs: 9,
      executedInSandbox: true,
    });
    const fakeManager = {
      run,
      engineType: "docker",
    };

    try {
      const result = await runShell(
        {
          command: "cmd.exe",
          args: ["/c", "echo", "safe"],
          toolName: "test:safe-windows",
          timeoutMs: 5_000,
        },
        // biome-ignore lint/suspicious/noExplicitAny: deliberate fake for unit test
        { sandboxManager: fakeManager as any },
      );

      expect(run).toHaveBeenCalledWith({
        cmd: "cmd.exe",
        args: ["/c", "echo", "safe"],
        workdir: undefined,
        env: undefined,
        timeoutMs: 5_000,
      });
      expect(result.sandbox).toBe("docker");
      expect(result.stdout).toBe("windows-safe");
    } finally {
      platformSpy.mockRestore();
    }
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

  it("local-safe rejects vfs:// cwd when no real SandboxManager is available on desktop", async () => {
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    const vfs = createVirtualFilesystemService({
      projectId: "safe-no-manager",
    });
    await vfs.initialize();

    await expect(
      runShell(
        {
          command: "/bin/sh",
          args: ["-c", "printf nope"],
          cwd: "vfs://safe-no-manager/src",
          toolName: "test:vfs-safe-missing",
          timeoutMs: 5_000,
        },
        { sandboxManager: null },
      ),
    ).rejects.toThrow("local-safe mode requires SandboxManager");
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
      await expect(
        fsp.readFile(path.join(hostCwd, "input.txt"), "utf-8"),
      ).resolves.toBe("ready");
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
      engineType: "docker",
    };

    const result = await runShell(
      {
        command: "cat",
        args: ["input.txt"],
        cwd: "vfs://sandbox-vfs/src",
        toolName: "test:vfs-safe",
        timeoutMs: 5_000,
      },
      // biome-ignore lint/suspicious/noExplicitAny: deliberate fake for unit test
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

  it("local-safe imports vfs:// sandbox deletions back", async () => {
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    const sandboxRoot = path.join(tmpDir, "sandbox-workspace");
    const vfs = createVirtualFilesystemService({ projectId: "delete-vfs" });
    await vfs.initialize();
    await vfs.writeFile("src/remove.txt", "remove");
    await vfs.writeFile("src/keep.txt", "keep");

    const run = vi.fn().mockImplementation(async (request) => {
      const hostCwd = path.join(
        sandboxRoot,
        request.workdir.replace(/^\/workspace\/?/, ""),
      );
      await fsp.rm(path.join(hostCwd, "remove.txt"));
      return {
        exitCode: 0,
        stdout: "",
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
      engineType: "docker",
    };

    await runShell(
      {
        command: "rm",
        args: ["remove.txt"],
        cwd: "vfs://delete-vfs/src",
        toolName: "test:vfs-delete",
        timeoutMs: 5_000,
      },
      // biome-ignore lint/suspicious/noExplicitAny: deliberate fake for unit test
      { sandboxManager: fakeManager as any },
    );

    await expect(vfs.readFile("src/keep.txt")).resolves.toBe("keep");
    await expect(vfs.readFile("src/remove.txt")).rejects.toThrow("not found");
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
    // A real long-running child the router must kill — `process.execPath` keeps
    // the event loop alive for 5s on every platform (a `/bin/sh sleep` would be
    // absent on Windows and exit fast, passing this test for the wrong reason).
    const result = await runShell({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
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
