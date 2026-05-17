/**
 * Tests for the sandbox subsystem:
 *
 *   - `SandboxDriver` proxies every Driver op through `SandboxBackend.invoke`
 *     using the right tagged envelope.
 *   - `DockerBackend` runs `docker run` + `docker cp` + `docker exec` against
 *     the injected stubs and round-trips one op through the helper stdio.
 *   - `QemuBackend` always throws `SandboxBackendUnavailableError` (Phase 2).
 *   - `createSandboxDriver` selects the right backend by name.
 *   - `getCurrentDriver` consults the service config and returns either null
 *     (yolo) or a SandboxDriver (sandbox), and is loud about misconfig.
 *   - `resolveModeFromEnv` defaults to yolo for unknown values.
 *
 * No actual `child_process.spawn` happens — tests inject `spawnExec` and
 * `runShell` stubs.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  createSandboxDriver,
  getCurrentDriver,
  resolveModeFromEnv,
} from "./index.js";
import { DockerBackend } from "./docker-backend.js";
import { QemuBackend } from "./qemu-backend.js";
import { SandboxDriver } from "./sandbox-driver.js";
import {
  SandboxBackendUnavailableError,
  type SandboxBackend,
  type SandboxOp,
} from "./types.js";

// ── helpers ────────────────────────────────────────────────────────────────

interface RecordingBackend extends SandboxBackend {
  readonly ops: SandboxOp[];
  startCount: number;
  stopCount: number;
}

function makeRecordingBackend(
  invokeImpl: (op: SandboxOp) => unknown = () => undefined,
): RecordingBackend {
  const ops: SandboxOp[] = [];
  return {
    name: "recording",
    ops,
    startCount: 0,
    stopCount: 0,
    async start() {
      this.startCount++;
    },
    async stop() {
      this.stopCount++;
    },
    async invoke<TResult>(op: SandboxOp): Promise<TResult> {
      ops.push(op);
      return invokeImpl(op) as TResult;
    },
  } as RecordingBackend;
}

// Minimal child-process-shaped stub for `spawnExec`. We only need stdout +
// stdin + stderr; the backend reads `.stdout.on('data', ...)` and writes
// to `.stdin.write(...)`.
class FakeChildProcess extends EventEmitter {
  stdin = {
    written: [] as string[],
    write(chunk: string) {
      this.written.push(chunk);
      return true;
    },
    end() {},
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();

  emitStdout(line: string) {
    this.stdout.emit("data", line);
  }
}

// ── SandboxDriver — routing ────────────────────────────────────────────────

describe("SandboxDriver", () => {
  it("dispatches every Driver op through the backend with the right kind", async () => {
    const backend = makeRecordingBackend((op) => {
      if (op.kind === "screenshot") {
        return { base64Png: Buffer.from("hi").toString("base64") };
      }
      if (op.kind === "list_windows") return { windows: [] };
      if (op.kind === "list_processes") return { processes: [] };
      if (op.kind === "run_command") {
        return {
          success: true,
          output: "",
          exitCode: 0,
          exit_code: 0,
        };
      }
      if (op.kind === "read_file") {
        return { success: true, path: "/x", content: "" };
      }
      if (op.kind === "write_file") {
        return { success: true, path: "/x" };
      }
      return undefined;
    });
    const driver = new SandboxDriver(backend);

    await driver.mouseMove(1, 2);
    await driver.mouseClick(3, 4);
    await driver.mouseDoubleClick(5, 6);
    await driver.mouseRightClick(7, 8);
    await driver.mouseDrag(1, 1, 9, 9);
    await driver.mouseScroll(0, 0, "down", 3);
    await driver.keyboardType("hello");
    await driver.keyboardKeyPress("Return");
    await driver.keyboardHotkey("ctrl+c");
    const png = await driver.screenshot();
    const wins = await driver.listWindows();
    await driver.focusWindow("w1");
    const procs = await driver.listProcesses();
    const term = await driver.runCommand("echo hi", { timeoutSeconds: 5 });
    const r = await driver.readFile("/etc/hostname");
    const w = await driver.writeFile("/tmp/x", "y");
    await driver.dispose();

    expect(backend.startCount).toBe(1); // started lazily, exactly once
    expect(backend.stopCount).toBe(1);
    expect(backend.ops.map((o) => o.kind)).toEqual([
      "mouse_move",
      "mouse_click",
      "mouse_double_click",
      "mouse_right_click",
      "mouse_drag",
      "mouse_scroll",
      "keyboard_type",
      "keyboard_key_press",
      "keyboard_hotkey",
      "screenshot",
      "list_windows",
      "focus_window",
      "list_processes",
      "run_command",
      "read_file",
      "write_file",
    ]);
    expect(png).toBeInstanceOf(Buffer);
    expect(png.toString()).toBe("hi");
    expect(wins).toEqual([]);
    expect(procs).toEqual([]);
    expect(term.success).toBe(true);
    expect(r.success).toBe(true);
    expect(w.success).toBe(true);
  });

  it("name reflects the wrapped backend", () => {
    const driver = new SandboxDriver(makeRecordingBackend());
    expect(driver.name).toBe("sandbox:recording");
  });

  it("does not stop a backend that was never started", async () => {
    const backend = makeRecordingBackend();
    const driver = new SandboxDriver(backend);
    await driver.dispose();
    expect(backend.startCount).toBe(0);
    expect(backend.stopCount).toBe(0);
  });
});

// ── DockerBackend — start + invoke + stop with stubbed spawn ───────────────

describe("DockerBackend", () => {
  it("runs docker run + cp + exec on start, round-trips a JSON op, and rm on stop", async () => {
    const shellCalls: { binary: string; args: string[] }[] = [];
    const runShell = async (binary: string, args: string[]) => {
      shellCalls.push({ binary, args });
      if (args[0] === "run") {
        return { stdout: "container-abc\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    let spawnCount = 0;
    const child = new FakeChildProcess();
    const spawnExec = (_binary: string, _args: string[]) => {
      spawnCount++;
      return child as unknown as ReturnType<typeof spawnExecSentinel>;
    };

    const backend = new DockerBackend({
      image: "cua/linux:latest",
      env: { DISPLAY: ":99" },
      runShell,
      spawnExec,
    });

    await backend.start();
    expect(spawnCount).toBe(1);
    const startCommands = shellCalls.map((c) => c.args[0]);
    expect(startCommands).toContain("run");
    expect(startCommands).toContain("cp");

    const runArgs = shellCalls.find((c) => c.args[0] === "run")!.args;
    expect(runArgs).toContain("cua/linux:latest");
    expect(runArgs).toContain("-e");
    expect(runArgs).toContain("DISPLAY=:99");

    const cpArgs = shellCalls.find((c) => c.args[0] === "cp")!.args;
    expect(cpArgs[2]).toBe("container-abc:/tmp/computeruse-sandbox-helper.py");

    const invokePromise = backend.invoke<{ base64Png: string }>({
      kind: "screenshot",
    });
    const written = child.stdin.written.join("");
    expect(written).toContain('"kind":"screenshot"');
    child.emitStdout(
      `${JSON.stringify({ ok: true, result: { base64Png: "AAA=" } })}\n`,
    );
    const result = await invokePromise;
    expect(result.base64Png).toBe("AAA=");

    await backend.stop();
    expect(shellCalls.some((c) => c.args[0] === "rm")).toBe(true);
  });

  it("rejects pending invokes with SandboxInvocationError when helper exits", async () => {
    const runShell = async (_binary: string, args: string[]) => {
      if (args[0] === "run") {
        return { stdout: "container-abc\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const child = new FakeChildProcess();
    const backend = new DockerBackend({
      image: "cua/linux:latest",
      runShell,
      spawnExec: () => child as unknown as ReturnType<typeof spawnExecSentinel>,
    });
    await backend.start();
    const pending = backend.invoke({ kind: "mouse_move", x: 1, y: 2 });
    child.emit("close", 137);
    await expect(pending).rejects.toThrow(/Helper exited/);
  });

  it("throws SandboxBackendUnavailableError if docker run fails", async () => {
    const runShell = async () => ({
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
      code: 1,
    });
    const backend = new DockerBackend({
      image: "cua/linux:latest",
      runShell,
      spawnExec: () =>
        new FakeChildProcess() as unknown as ReturnType<typeof spawnExecSentinel>,
    });
    await expect(backend.start()).rejects.toBeInstanceOf(
      SandboxBackendUnavailableError,
    );
  });

  it("invoke before start throws SandboxInvocationError", async () => {
    const backend = new DockerBackend({
      image: "cua/linux:latest",
      runShell: async () => ({ stdout: "", stderr: "", code: 0 }),
      spawnExec: () =>
        new FakeChildProcess() as unknown as ReturnType<typeof spawnExecSentinel>,
    });
    await expect(
      backend.invoke({ kind: "mouse_move", x: 0, y: 0 }),
    ).rejects.toThrow(/not started/);
  });
});

// `spawnExec` returns a `ChildProcessWithoutNullStreams` in production. The
// test fakes only the surface the backend reads/writes; this sentinel keeps
// TypeScript happy without importing node-internal types here.
declare function spawnExecSentinel(): import("node:child_process").ChildProcessWithoutNullStreams;

// ── QemuBackend — Phase 2 stub ─────────────────────────────────────────────

describe("QemuBackend", () => {
  it("constructor throws SandboxBackendUnavailableError", () => {
    expect(() => new QemuBackend({ image: "anything" })).toThrowError(
      SandboxBackendUnavailableError,
    );
  });

  it("createSandboxDriver({ backend: 'qemu' }) propagates the unavailable error", () => {
    expect(() =>
      createSandboxDriver({ backend: "qemu", image: "anything" }),
    ).toThrowError(SandboxBackendUnavailableError);
  });
});

// ── createSandboxDriver — backend selection ────────────────────────────────

describe("createSandboxDriver", () => {
  it("selects the docker backend when backend='docker'", () => {
    const driver = createSandboxDriver({
      backend: "docker",
      image: "cua/linux:latest",
      dockerOverrides: {
        runShell: async () => ({ stdout: "", stderr: "", code: 0 }),
        spawnExec: () =>
          new FakeChildProcess() as unknown as ReturnType<typeof spawnExecSentinel>,
      },
    });
    expect(driver).toBeInstanceOf(SandboxDriver);
    expect(driver.name).toBe("sandbox:docker");
  });

  it("uses backendOverride when provided (test-only)", () => {
    const backend = makeRecordingBackend();
    const driver = createSandboxDriver({
      backend: "docker",
      image: "ignored",
      backendOverride: backend,
    });
    expect(driver.name).toBe("sandbox:recording");
  });

  it("throws for an unknown backend name", () => {
    expect(() =>
      createSandboxDriver({
        backend: "bogus" as unknown as "docker",
        image: "cua/linux:latest",
      }),
    ).toThrowError(SandboxBackendUnavailableError);
  });
});

// ── getCurrentDriver — mode selection seam ─────────────────────────────────

interface FakeService {
  getConfig(): {
    mode: "yolo" | "sandbox";
    sandbox?: { backend: "docker" | "qemu"; image: string };
  };
}

function fakeRuntime(service: FakeService | null): {
  getService: <T>(_t: string) => T | null;
} {
  return {
    getService: <T>(_t: string) => service as T | null,
  };
}

describe("getCurrentDriver", () => {
  it("returns null when mode='yolo' (legacy host path)", () => {
    const runtime = fakeRuntime({
      getConfig: () => ({ mode: "yolo" }),
    });
    expect(
      getCurrentDriver(
        runtime as unknown as Parameters<typeof getCurrentDriver>[0],
      ),
    ).toBeNull();
  });

  it("returns null when no ComputerUseService is registered", () => {
    expect(
      getCurrentDriver(
        fakeRuntime(null) as unknown as Parameters<
          typeof getCurrentDriver
        >[0],
      ),
    ).toBeNull();
  });

  it("throws SandboxBackendUnavailableError if mode='sandbox' but no sandbox config", () => {
    const runtime = fakeRuntime({
      getConfig: () => ({ mode: "sandbox" }),
    });
    expect(() =>
      getCurrentDriver(
        runtime as unknown as Parameters<typeof getCurrentDriver>[0],
      ),
    ).toThrowError(SandboxBackendUnavailableError);
  });

  it("throws SandboxBackendUnavailableError when sandbox backend='qemu' (Phase 2)", () => {
    const runtime = fakeRuntime({
      getConfig: () => ({
        mode: "sandbox",
        sandbox: { backend: "qemu", image: "qemu/x" },
      }),
    });
    expect(() =>
      getCurrentDriver(
        runtime as unknown as Parameters<typeof getCurrentDriver>[0],
      ),
    ).toThrowError(SandboxBackendUnavailableError);
  });
});

// ── resolveModeFromEnv ─────────────────────────────────────────────────────

describe("resolveModeFromEnv", () => {
  it("defaults to yolo when undefined", () => {
    expect(resolveModeFromEnv(undefined)).toBe("yolo");
  });
  it("defaults to yolo for empty string", () => {
    expect(resolveModeFromEnv("")).toBe("yolo");
  });
  it("defaults to yolo for unknown values", () => {
    expect(resolveModeFromEnv("garbage")).toBe("yolo");
  });
  it("returns sandbox when 'sandbox'", () => {
    expect(resolveModeFromEnv("sandbox")).toBe("sandbox");
  });
});
