/**
 * Live Docker-backed local-safe sandbox integration test.
 *
 * Exercises the REAL host-side coding chokepoint `runShell({mode:'local-safe'})`
 * against a REAL Docker `SandboxManager` (a long-lived container created by
 * `SandboxManager.start()`), proving that:
 *   - the docker backend is actually selected (engineType==='docker'),
 *   - commands execute INSIDE the container, not on the host,
 *   - the only host-visible filesystem boundary is the declared `workspaceRoot`
 *     bind-mount — writes elsewhere in the container never touch the host,
 *   - the structured event log records the exec through the docker container,
 *   - teardown removes the container with no orphan.
 *
 * This is the integration delta over `shell-execution-router.test.ts`, which
 * mocks `SandboxManager.run` in-process and never starts a real container.
 *
 * GATING (CI stays green with no docker daemon):
 *   const dockerReady =
 *     process.env.ELIZA_SANDBOX_DOCKER_LIVE === "1" && new DockerEngine().isAvailable();
 *   const live = dockerReady ? it : it.skip;
 * `DockerEngine.isAvailable()` runs `docker info` synchronously and swallows the
 * throw, so a bare box with no daemon collects (never throws) and every case is
 * reported skipped — never failed. The explicit ELIZA_SANDBOX_DOCKER_LIVE=1
 * opt-in keeps this out of the default `bun run --cwd packages/agent test` lane
 * even on dev boxes that happen to have Docker running.
 *
 * RUN IT LIVE:
 *   ELIZA_SANDBOX_DOCKER_LIVE=1 bunx vitest run \
 *     src/services/shell-execution-router.docker-sandbox.live.test.ts
 * Needs: a reachable Docker daemon (`docker info` exits 0), the opt-in flag, and
 * outbound network for the first `debian:bookworm-slim` pull (override via
 * ELIZA_SANDBOX_TEST_IMAGE). No cloud keys, no E2B.
 */

import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerEngine } from "./sandbox-engine.ts";
import { SandboxManager } from "./sandbox-manager.ts";
import {
  __resetShellRouterBrokerForTests,
  runShell,
  type ShellRouterContext,
} from "./shell-execution-router.ts";

const dockerReady =
  process.env.ELIZA_SANDBOX_DOCKER_LIVE === "1" &&
  new DockerEngine().isAvailable();

// Three-tier clean skip, mirroring remote-capability-cloud-sandbox.cloud-smoke.test.ts:
// `DockerEngine.isAvailable()` swallows the `docker info` throw, so a bare box
// with no daemon collects without error and every case is reported skipped.
const live = dockerReady ? it : it.skip;

const TEST_IMAGE =
  process.env.ELIZA_SANDBOX_TEST_IMAGE ?? "debian:bookworm-slim";

// Container start can include a cold image pull on the first run.
const LIVE_TIMEOUT_MS = 180_000;

describe("runShell local-safe docker sandbox (live)", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let mgr: SandboxManager | null = null;
  let oldStateDir: string | undefined;

  beforeAll(async () => {
    if (!dockerReady) {
      console.warn(
        "[shell-router-docker-sandbox] skipped: Docker live lane not active. " +
          "Set ELIZA_SANDBOX_DOCKER_LIVE=1 and ensure a Docker daemon is reachable " +
          "(`docker info` must exit 0) to run this suite.",
      );
      return;
    }

    // Hermetic, asserted-empty workspace boundary — do NOT rely on
    // resolveStateDir/ELIZA_STATE_DIR for the host-untouched assertion.
    tmpDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "agent-docker-sandbox-live-"),
    );
    workspaceRoot = path.join(tmpDir, "ws");
    await fsp.mkdir(workspaceRoot, { recursive: true });

    // Keep the manager's default workspaceRoot off any shared state dir too.
    oldStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = tmpDir;

    __resetShellRouterBrokerForTests();

    mgr = new SandboxManager({
      mode: "standard",
      engineType: "docker",
      image: TEST_IMAGE,
      workspaceRoot,
      workdir: "/workspace",
      network: "none",
    });
    await mgr.start();
  }, LIVE_TIMEOUT_MS);

  afterAll(async () => {
    try {
      if (mgr) {
        await mgr.stop();
      }
    } finally {
      __resetShellRouterBrokerForTests();
      if (oldStateDir === undefined) {
        delete process.env.ELIZA_STATE_DIR;
      } else {
        process.env.ELIZA_STATE_DIR = oldStateDir;
      }
      if (tmpDir) {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      }
    }
  });

  const ctx = (): ShellRouterContext => ({
    mode: "local-safe",
    sandboxManager: mgr,
  });

  live(
    "selects the docker backend and reaches ready state",
    () => {
      const manager = mgr;
      if (!manager) throw new Error("SandboxManager not started");
      expect(manager.engineType).toBe("docker");
      expect(manager.isReady()).toBe(true);
      expect(manager.getStatus().containerId).toBeTruthy();
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "runs a benign command inside the docker container and labels sandbox=docker",
    async () => {
      const result = await runShell(
        {
          command: "sh",
          args: ["-c", "echo $((2+3))"],
          cwd: "/workspace",
          toolName: "coding:run",
          timeoutMs: 60_000,
        },
        ctx(),
      );

      expect(result.sandbox).toBe("docker");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("5");
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "records the exec through the docker-backed container in the event log",
    async () => {
      const manager = mgr;
      if (!manager) throw new Error("SandboxManager not started");

      await runShell(
        {
          command: "sh",
          args: ["-c", "true"],
          cwd: "/workspace",
          toolName: "coding:run",
          timeoutMs: 60_000,
        },
        ctx(),
      );

      const log = manager.getEventLog();
      expect(log.some((e) => e.type === "exec")).toBe(true);
      expect(log.some((e) => e.type === "container_start")).toBe(true);
      // Structured proof the exec went through the docker-backed container.
      expect(typeof manager.getStatus().containerId).toBe("string");
      expect(manager.getStatus().containerId).toBeTruthy();
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "host fs untouched: a write ABOVE the bind mount never appears on the host",
    async () => {
      const probe = `/tmp/eliza-host-probe-${randomUUID()}`;
      // Metachars (`>`) live INSIDE the single -c payload token; the engine's
      // parseContainerCommand only sees ['sh','-c','<payload>'] (3 argv tokens),
      // and `sh` interprets the redirect in-container.
      const result = await runShell(
        {
          command: "sh",
          args: ["-c", `echo pwned > ${probe} ; echo done`],
          cwd: "/workspace",
          toolName: "coding:run",
          timeoutMs: 60_000,
        },
        ctx(),
      );
      expect(result.sandbox).toBe("docker");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("done");

      // The container /tmp is not bind-mounted to host — the probe must not exist.
      await expect(fsp.access(probe)).rejects.toThrow();
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "isolation boundary is exactly the workspaceRoot mount and nothing else",
    async () => {
      const manager = mgr;
      if (!manager) throw new Error("SandboxManager not started");

      const before = await fsp.readdir(workspaceRoot);
      expect(before).not.toContain("in-mount.txt");

      const result = await runShell(
        {
          command: "sh",
          args: ["-c", "echo hi > /workspace/in-mount.txt"],
          cwd: "/workspace",
          toolName: "coding:run",
          timeoutMs: 60_000,
        },
        ctx(),
      );
      expect(result.sandbox).toBe("docker");
      expect(result.exitCode).toBe(0);

      // The file lands under the host workspaceRoot (the only writable mount).
      const after = await fsp.readdir(workspaceRoot);
      expect(after).toContain("in-mount.txt");
      const contents = await fsp.readFile(
        path.join(workspaceRoot, "in-mount.txt"),
        "utf8",
      );
      expect(contents.trim()).toBe("hi");

      // Nothing leaked elsewhere in tmpDir outside workspaceRoot.
      const tmpEntries = await fsp.readdir(tmpDir);
      expect(tmpEntries).toEqual(["ws"]);
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "shell metacharacters as a bare argv token are rejected by the engine, never executed on host",
    async () => {
      const probe = `/tmp/eliza-host-metachar-${randomUUID()}`;
      // `;` passed as its OWN argv token (not inside an sh -c payload) trips
      // parseContainerCommand's metachar guard inside the engine → non-zero exit;
      // it must never run on the host.
      const result = await runShell(
        {
          command: "echo",
          args: ["hi", ";", `echo pwned > ${probe}`],
          cwd: "/workspace",
          toolName: "coding:run",
          timeoutMs: 60_000,
        },
        ctx(),
      );
      // engine.execInContainer rejects → SandboxManager.exec returns exitCode 1.
      expect(result.exitCode).not.toBe(0);
      // The metachar payload never ran anywhere; host probe absent.
      await expect(fsp.access(probe)).rejects.toThrow();
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "afterAll teardown leaves the container stopped (no orphan)",
    async () => {
      const manager = mgr;
      if (!manager) throw new Error("SandboxManager not started");
      await manager.stop();
      expect(manager.getState()).toBe("stopped");
      // Re-null so afterAll's stop() is a no-op on an already-stopped manager.
      mgr = null;
    },
    LIVE_TIMEOUT_MS,
  );
});
