/** Sandbox recovery restarts the browser, and the in-memory event log stays bounded and redacted. Uses an in-memory container engine. */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ContainerExecOptions,
  ContainerRunOptions,
  ISandboxEngine,
} from "../src/services/sandbox-engine.ts";
import {
  SandboxManager,
  type SandboxManagerConfig,
} from "../src/services/sandbox-manager.ts";

class FakeEngine implements ISandboxEngine {
  readonly engineType = "docker" as const;
  readonly running = new Map<string, ContainerRunOptions>();
  healthy = true;
  private nextId = 0;

  isAvailable() {
    return true;
  }
  getInfo() {
    return {
      type: "docker" as const,
      available: true,
      version: "fake",
      platform: process.platform,
      arch: process.arch,
      details: "fake",
    };
  }
  async runContainer(opts: ContainerRunOptions) {
    const id = `c${++this.nextId}`;
    this.running.set(id, opts);
    return id;
  }
  async execInContainer(_opts: ContainerExecOptions) {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  }
  async stopContainer() {}
  async removeContainer(id: string) {
    this.running.delete(id);
  }
  isContainerRunning(id: string) {
    return this.running.has(id);
  }
  imageExists() {
    return true;
  }
  async pullImage() {}
  listContainers() {
    return [];
  }
  async healthCheck() {
    return this.healthy;
  }
}

let workspaceRoot: string | undefined;
afterEach(async () => {
  if (workspaceRoot)
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
  workspaceRoot = undefined;
});

async function makeManager(
  extra: Partial<SandboxManagerConfig> = {},
): Promise<{ manager: SandboxManager; engine: FakeEngine }> {
  workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sandbox-recover-"));
  const manager = new SandboxManager({
    mode: "standard",
    workspaceRoot,
    engineType: "docker",
    ...extra,
  });
  const engine = new FakeEngine();
  (manager as unknown as { engine: ISandboxEngine }).engine = engine;
  return { manager, engine };
}

describe("SandboxManager recover", () => {
  it("recreates the browser container when browser autoStart is enabled", async () => {
    const { manager, engine } = await makeManager({
      browser: { enabled: true, autoStart: true },
    });
    engine.healthy = false;
    await manager.start();
    expect(manager.getState()).toBe("degraded");
    expect(manager.getBrowserCdpEndpoint()).toBe("http://localhost:9222");

    engine.healthy = true;
    await manager.recover();

    expect(manager.getState()).toBe("ready");
    const status = manager.getStatus();
    expect(status.browserContainerId).not.toBeNull();
    expect(engine.running.get(status.browserContainerId ?? "")?.image).toBe(
      "eliza-sandbox-browser:bookworm-slim",
    );
    expect(engine.running.size).toBe(2);
    expect(manager.getBrowserCdpEndpoint()).toBe("http://localhost:9222");
  });

  it("records a browser failure during recovery without failing it", async () => {
    const { manager, engine } = await makeManager({
      browser: { enabled: true, autoStart: true },
    });
    engine.healthy = false;
    await manager.start();
    engine.healthy = true;
    const run = engine.runContainer.bind(engine);
    engine.runContainer = async (opts) => {
      if (opts.name.includes("-browser-")) throw new Error("no browser image");
      return run(opts);
    };

    await manager.recover();

    expect(manager.getState()).toBe("ready");
    expect(manager.getBrowserCdpEndpoint()).toBeNull();
    expect(
      manager
        .getEventLog()
        .some(
          (e) =>
            e.type === "error" && e.detail.includes("Browser container start"),
        ),
    ).toBe(true);
  });
});

describe("SandboxManager event log", () => {
  it("keeps only the most recent 1000 events", async () => {
    const { manager } = await makeManager();
    await manager.start();
    for (let i = 0; i < 1500; i++) {
      await manager.exec({ command: `echo ${i}` });
    }
    const log = manager.getEventLog();
    expect(log).toHaveLength(1000);
    expect(log.at(-1)?.detail).toBe("echo 1499");
    expect(log[0]?.detail).toBe("echo 500");
  });

  it("redacts secrets and truncates long commands", async () => {
    const { manager } = await makeManager();
    await manager.start();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await manager.exec({ command: `GITHUB_TOKEN=${token} git push` });
    await manager.exec({ command: `echo ${"x".repeat(500)}` });

    const execs = manager.getEventLog().filter((e) => e.type === "exec");
    expect(execs[0]?.detail).not.toContain(token);
    expect(execs[0]?.detail).toContain("git push");
    expect(execs[1]?.detail.length).toBeLessThanOrEqual(201);
  });
});
