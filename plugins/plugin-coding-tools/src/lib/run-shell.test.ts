/** Tests for the `runShell` child-process wrapper, using the core capability router doubles. */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type ElizaCapabilityRouter,
  type IAgentRuntime,
  UnavailableCapabilityRouter,
} from "@elizaos/core";
import { captureHostExecutionBaseline } from "@elizaos/shared/host-execution-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runShell } from "./run-shell.js";

const terminalCapabilityMock = vi.hoisted(() => ({
  hostShell: undefined as
    | {
        command: string;
        args: string[];
        available: boolean;
        source: "candidate";
      }
    | undefined,
}));

vi.mock("./terminal-capabilities.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./terminal-capabilities.js")>();
  return {
    ...actual,
    resolveHostShell: () =>
      terminalCapabilityMock.hostShell ?? actual.resolveHostShell(),
  };
});

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
  "PATH",
  "HOME",
  "SHELL",
  "CODING_TOOLS_WORKSPACE_ROOTS",
  "ELIZA_TEST_API_KEY",
  "LC_SECRET",
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
  terminalCapabilityMock.hostShell = undefined;
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

function findUsableSystemBubblewrap(): string | undefined {
  if (process.platform !== "linux") return undefined;
  for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap"]) {
    try {
      const stat = statSync(candidate);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        continue;
      }
      if (
        spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0
      ) {
        return candidate;
      }
    } catch {
      // A missing or unusable system backend is covered by the fail-closed test.
    }
  }
  return undefined;
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const SYSTEM_BWRAP = findUsableSystemBubblewrap();
const itWithBubblewrap = SYSTEM_BWRAP ? it : it.skip;
const itOnPosix = process.platform === "win32" ? it.skip : it;

function createZshShim(workspace: string): string {
  const shim = join(workspace, "zsh");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      "for argument do command=$argument; done",
      'exec /bin/sh -c "$command"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);
  return shim;
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

  it("fails closed before dispatch when a capability router cannot honor cancellation", async () => {
    process.env.ELIZA_PLATFORM = "ios";
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    const { router, runCommand } = remoteRouter();

    await expect(
      runShell(runtimeWithRouter(router), {
        command: "touch must-not-run.txt",
        cwd: "/workspace",
        timeoutMs: 10_000,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("cannot guarantee cancellation");
    expect(runCommand).not.toHaveBeenCalled();
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

  itWithBubblewrap(
    "confines real Linux commands to an arbitrary configured workspace across relative, absolute, and symlink paths",
    async () => {
      process.env.ELIZA_RUNTIME_MODE = "local-safe";
      const fixture = mkdtempSync(join(tmpdir(), "eliza-bwrap-sandbox-"));
      const workspace = join(fixture, "workspace with spaces");
      const nested = join(workspace, "nested dir");
      const outside = join(fixture, "outside sibling");
      const sentinel = join(outside, "sentinel.txt");
      mkdirSync(nested, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(sentinel, "preserve-me", "utf8");
      symlinkSync("../outside sibling", join(workspace, "relative-outside"));
      symlinkSync(outside, join(workspace, "absolute-outside"));
      process.env.CODING_TOOLS_WORKSPACE_ROOTS = workspace;
      process.env.ELIZA_TEST_API_KEY = "must-not-reach-model-authored-shell";
      process.env.LC_SECRET = "must-not-reach-model-authored-shell";

      try {
        const result = await runShell(
          {
            getSetting: (key: string) =>
              key === "ELIZA_RUNTIME_MODE"
                ? "local-safe"
                : key === "CODING_TOOLS_WORKSPACE_ROOTS"
                  ? workspace
                  : undefined,
            getService: () => null,
          } as unknown as IAgentRuntime,
          {
            command: [
              "set -e",
              "git --version >/dev/null",
              "node --version >/dev/null",
              "bun --version >/dev/null",
              'test -z "$ELIZA_TEST_API_KEY"',
              'test -z "$LC_SECRET"',
              "test ! -e /etc/passwd",
              "test ! -e /etc/machine-id",
              "test -r /etc/ssl/certs/ca-certificates.crt",
              `test ! -e ${quoteShellArg(sentinel)}`,
              "test ! -e ../relative-outside/sentinel.txt",
              "test ! -e ../absolute-outside/sentinel.txt",
              "printf inside-relative > ../from-nested.txt",
              `printf inside-absolute > ${quoteShellArg(join(workspace, "from-absolute.txt"))}`,
              "printf escaped > ../../outside\\ sibling/relative-escape.txt 2>/dev/null || true",
              `printf escaped > ${quoteShellArg(join(outside, "absolute-escape.txt"))} 2>/dev/null || true`,
              "printf escaped > ../relative-outside/symlink-escape.txt 2>/dev/null || true",
              "printf escaped > ../absolute-outside/symlink-escape.txt 2>/dev/null || true",
              `rm -f ${quoteShellArg(sentinel)} 2>/dev/null || true`,
              "pwd",
            ].join("; "),
            cwd: nested,
            timeoutMs: 10_000,
          },
        );

        expect(result, JSON.stringify(result)).toMatchObject({
          exitCode: 0,
          sandbox: "bubblewrap",
          timedOut: false,
        });
        expect(result.stdout.trim()).toBe(nested);
        expect(readFileSync(join(workspace, "from-nested.txt"), "utf8")).toBe(
          "inside-relative",
        );
        expect(readFileSync(join(workspace, "from-absolute.txt"), "utf8")).toBe(
          "inside-absolute",
        );
        expect(readFileSync(sentinel, "utf8")).toBe("preserve-me");
        expect(() =>
          readFileSync(join(outside, "relative-escape.txt"), "utf8"),
        ).toThrow();
        expect(() =>
          readFileSync(join(outside, "absolute-escape.txt"), "utf8"),
        ).toThrow();
        expect(() =>
          readFileSync(join(outside, "symlink-escape.txt"), "utf8"),
        ).toThrow();
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  itWithBubblewrap(
    "fails non-scratch writes outside the workspace while keeping workspace and ephemeral scratch writable",
    async () => {
      process.env.ELIZA_RUNTIME_MODE = "local-safe";
      // Keep this fixture outside /tmp so it exercises the synthetic root
      // ancestors that bubblewrap creates for an absolute workspace bind.
      // /tmp is a deliberately writable, per-command scratch mount and has a
      // separate contract below.
      const fixture = mkdtempSync(
        join(process.cwd(), ".eliza-bwrap-write-contract-"),
      );
      const workspace = join(fixture, "workspace");
      const outsideWrite = join(fixture, "outside-write.txt");
      const outsideSentinel = join(fixture, "outside-sentinel.txt");
      const insideAbsolute = join(workspace, "inside-absolute.txt");
      const scratch = `/tmp/eliza-scratch-${process.pid}.txt`;
      mkdirSync(workspace, { recursive: true });
      writeFileSync(outsideSentinel, "preserve-me", "utf8");
      process.env.CODING_TOOLS_WORKSPACE_ROOTS = workspace;
      const runtime = {
        getSetting: (key: string) => process.env[key],
        getService: () => null,
      } as unknown as IAgentRuntime;

      try {
        const insideResult = await runShell(runtime, {
          command: [
            "set -e",
            "printf relative > inside-relative.txt",
            `printf absolute > ${quoteShellArg(insideAbsolute)}`,
            `printf scratch > ${quoteShellArg(scratch)}`,
          ].join("; "),
          cwd: workspace,
          timeoutMs: 10_000,
        });
        expect(insideResult, JSON.stringify(insideResult)).toMatchObject({
          exitCode: 0,
          sandbox: "bubblewrap",
          timedOut: false,
        });
        expect(
          readFileSync(join(workspace, "inside-relative.txt"), "utf8"),
        ).toBe("relative");
        expect(readFileSync(insideAbsolute, "utf8")).toBe("absolute");

        const outsideWriteResult = await runShell(runtime, {
          command: `printf escaped > ${quoteShellArg(outsideWrite)}`,
          cwd: workspace,
          timeoutMs: 10_000,
        });
        expect(outsideWriteResult.sandbox).toBe("bubblewrap");
        expect(outsideWriteResult.exitCode).not.toBe(0);
        expect(() => readFileSync(outsideWrite, "utf8")).toThrow();

        const outsideDeleteResult = await runShell(runtime, {
          command: `rm ${quoteShellArg(outsideSentinel)}`,
          cwd: workspace,
          timeoutMs: 10_000,
        });
        expect(outsideDeleteResult.sandbox).toBe("bubblewrap");
        expect(outsideDeleteResult.exitCode).not.toBe(0);
        expect(readFileSync(outsideSentinel, "utf8")).toBe("preserve-me");

        const freshScratchResult = await runShell(runtime, {
          command: `test ! -e ${quoteShellArg(scratch)}`,
          cwd: workspace,
          timeoutMs: 10_000,
        });
        expect(
          freshScratchResult,
          JSON.stringify(freshScratchResult),
        ).toMatchObject({
          exitCode: 0,
          sandbox: "bubblewrap",
          timedOut: false,
        });
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it("fails closed without a managed sandbox or an explicit workspace root", async () => {
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    delete process.env.CODING_TOOLS_WORKSPACE_ROOTS;
    const runtime = {
      getSetting: (key: string) =>
        key === "ELIZA_RUNTIME_MODE" ? "local-safe" : undefined,
      getService: () => null,
    } as unknown as IAgentRuntime;

    await expect(
      runShell(runtime, {
        command: "touch should-never-run",
        cwd: process.cwd(),
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/requires SandboxManager.*workspace root/i);
  });

  it("fails closed when the local platform has no bubblewrap fallback", async () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    process.env.CODING_TOOLS_WORKSPACE_ROOTS = process.cwd();
    const runtime = {
      getSetting: (key: string) => process.env[key],
      getService: () => null,
    } as unknown as IAgentRuntime;

    await expect(
      runShell(runtime, {
        command: "touch should-never-run",
        cwd: process.cwd(),
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("bubblewrap fallback is unavailable on this platform");
  });

  itWithBubblewrap(
    "rejects a cwd symlink that resolves outside the configured workspace",
    async () => {
      process.env.ELIZA_RUNTIME_MODE = "local-safe";
      const fixture = mkdtempSync(join(tmpdir(), "eliza-bwrap-cwd-"));
      const workspace = join(fixture, "workspace");
      const outside = join(fixture, "outside");
      const linkedCwd = join(workspace, "linked-cwd");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, linkedCwd);
      process.env.CODING_TOOLS_WORKSPACE_ROOTS = workspace;
      const runtime = {
        getSetting: (key: string) => process.env[key],
        getService: () => null,
      } as unknown as IAgentRuntime;

      try {
        await expect(
          runShell(runtime, {
            command: "touch escaped.txt",
            cwd: linkedCwd,
            timeoutMs: 10_000,
          }),
        ).rejects.toThrow("cwd is outside CODING_TOOLS_WORKSPACE_ROOTS");
        expect(() =>
          readFileSync(join(outside, "escaped.txt"), "utf8"),
        ).toThrow();
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  itWithBubblewrap(
    "kills an in-flight sandbox command when the planner turn is cancelled",
    async () => {
      process.env.ELIZA_RUNTIME_MODE = "local-safe";
      const workspace = mkdtempSync(join(tmpdir(), "eliza-bwrap-cancel-"));
      const lateWrite = join(workspace, "must-not-exist.txt");
      process.env.CODING_TOOLS_WORKSPACE_ROOTS = workspace;
      const runtime = {
        getSetting: (key: string) => process.env[key],
        getService: () => null,
      } as unknown as IAgentRuntime;
      const controller = new AbortController();
      const runShellWithAbort = runShell as unknown as (
        runtime: IAgentRuntime,
        options: {
          command: string;
          cwd: string;
          timeoutMs: number;
          abortSignal: AbortSignal;
        },
      ) => ReturnType<typeof runShell>;

      try {
        const startedAt = Date.now();
        const execution = runShellWithAbort(runtime, {
          command: `sleep 1; printf late > ${quoteShellArg(lateWrite)}`,
          cwd: workspace,
          timeoutMs: 10_000,
          abortSignal: controller.signal,
        });
        setTimeout(
          () =>
            controller.abort(
              new DOMException("cancelled by ACP client", "AbortError"),
            ),
          100,
        );

        await expect(execution).rejects.toMatchObject({ name: "AbortError" });
        expect(Date.now() - startedAt).toBeLessThan(750);
        // Wait beyond the command's original sleep deadline: a detached or
        // merely client-abandoned process would have performed the write.
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        expect(() => readFileSync(lateWrite, "utf8")).toThrow();
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  itWithBubblewrap("rejects an over-broad mutable home root", async () => {
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    process.env.CODING_TOOLS_WORKSPACE_ROOTS = process.env.HOME ?? "/home";
    const runtime = {
      getSetting: (key: string) => process.env[key],
      getService: () => null,
    } as unknown as IAgentRuntime;

    await expect(
      runShell(runtime, {
        command: "true",
        cwd: process.cwd(),
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("refuses an over-broad mutable workspace root");
  });
});

describe("plugin-coding-tools host execution authority", () => {
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

  it("kills an in-flight local-yolo process group when the planner turn is cancelled", async () => {
    process.env.ELIZA_RUNTIME_MODE = "local-yolo";
    const workspace = mkdtempSync(join(tmpdir(), "eliza-host-cancel-"));
    const lateWrite = join(workspace, "must-not-exist.txt");
    const controller = new AbortController();

    try {
      const startedAt = Date.now();
      const execution = runShell({ getService: () => null } as IAgentRuntime, {
        // Both shell and child deliberately ignore TERM. Cancellation must use
        // immediate process-group SIGKILL or this mutation lands during the old
        // 1.5-second grace window.
        command: `trap '' TERM; (trap '' TERM; sleep 0.35; printf late > ${quoteShellArg(lateWrite)}) & wait`,
        cwd: workspace,
        timeoutMs: 10_000,
        abortSignal: controller.signal,
      });
      setTimeout(
        () =>
          controller.abort(
            new DOMException("cancelled by ACP client", "AbortError"),
          ),
        100,
      );

      await expect(execution).rejects.toMatchObject({ name: "AbortError" });
      expect(Date.now() - startedAt).toBeLessThan(750);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(() => readFileSync(lateWrite, "utf8")).toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  itOnPosix(
    "does not replay a timed-out zsh command through bash",
    async () => {
      process.env.ELIZA_RUNTIME_MODE = "local-yolo";
      const workspace = mkdtempSync(join(tmpdir(), "eliza-zsh-timeout-"));
      const invocationCount = join(workspace, "invocations.txt");
      const lateWrite = join(workspace, "must-not-exist.txt");
      terminalCapabilityMock.hostShell = {
        command: createZshShim(workspace),
        args: ["-c"],
        available: true,
        source: "candidate",
      };
      const command = [
        `count=$(($(cat ${quoteShellArg(invocationCount)} 2>/dev/null || printf 0) + 1))`,
        `printf '%s' "$count" > ${quoteShellArg(invocationCount)}`,
        `[ "$count" -eq 1 ] || printf late > ${quoteShellArg(lateWrite)}`,
        "sleep 1",
      ].join("; ");

      try {
        const result = await runShell(
          { getService: () => null } as IAgentRuntime,
          {
            command,
            cwd: workspace,
            timeoutMs: 100,
          },
        );

        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe("SIGKILL");
        expect(readFileSync(invocationCount, "utf8")).toBe("1");
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(() => readFileSync(lateWrite, "utf8")).toThrow();
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  itOnPosix(
    "does not replay a signalled zsh command through bash",
    async () => {
      process.env.ELIZA_RUNTIME_MODE = "local-yolo";
      const workspace = mkdtempSync(join(tmpdir(), "eliza-zsh-signal-"));
      const invocationCount = join(workspace, "invocations.txt");
      const lateWrite = join(workspace, "must-not-exist.txt");
      terminalCapabilityMock.hostShell = {
        command: createZshShim(workspace),
        args: ["-c"],
        available: true,
        source: "candidate",
      };
      const command = [
        `count=$(($(cat ${quoteShellArg(invocationCount)} 2>/dev/null || printf 0) + 1))`,
        `printf '%s' "$count" > ${quoteShellArg(invocationCount)}`,
        `[ "$count" -eq 1 ] || printf late > ${quoteShellArg(lateWrite)}`,
        "kill -TERM $$",
      ].join("; ");

      try {
        const result = await runShell(
          { getService: () => null } as IAgentRuntime,
          {
            command,
            cwd: workspace,
            timeoutMs: 10_000,
          },
        );

        expect(result.timedOut).toBe(false);
        expect(result.signal).toBe("SIGTERM");
        expect(readFileSync(invocationCount, "utf8")).toBe("1");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(() => readFileSync(lateWrite, "utf8")).toThrow();
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );
});
