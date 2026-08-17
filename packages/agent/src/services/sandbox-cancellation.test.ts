/**
 * Exercises real child-process cancellation through SandboxManager and both
 * built-in engine command shapes using deterministic local CLI shims.
 */

import { existsSync, readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AppleContainerEngine,
  DockerEngine,
  type ISandboxEngine,
  type SandboxEngineType,
} from "./sandbox-engine.ts";
import {
  SandboxManager,
  type SandboxRunOptions,
  type SandboxState,
} from "./sandbox-manager.ts";

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// Resolution includes spawning one Docker control shim or the two sequential
// Apple `stop` + `rm` shims. On a loaded host those real process launches can
// exceed 500ms even though the first control command already killed the delayed
// worker. The security assertion is the sentinel remaining absent after its
// deadline; this bound still catches a wedged containment/control path without
// making scheduler latency the test oracle.
const CONTAINMENT_SHIM_COMPLETION_BOUND_MS = 1_500;

let shimDirectory: string;
let originalBaselinePath: string | undefined;
const cleanupDirectories = new Set<string>();

beforeAll(async () => {
  shimDirectory = await fsp.mkdtemp(
    path.join(os.tmpdir(), "sandbox-cancel-cli-"),
  );
  const shim = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const markerPath = process.env.ELIZA_TEST_SANDBOX_LATE_WRITE;
const pidPath = process.env.ELIZA_TEST_SANDBOX_WORKER_PID;
const controlLogPath = process.env.ELIZA_TEST_SANDBOX_CONTROL_LOG;
const operation = process.argv[2];

if (!markerPath || !pidPath || !controlLogPath) process.exit(70);

if (operation === "exec") {
  const worker = spawn(process.execPath, [
    "-e",
    "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 350)",
    markerPath,
  ], { detached: true, stdio: "ignore" });
  writeFileSync(pidPath, String(worker.pid));
  worker.unref();
  setTimeout(() => process.exit(0), 1_200);
} else if (operation === "stop" || operation === "rm") {
  appendFileSync(controlLogPath, operation + "\\n");
  if (process.env.ELIZA_TEST_SANDBOX_CONTROL_FAILURE === "1") process.exit(71);
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf8"));
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
  process.stdout.write(process.argv.at(-1) ?? "sandbox-test");
} else {
  process.exit(64);
}
`;
  await Promise.all(
    ["docker", "container"].map((name) =>
      fsp.writeFile(path.join(shimDirectory, name), shim, { mode: 0o755 }),
    ),
  );

  originalBaselinePath = process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH;
  const inheritedPath = process.env.PATH;
  process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH = inheritedPath
    ? `${shimDirectory}${path.delimiter}${inheritedPath}`
    : shimDirectory;
});

afterAll(async () => {
  if (originalBaselinePath === undefined) {
    delete process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH;
  } else {
    process.env.ELIZA_HOST_EXECUTION_BASELINE_PATH = originalBaselinePath;
  }
  delete process.env.ELIZA_TEST_SANDBOX_LATE_WRITE;
  delete process.env.ELIZA_TEST_SANDBOX_WORKER_PID;
  delete process.env.ELIZA_TEST_SANDBOX_CONTROL_LOG;
  delete process.env.ELIZA_TEST_SANDBOX_CONTROL_FAILURE;
  await fsp.rm(shimDirectory, { recursive: true, force: true });
});

afterEach(async () => {
  for (const directory of cleanupDirectories) {
    await fsp.rm(directory, { recursive: true, force: true });
  }
  cleanupDirectories.clear();
  delete process.env.ELIZA_TEST_SANDBOX_CONTROL_FAILURE;
});

async function createCancellationHarness(
  engineType: Exclude<SandboxEngineType, "auto">,
): Promise<{
  manager: SandboxManager;
  markerPath: string;
  pidPath: string;
  controlLogPath: string;
}> {
  const directory = await fsp.mkdtemp(
    path.join(os.tmpdir(), "sandbox-cancel-"),
  );
  cleanupDirectories.add(directory);
  const markerPath = path.join(directory, "late-write.txt");
  const pidPath = path.join(directory, "worker.pid");
  const controlLogPath = path.join(directory, "control.log");
  process.env.ELIZA_TEST_SANDBOX_LATE_WRITE = markerPath;
  process.env.ELIZA_TEST_SANDBOX_WORKER_PID = pidPath;
  process.env.ELIZA_TEST_SANDBOX_CONTROL_LOG = controlLogPath;

  const manager = new SandboxManager({
    mode: "standard",
    engineType,
    workspaceRoot: directory,
  });
  const engine: ISandboxEngine =
    engineType === "docker" ? new DockerEngine() : new AppleContainerEngine();
  Object.assign(
    manager as unknown as {
      state: SandboxState;
      containerId: string;
      engine: ISandboxEngine;
    },
    {
      state: "ready" satisfies SandboxState,
      containerId: "sandbox-test",
      engine,
    },
  );

  return { manager, markerPath, pidPath, controlLogPath };
}

function terminateHarnessWorker(pidPath: string): void {
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, "utf8"));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // error-policy:J6 The fake worker may already have exited during teardown.
  }
}

describe("managed sandbox cancellation", () => {
  it.each([
    {
      engineType: "docker" as const,
      expectedControlOperations: ["rm"],
    },
    {
      engineType: "apple-container" as const,
      expectedControlOperations: ["stop", "rm"],
    },
  ])(
    "$engineType terminates the container execution before its delayed side effect",
    async ({ engineType, expectedControlOperations }) => {
      if (process.platform === "win32") return;
      const { manager, markerPath, controlLogPath } =
        await createCancellationHarness(engineType);
      const controller = new AbortController();
      const reason = new DOMException("caller cancelled", "AbortError");
      const request: SandboxRunOptions = {
        cmd: "ignored-by-fake-engine",
        args: [],
        timeoutMs: 5_000,
        abortSignal: controller.signal,
      };

      const startedAt = Date.now();
      const outcomePromise = manager.run(request).then(
        () => ({ status: "resolved" as const, error: undefined }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      setTimeout(() => controller.abort(reason), 50);

      const outcome = await outcomePromise;
      const elapsedMs = Date.now() - startedAt;
      await wait(Math.max(0, 650 - elapsedMs));

      expect(outcome.status).toBe("rejected");
      expect(outcome.error).toBe(reason);
      expect(elapsedMs).toBeLessThan(CONTAINMENT_SHIM_COMPLETION_BOUND_MS);
      expect(existsSync(markerPath)).toBe(false);
      expect(manager.getState()).toBe("degraded");
      expect(manager.getStatus().containerId).toBeNull();
      await expect(fsp.readFile(controlLogPath, "utf8")).resolves.toBe(
        `${expectedControlOperations.join("\n")}\n`,
      );
    },
  );

  it("contains a timed-out execution before its delayed side effect", async () => {
    if (process.platform === "win32") return;
    const { manager, markerPath, controlLogPath } =
      await createCancellationHarness("docker");

    const startedAt = Date.now();
    const result = await manager.run({
      cmd: "ignored-by-fake-engine",
      args: [],
      timeoutMs: 50,
    });
    const elapsedMs = Date.now() - startedAt;
    await wait(Math.max(0, 650 - elapsedMs));

    expect(result).toMatchObject({
      exitCode: 124,
      executedInSandbox: true,
    });
    expect(result.stderr).toContain("timed out after 50ms");
    expect(elapsedMs).toBeLessThan(CONTAINMENT_SHIM_COMPLETION_BOUND_MS);
    expect(existsSync(markerPath)).toBe(false);
    expect(manager.getState()).toBe("degraded");
    expect(manager.getStatus().containerId).toBeNull();
    await expect(fsp.readFile(controlLogPath, "utf8")).resolves.toBe("rm\n");
  });

  it("does not start or degrade the container for an already-aborted request", async () => {
    if (process.platform === "win32") return;
    const { manager, markerPath, controlLogPath } =
      await createCancellationHarness("docker");
    const reason = new DOMException("already cancelled", "AbortError");

    await expect(
      manager.run({
        cmd: "must-not-start",
        args: [],
        abortSignal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(controlLogPath)).toBe(false);
    expect(manager.getState()).toBe("ready");
  });

  it("fails closed when the engine cannot confirm containment", async () => {
    if (process.platform === "win32") return;
    const { manager, pidPath } =
      await createCancellationHarness("apple-container");
    process.env.ELIZA_TEST_SANDBOX_CONTROL_FAILURE = "1";
    const controller = new AbortController();
    const request: SandboxRunOptions = {
      cmd: "ignored-by-fake-engine",
      args: [],
      timeoutMs: 5_000,
      abortSignal: controller.signal,
    };

    const outcomePromise = manager
      .run(request)
      .catch((error: unknown) => error);
    setTimeout(() => controller.abort(), 50);
    const outcome = await outcomePromise;
    terminateHarnessWorker(pidPath);

    expect(outcome).toMatchObject({
      code: "SANDBOX_EXEC_CANCELLATION_FAILED",
      severity: "fatal",
    });
    expect(manager.getState()).toBe("degraded");
    expect(manager.getStatus().containerId).toBe("sandbox-test");
    await expect(
      manager.run({ cmd: "must-not-run", args: [] }),
    ).resolves.toMatchObject({
      exitCode: 1,
      executedInSandbox: false,
      stderr: "Sandbox not ready (state=degraded)",
    });
  });

  it("fails closed when timeout containment cannot discard the container", async () => {
    if (process.platform === "win32") return;
    const { manager, pidPath } = await createCancellationHarness("docker");
    process.env.ELIZA_TEST_SANDBOX_CONTROL_FAILURE = "1";

    const outcome = await manager
      .run({
        cmd: "ignored-by-fake-engine",
        args: [],
        timeoutMs: 50,
      })
      .catch((error: unknown) => error);
    terminateHarnessWorker(pidPath);

    expect(outcome).toMatchObject({
      code: "SANDBOX_EXEC_TIMEOUT_CONTAINMENT_FAILED",
      severity: "fatal",
    });
    expect(manager.getState()).toBe("degraded");
    expect(manager.getStatus().containerId).toBe("sandbox-test");
    await expect(
      manager.run({ cmd: "must-not-run", args: [] }),
    ).resolves.toMatchObject({
      exitCode: 1,
      executedInSandbox: false,
      stderr: "Sandbox not ready (state=degraded)",
    });
  });
});
