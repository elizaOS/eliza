/**
 * Unit coverage for SandboxManager state, exec/run quoting, workspace mapping,
 * browser endpoints, event-log overflow, and container lifecycle. The manager
 * is the real module; a deterministic in-memory ISandboxEngine stand-in is the
 * only collaborator, because the constructor always constructs an engine and
 * standard/max start talks to a container daemon.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ContainerExecOptions,
  ContainerExecResult,
  ContainerRunOptions,
  EngineInfo,
  ISandboxEngine,
  SandboxEngineType,
} from "./sandbox-engine.ts";
import { SandboxManager } from "./sandbox-manager.ts";

type EngineControl = {
  available: boolean;
  engineType: SandboxEngineType;
  images: Set<string>;
  health: boolean;
  orphans: string[];
  pullError: Error | null;
  runError: Error | null;
  browserRunError: Error | null;
  stopError: Error | null;
  execError: Error | null;
  execResult: ContainerExecResult;
  blockRun: Promise<void> | null;
  createdVia: "createEngine" | "detectBestEngine" | null;
  createdType: SandboxEngineType | null;
  nextId: number;
};

type EngineCalls = {
  run: ContainerRunOptions[];
  exec: ContainerExecOptions[];
  stop: string[];
  remove: string[];
  pull: string[];
  list: string[];
  health: string[];
};

const fake = vi.hoisted(() => {
  const calls: EngineCalls = {
    run: [],
    exec: [],
    stop: [],
    remove: [],
    pull: [],
    list: [],
    health: [],
  };

  const control: EngineControl = {
    available: true,
    engineType: "docker",
    images: new Set([
      "eliza-sandbox:bookworm-slim",
      "eliza-sandbox-browser:bookworm-slim",
    ]),
    health: true,
    orphans: [],
    pullError: null,
    runError: null,
    browserRunError: null,
    stopError: null,
    execError: null,
    execResult: {
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 4,
    },
    blockRun: null,
    createdVia: null,
    createdType: null,
    nextId: 0,
  };

  function reset(): void {
    calls.run.length = 0;
    calls.exec.length = 0;
    calls.stop.length = 0;
    calls.remove.length = 0;
    calls.pull.length = 0;
    calls.list.length = 0;
    calls.health.length = 0;
    control.available = true;
    control.engineType = "docker";
    control.images = new Set([
      "eliza-sandbox:bookworm-slim",
      "eliza-sandbox-browser:bookworm-slim",
    ]);
    control.health = true;
    control.orphans = [];
    control.pullError = null;
    control.runError = null;
    control.browserRunError = null;
    control.stopError = null;
    control.execError = null;
    control.execResult = {
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 4,
    };
    control.blockRun = null;
    control.createdVia = null;
    control.createdType = null;
    control.nextId = 0;
  }

  const engine: ISandboxEngine = {
    get engineType() {
      return control.engineType;
    },
    isAvailable() {
      return control.available;
    },
    getInfo(): EngineInfo {
      return {
        type: control.engineType,
        available: control.available,
        version: "test",
        platform: "test",
        arch: "test",
        details: "test-engine",
      };
    },
    async runContainer(opts: ContainerRunOptions): Promise<string> {
      if (control.blockRun) await control.blockRun;
      calls.run.push(opts);
      if (opts.name.includes("-browser-") && control.browserRunError) {
        throw control.browserRunError;
      }
      if (control.runError) throw control.runError;
      control.nextId += 1;
      return `cid-${control.nextId}`;
    },
    async execInContainer(
      opts: ContainerExecOptions,
    ): Promise<ContainerExecResult> {
      calls.exec.push(opts);
      if (control.execError) throw control.execError;
      return { ...control.execResult };
    },
    async stopContainer(id: string): Promise<void> {
      calls.stop.push(id);
      if (control.stopError) throw control.stopError;
    },
    async removeContainer(id: string): Promise<void> {
      calls.remove.push(id);
    },
    isContainerRunning(): boolean {
      return true;
    },
    imageExists(image: string): boolean {
      return control.images.has(image);
    },
    async pullImage(image: string): Promise<void> {
      calls.pull.push(image);
      if (control.pullError) throw control.pullError;
      control.images.add(image);
    },
    listContainers(prefix: string): string[] {
      calls.list.push(prefix);
      return [...control.orphans];
    },
    async healthCheck(id: string): Promise<boolean> {
      calls.health.push(id);
      return control.health;
    },
  };

  return { engine, calls, control, reset };
});

vi.mock("./sandbox-engine.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sandbox-engine.ts")>();
  return {
    ...actual,
    createEngine: (type: SandboxEngineType) => {
      fake.control.createdVia = "createEngine";
      fake.control.createdType = type;
      return fake.engine;
    },
    detectBestEngine: () => {
      fake.control.createdVia = "detectBestEngine";
      return fake.engine;
    },
  };
});

function makeManager(
  workspaceRoot: string,
  overrides: {
    mode?: "off" | "light" | "standard" | "max";
    image?: string;
    containerPrefix?: string;
    workdir?: string;
    network?: string;
    user?: string;
    capDrop?: string[];
    env?: Record<string, string>;
    memory?: string;
    cpus?: number;
    pidsLimit?: number;
    readOnlyRoot?: boolean;
    dns?: string[];
    engineType?: SandboxEngineType;
    browser?: {
      enabled?: boolean;
      image?: string;
      cdpPort?: number;
      vncPort?: number;
      noVncPort?: number;
      headless?: boolean;
      enableNoVnc?: boolean;
      autoStart?: boolean;
    };
  } = {},
): SandboxManager {
  return new SandboxManager({
    mode: "off",
    workspaceRoot,
    engineType: "docker",
    ...overrides,
  });
}

async function startReady(
  workspaceRoot: string,
  overrides: Parameters<typeof makeManager>[1] = {},
): Promise<SandboxManager> {
  const manager = makeManager(workspaceRoot, {
    mode: "standard",
    ...overrides,
  });
  await manager.start();
  return manager;
}

describe("SandboxManager", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    fake.reset();
    workspaceRoot = mkdtempSync(path.join(tmpdir(), "sandbox-manager-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  describe("constructor and accessors", () => {
    it("starts uninitialized, not ready, and records the configured mode", () => {
      const manager = makeManager(workspaceRoot, { mode: "light" });
      expect(manager.getState()).toBe("uninitialized");
      expect(manager.isReady()).toBe(false);
      expect(manager.getMode()).toBe("light");
      expect(manager.engineType).toBe("docker");
      expect(manager.getStatus()).toEqual({
        state: "uninitialized",
        mode: "light",
        containerId: null,
        browserContainerId: null,
      });
    });

    it("creates an explicit engine type through createEngine", () => {
      makeManager(workspaceRoot, { engineType: "apple-container" });
      expect(fake.control.createdVia).toBe("createEngine");
      expect(fake.control.createdType).toBe("apple-container");
    });

    it("detects an engine when engineType is omitted", () => {
      new SandboxManager({ mode: "off", workspaceRoot });
      expect(fake.control.createdVia).toBe("detectBestEngine");
    });

    it("creates the configured workspace root on access", () => {
      const manager = makeManager(workspaceRoot);
      expect(manager.getWorkspaceRoot()).toBe(workspaceRoot);
      expect(existsSync(workspaceRoot)).toBe(true);
    });
  });

  describe("getContainerWorkspacePath", () => {
    it("maps the workspace root to the container workdir", () => {
      const manager = makeManager(workspaceRoot);
      expect(manager.getContainerWorkspacePath(workspaceRoot)).toBe(
        "/workspace",
      );
    });

    it("maps a nested host path with posix separators", () => {
      const manager = makeManager(workspaceRoot);
      const hostPath = path.join(workspaceRoot, "src", "app.ts");
      expect(manager.getContainerWorkspacePath(hostPath)).toBe(
        "/workspace/src/app.ts",
      );
    });

    it("returns null for a path outside the workspace", () => {
      const manager = makeManager(workspaceRoot);
      const outside = path.resolve(workspaceRoot, "..", "escape");
      expect(manager.getContainerWorkspacePath(outside)).toBeNull();
    });

    it("uses a custom container workdir and normalizes backslashes", () => {
      const manager = makeManager(workspaceRoot, {
        workdir: "\\sandbox\\root",
      });
      const hostPath = path.join(workspaceRoot, "a");
      expect(manager.getContainerWorkspacePath(hostPath)).toBe(
        "/sandbox/root/a",
      );
    });
  });

  describe("off and light modes", () => {
    it("start in off mode moves uninitialized to stopped and is idempotent", async () => {
      const manager = makeManager(workspaceRoot, { mode: "off" });
      await manager.start();
      expect(manager.getState()).toBe("stopped");
      expect(manager.isReady()).toBe(false);
      const afterFirst = manager.getEventLog();
      expect(afterFirst).toEqual([
        expect.objectContaining({
          type: "state_change",
          detail: "uninitialized → stopped",
        }),
      ]);

      await manager.start();
      expect(manager.getEventLog()).toHaveLength(1);
      expect(fake.calls.run).toHaveLength(0);
    });

    it("start in light mode becomes ready without creating a container", async () => {
      const manager = makeManager(workspaceRoot, { mode: "light" });
      await manager.start();
      expect(manager.getState()).toBe("ready");
      expect(manager.isReady()).toBe(true);
      expect(manager.getStatus().containerId).toBeNull();
      expect(fake.calls.run).toHaveLength(0);

      await manager.start();
      expect(
        manager.getEventLog().filter((event) => event.type === "state_change"),
      ).toHaveLength(1);
    });

    it("stop is a no-op once already stopped and stops uninitialized without engine calls", async () => {
      const stopped = makeManager(workspaceRoot, { mode: "off" });
      await stopped.start();
      await stopped.stop();
      expect(stopped.getState()).toBe("stopped");
      expect(fake.calls.stop).toHaveLength(0);

      const fresh = makeManager(workspaceRoot, { mode: "light" });
      await fresh.stop();
      expect(fresh.getState()).toBe("stopped");
      expect(fresh.getEventLog()).toEqual([
        expect.objectContaining({
          type: "state_change",
          detail: "uninitialized → stopped",
        }),
      ]);
    });

    it("stop from light ready walks stopping then stopped", async () => {
      const manager = makeManager(workspaceRoot, { mode: "light" });
      await manager.start();
      await manager.stop();
      expect(manager.getState()).toBe("stopped");
      expect(manager.getEventLog().map((event) => event.detail)).toEqual([
        "uninitialized → ready",
        "ready → stopping",
        "stopping → stopped",
      ]);
    });

    it("exec and run refuse off and light without touching the engine", async () => {
      const off = makeManager(workspaceRoot, { mode: "off" });
      await off.start();
      const offResult = await off.exec({ command: "echo hi" });
      expect(offResult).toEqual(
        expect.objectContaining({
          exitCode: 1,
          stdout: "",
          stderr: "Sandbox exec not available in current mode",
          executedInSandbox: false,
        }),
      );
      expect(offResult.durationMs).toBeGreaterThanOrEqual(0);

      const light = makeManager(workspaceRoot, { mode: "light" });
      await light.start();
      const runResult = await light.run({
        cmd: "echo",
        args: ["hello world"],
      });
      expect(runResult.executedInSandbox).toBe(false);
      expect(runResult.stderr).toBe(
        "Sandbox exec not available in current mode",
      );
      expect(fake.calls.exec).toHaveLength(0);
      expect(
        off.getEventLog().some((event) => event.type === "exec_denied"),
      ).toBe(false);
    });

    it("recover is a no-op unless the manager is degraded", async () => {
      const manager = makeManager(workspaceRoot, { mode: "light" });
      await manager.start();
      await manager.recover();
      expect(manager.getState()).toBe("ready");
      expect(fake.calls.run).toHaveLength(0);
    });
  });

  describe("standard and max container lifecycle", () => {
    it("start provisions the default container and becomes ready when healthy", async () => {
      const manager = await startReady(workspaceRoot);
      expect(manager.getState()).toBe("ready");
      expect(manager.getStatus().containerId).toBe("cid-1");
      expect(fake.calls.list).toEqual(["eliza-sandbox"]);
      expect(fake.calls.run).toHaveLength(1);

      const run = fake.calls.run[0];
      expect(run?.image).toBe("eliza-sandbox:bookworm-slim");
      expect(run?.detach).toBe(true);
      expect(run?.name.startsWith("eliza-sandbox-")).toBe(true);
      expect(run?.network).toBe("none");
      expect(run?.user).toBe("1000:1000");
      expect(run?.capDrop).toEqual(["ALL"]);
      expect(run?.memory).toBe("512m");
      expect(run?.cpus).toBe(1);
      expect(run?.pidsLimit).toBe(256);
      expect(run?.env).toEqual({});
      expect(run?.mounts).toEqual([
        { host: workspaceRoot, container: "/workspace", readonly: false },
      ]);
      expect(fake.calls.health).toEqual(["cid-1"]);
      expect(manager.getEventLog().map((event) => event.type)).toEqual([
        "state_change",
        "container_start",
        "health_check",
        "state_change",
      ]);
    });

    it("forwards custom container config and treats max like standard", async () => {
      const manager = await startReady(workspaceRoot, {
        mode: "max",
        image: "custom:latest",
        containerPrefix: "acme",
        workdir: "/data",
        network: "bridge",
        user: "0:0",
        capDrop: ["NET_RAW"],
        env: { FOO: "bar" },
        memory: "1g",
        cpus: 2,
        pidsLimit: 64,
        readOnlyRoot: true,
        dns: ["1.1.1.1"],
      });
      fake.control.images.add("custom:latest");
      expect(manager.getMode()).toBe("max");
      const run = fake.calls.run[0];
      expect(run?.image).toBe("custom:latest");
      expect(run?.name.startsWith("acme-")).toBe(true);
      expect(run?.network).toBe("bridge");
      expect(run?.user).toBe("0:0");
      expect(run?.capDrop).toEqual(["NET_RAW"]);
      expect(run?.env).toEqual({ FOO: "bar" });
      expect(run?.memory).toBe("1g");
      expect(run?.cpus).toBe(2);
      expect(run?.pidsLimit).toBe(64);
      expect(run?.readOnlyRoot).toBe(true);
      expect(run?.dns).toEqual(["1.1.1.1"]);
      expect(run?.mounts).toEqual([
        { host: workspaceRoot, container: "/data", readonly: false },
      ]);
    });

    it("cleans an empty orphan list and a single orphan in list order", async () => {
      await startReady(workspaceRoot);
      expect(fake.calls.stop).toHaveLength(0);
      expect(fake.calls.remove).toHaveLength(0);

      fake.reset();
      fake.control.orphans = ["orphan-a"];
      await startReady(workspaceRoot);
      expect(fake.calls.stop).toEqual(["orphan-a"]);
      expect(fake.calls.remove).toEqual(["orphan-a"]);
    });

    it("stops and removes multiple orphans in the order the engine listed them", async () => {
      fake.control.orphans = ["orphan-b", "orphan-a"];
      await startReady(workspaceRoot);
      expect(fake.calls.stop).toEqual(["orphan-b", "orphan-a"]);
      expect(fake.calls.remove).toEqual(["orphan-b", "orphan-a"]);
    });

    it("pulls a missing image and continues when the pull succeeds", async () => {
      fake.control.images.delete("eliza-sandbox:bookworm-slim");
      const manager = await startReady(workspaceRoot);
      expect(fake.calls.pull).toEqual(["eliza-sandbox:bookworm-slim"]);
      expect(manager.getState()).toBe("ready");
    });

    it("degrades and rethrows when a missing image cannot be pulled", async () => {
      fake.control.images.delete("eliza-sandbox:bookworm-slim");
      fake.control.pullError = new Error("network down");
      const manager = makeManager(workspaceRoot, {
        mode: "standard",
        image: "missing:tag",
      });
      await expect(manager.start()).rejects.toThrow(
        'Sandbox image "missing:tag" not found. Build with: scripts/sandbox-setup.sh',
      );
      expect(manager.getState()).toBe("degraded");
      expect(
        manager
          .getEventLog()
          .some(
            (event) =>
              event.type === "error" &&
              event.detail.includes("Sandbox start failed"),
          ),
      ).toBe(true);
    });

    it("degrades and rethrows when the engine is unavailable", async () => {
      fake.control.available = false;
      fake.control.engineType = "docker";
      const manager = makeManager(workspaceRoot, { mode: "standard" });
      await expect(manager.start()).rejects.toThrow(
        'Container engine "docker" is not available. Install Docker or Apple Container.',
      );
      expect(manager.getState()).toBe("degraded");
      expect(fake.calls.run).toHaveLength(0);
    });

    it("marks degraded when the health check fails after the container starts", async () => {
      fake.control.health = false;
      const manager = makeManager(workspaceRoot, { mode: "standard" });
      await manager.start();
      expect(manager.getState()).toBe("degraded");
      expect(manager.isReady()).toBe(false);
      expect(
        manager
          .getEventLog()
          .filter((event) => event.type === "health_check")
          .map((event) => event.detail),
      ).toEqual(["unhealthy"]);
    });

    it("does not create a second container when already ready", async () => {
      const manager = await startReady(workspaceRoot);
      await manager.start();
      expect(fake.calls.run).toHaveLength(1);
      expect(manager.getState()).toBe("ready");
    });

    it("serializes a stop behind an in-flight start", async () => {
      let release: (() => void) | undefined;
      fake.control.blockRun = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager = makeManager(workspaceRoot, { mode: "standard" });
      const startPromise = manager.start();
      await Promise.resolve();
      expect(manager.getState()).toBe("initializing");

      const stopPromise = manager.stop();
      await Promise.resolve();
      expect(manager.getState()).toBe("initializing");
      expect(fake.calls.stop).toHaveLength(0);

      release?.();
      await startPromise;
      await stopPromise;
      expect(manager.getState()).toBe("stopped");
      expect(manager.getStatus().containerId).toBeNull();
      expect(fake.calls.stop).toEqual(["cid-1"]);
      expect(fake.calls.remove).toEqual(["cid-1"]);
    });

    it("stop still reaches stopped when container teardown throws", async () => {
      const manager = await startReady(workspaceRoot);
      fake.control.stopError = new Error("stop failed");
      await manager.stop();
      expect(manager.getState()).toBe("stopped");
      expect(
        manager
          .getEventLog()
          .some(
            (event) =>
              event.type === "error" &&
              event.detail.includes("Sandbox stop error"),
          ),
      ).toBe(true);
    });

    it("cleanup of a missing container id is a no-op on stop after a failed start", async () => {
      fake.control.available = false;
      const manager = makeManager(workspaceRoot, { mode: "standard" });
      await expect(manager.start()).rejects.toThrow(/not available/);
      await manager.stop();
      expect(manager.getState()).toBe("stopped");
      expect(fake.calls.stop).toHaveLength(0);
      expect(fake.calls.remove).toHaveLength(0);
    });
  });

  describe("recover", () => {
    it("rebuilds a degraded sandbox and becomes ready when the new container is healthy", async () => {
      fake.control.health = false;
      const manager = makeManager(workspaceRoot, { mode: "standard" });
      await manager.start();
      expect(manager.getState()).toBe("degraded");

      fake.control.health = true;
      fake.control.orphans = ["leftover"];
      await manager.recover();
      expect(manager.getState()).toBe("ready");
      expect(fake.calls.stop).toEqual(["cid-1", "leftover"]);
      expect(fake.calls.remove).toEqual(["cid-1", "leftover"]);
      expect(manager.getStatus().containerId).toBe("cid-2");
      expect(
        manager
          .getEventLog()
          .some(
            (event) =>
              event.type === "state_change" &&
              event.detail === "Attempting recovery from degraded state",
          ),
      ).toBe(true);
    });

    it("stays degraded when recovery fails and does not throw", async () => {
      fake.control.health = false;
      const manager = makeManager(workspaceRoot, { mode: "standard" });
      await manager.start();
      fake.control.runError = new Error("cannot recreate");
      await expect(manager.recover()).resolves.toBeUndefined();
      expect(manager.getState()).toBe("degraded");
      expect(
        manager
          .getEventLog()
          .some(
            (event) =>
              event.type === "error" &&
              event.detail.includes("Recovery failed"),
          ),
      ).toBe(true);
    });

    it("returns to degraded when recovery health fails", async () => {
      fake.control.available = false;
      const manager = makeManager(workspaceRoot, { mode: "standard" });
      await expect(manager.start()).rejects.toThrow(/not available/);

      fake.control.available = true;
      fake.control.health = false;
      await manager.recover();
      expect(manager.getState()).toBe("degraded");
    });
  });

  describe("exec and run", () => {
    it("denies exec when standard mode has not started", async () => {
      const manager = makeManager(workspaceRoot, { mode: "standard" });
      const result = await manager.exec({ command: "true" });
      expect(result).toEqual(
        expect.objectContaining({
          exitCode: 1,
          stdout: "",
          stderr: "Sandbox not ready (state=uninitialized)",
          executedInSandbox: false,
        }),
      );
      expect(
        manager
          .getEventLog()
          .some(
            (event) =>
              event.type === "exec_denied" &&
              event.detail === "Sandbox not ready (state=uninitialized)",
          ),
      ).toBe(true);
      expect(fake.calls.exec).toHaveLength(0);
    });

    it("forwards exec to the engine only when ready and stamps executedInSandbox", async () => {
      fake.control.execResult = {
        exitCode: 7,
        stdout: "hello",
        stderr: "warn",
        durationMs: 11,
      };
      const manager = await startReady(workspaceRoot);
      const result = await manager.exec({
        command: "echo hi",
        workdir: "/tmp",
        env: { A: "1" },
        timeoutMs: 50,
        stdin: "in",
      });
      expect(result).toEqual({
        exitCode: 7,
        stdout: "hello",
        stderr: "warn",
        durationMs: 11,
        executedInSandbox: true,
      });
      expect(fake.calls.exec[0]).toEqual({
        containerId: "cid-1",
        command: "echo hi",
        workdir: "/tmp",
        env: { A: "1" },
        timeoutMs: 50,
        stdin: "in",
      });
      expect(
        manager
          .getEventLog()
          .some(
            (event) =>
              event.type === "exec" &&
              event.detail === "echo hi" &&
              event.metadata?.workdir === "/tmp",
          ),
      ).toBe(true);
    });

    it("records an error event and refuses when the engine exec throws", async () => {
      const manager = await startReady(workspaceRoot);
      fake.control.execError = new Error("broken pipe");
      const result = await manager.exec({ command: "boom" });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Exec error: Error: broken pipe");
      expect(result.executedInSandbox).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("run quotes argv the way POSIX single quotes require", async () => {
      const manager = await startReady(workspaceRoot);
      await manager.run({
        cmd: "printf",
        args: ["", "safe_token-1.0/@:%", "hello world", "it's"],
      });
      expect(fake.calls.exec[0]?.command).toBe(
        "printf '' safe_token-1.0/@:% 'hello world' 'it'\\''s'",
      );
    });
  });

  describe("browser containers and endpoints", () => {
    it("starts a browser sidecar and exposes default endpoints", async () => {
      const manager = await startReady(workspaceRoot, {
        browser: { enabled: true, autoStart: true },
      });
      expect(manager.getStatus().browserContainerId).toBe("cid-2");
      expect(manager.getBrowserCdpEndpoint()).toBe("http://localhost:9222");
      expect(manager.getBrowserWsEndpoint()).toBe("ws://localhost:9222");
      expect(manager.getBrowserNoVncEndpoint()).toBeNull();

      const browserRun = fake.calls.run[1];
      expect(browserRun?.image).toBe("eliza-sandbox-browser:bookworm-slim");
      expect(browserRun?.name.includes("-browser-")).toBe(true);
      expect(browserRun?.network).toBe("bridge");
      expect(browserRun?.user).toBe("1000:1000");
      expect(browserRun?.capDrop).toEqual([]);
      expect(browserRun?.mounts).toEqual([]);
      expect(browserRun?.env).toEqual({
        ELIZA_BROWSER_CDP_PORT: "9222",
        ELIZA_BROWSER_VNC_PORT: "5900",
        ELIZA_BROWSER_NOVNC_PORT: "6080",
        ELIZA_BROWSER_ENABLE_NOVNC: "0",
        ELIZA_BROWSER_HEADLESS: "0",
      });
      expect(browserRun?.ports).toEqual([
        { host: 9222, container: 9222 },
        { host: 5900, container: 5900 },
      ]);
    });

    it("publishes noVNC only when enabled and not headless", async () => {
      const manager = await startReady(workspaceRoot, {
        browser: {
          enabled: true,
          autoStart: true,
          enableNoVnc: true,
          headless: false,
          cdpPort: 9333,
          vncPort: 5901,
          noVncPort: 6081,
          image: "browser:custom",
        },
      });
      fake.control.images.add("browser:custom");
      expect(manager.getBrowserCdpEndpoint()).toBe("http://localhost:9333");
      expect(manager.getBrowserWsEndpoint()).toBe("ws://localhost:9333");
      expect(manager.getBrowserNoVncEndpoint()).toBe(
        "http://localhost:6081/vnc.html?autoconnect=true&resize=scale&view_only=true",
      );
      const browserRun = fake.calls.run[1];
      expect(browserRun?.image).toBe("browser:custom");
      expect(browserRun?.ports).toEqual([
        { host: 9333, container: 9333 },
        { host: 5901, container: 5901 },
        { host: 6081, container: 6081 },
      ]);
      expect(browserRun?.env.ELIZA_BROWSER_ENABLE_NOVNC).toBe("1");
    });

    it("hides noVNC when headless even if the flag is on", async () => {
      const manager = await startReady(workspaceRoot, {
        browser: {
          enabled: true,
          autoStart: true,
          enableNoVnc: true,
          headless: true,
        },
      });
      expect(manager.getBrowserNoVncEndpoint()).toBeNull();
      expect(fake.calls.run[1]?.ports).toEqual([
        { host: 9222, container: 9222 },
        { host: 5900, container: 5900 },
      ]);
    });

    it("treats a browser start failure as non-fatal", async () => {
      fake.control.browserRunError = new Error("no browser image");
      const manager = await startReady(workspaceRoot, {
        browser: { enabled: true, autoStart: true },
      });
      expect(manager.getState()).toBe("ready");
      expect(manager.getStatus().browserContainerId).toBeNull();
      expect(manager.getBrowserCdpEndpoint()).toBeNull();
      expect(manager.getBrowserWsEndpoint()).toBeNull();
      expect(manager.getBrowserNoVncEndpoint()).toBeNull();
      expect(
        manager
          .getEventLog()
          .some(
            (event) =>
              event.type === "error" &&
              event.detail.includes("Browser container start failed"),
          ),
      ).toBe(true);
    });

    it("returns null endpoints when no browser container exists", () => {
      const manager = makeManager(workspaceRoot, { mode: "light" });
      expect(manager.getBrowserCdpEndpoint()).toBeNull();
      expect(manager.getBrowserWsEndpoint()).toBeNull();
      expect(manager.getBrowserNoVncEndpoint()).toBeNull();
    });

    it("does not auto-start the browser unless both enabled and autoStart are set", async () => {
      await startReady(workspaceRoot, {
        browser: { enabled: true, autoStart: false },
      });
      expect(fake.calls.run).toHaveLength(1);
    });
  });

  describe("event log", () => {
    it("returns a copy so callers cannot mutate the internal log", async () => {
      const manager = makeManager(workspaceRoot, { mode: "off" });
      await manager.start();
      const copy = manager.getEventLog();
      copy.pop();
      expect(manager.getEventLog()).toHaveLength(1);
    });

    it("trims the log to the newest 500 events once it exceeds 1000", async () => {
      const manager = await startReady(workspaceRoot);
      const before = manager.getEventLog().length;
      const extra = 1001 - before;
      for (let i = 0; i < extra; i += 1) {
        await manager.exec({ command: `echo ${i}` });
      }
      expect(manager.getEventLog()).toHaveLength(500);
      const last = manager.getEventLog().at(-1);
      expect(last?.type).toBe("exec");
      expect(last?.detail).toBe(`echo ${extra - 1}`);
    });
  });
});
