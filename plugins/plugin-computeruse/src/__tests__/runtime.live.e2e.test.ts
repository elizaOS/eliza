import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLiveRuntimeChildEnv } from "../../../../packages/app-core/test/helpers/live-child-env.ts";

type RuntimeHarness = {
  port: number;
  close: () => Promise<void>;
  logs: () => string;
};

type RuntimeOrderItem = {
  name: string;
  id: string | null;
};

type RuntimeServiceOrderItem = {
  serviceType: string;
};

type RuntimeDebugSnapshot = {
  runtimeAvailable: boolean;
  order: {
    plugins: RuntimeOrderItem[];
    actions: RuntimeOrderItem[];
    providers: RuntimeOrderItem[];
    services: RuntimeServiceOrderItem[];
  };
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to allocate port."));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(addr.port);
      });
    });
  });
}

async function startRuntime(): Promise<RuntimeHarness> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "computeruse-runtime-"));
  const stateDir = path.join(tmp, "state");
  const configPath = path.join(tmp, "eliza.json");
  const port = await getFreePort();
  const logBuf: string[] = [];

  await mkdir(stateDir, { recursive: true });
  await mkdir(path.join(stateDir, "cache"), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      logging: { level: "info" },
      plugins: { allow: ["computeruse"] },
    }),
    "utf8",
  );

  const child = spawn("bun", ["run", "start"], {
    cwd: REPO_ROOT,
    env: createLiveRuntimeChildEnv({
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_STATE_DIR: stateDir,
      ELIZA_PORT: String(port),
      ELIZA_API_PORT: String(port),
      CACHE_DIR: path.join(stateDir, "cache"),
      ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
      COMPUTER_USE_ENABLED: "1",
      ALLOW_NO_DATABASE: "",
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => logBuf.push(chunk));
  child.stderr.on("data", (chunk: string) => logBuf.push(chunk));

  const deadline = Date.now() + 150_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        const data = (await response.json()) as {
          ready?: boolean;
          runtime?: string;
        };
        if (data.ready === true && data.runtime === "ok") {
          ready = true;
          break;
        }
      }
    } catch {
      // Runtime is still booting.
    }
    await sleep(1000);
  }

  if (!ready) {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(() => resolve(), 10_000);
      });
    }
    await rm(tmp, { recursive: true, force: true });
    throw new Error(
      `Computer-use runtime failed to become ready.\n${logBuf.join("").slice(-8000)}`,
    );
  }

  return {
    port,
    logs: () => logBuf.join("").slice(-8000),
    close: async () => {
      if (child.exitCode == null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          setTimeout(() => resolve(), 10_000);
        });
        if (child.exitCode == null) {
          child.kill("SIGKILL");
        }
      }
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

const runE2E =
  process.env.COMPUTER_USE_E2E_RUNTIME === "1" ||
  process.env.COMPUTER_USE_LIVE_E2E === "1";

describe.runIf(runE2E)("computer-use runtime registration (live e2e)", () => {
  let runtime: RuntimeHarness | undefined;

  beforeAll(async () => {
    runtime = await startRuntime();
  }, 180_000);

  afterAll(async () => {
    if (runtime) {
      await runtime.close();
    }
  });

  it("registers the plugin actions, provider, and service in a booted runtime", async () => {
    const response = await fetch(
      `http://127.0.0.1:${runtime.port}/api/runtime?maxDepth=1&maxArrayLength=200&maxObjectEntries=200&maxStringLength=256`,
    );

    expect(response.ok, runtime.logs()).toBe(true);
    const snapshot = (await response.json()) as RuntimeDebugSnapshot;
    expect(snapshot.runtimeAvailable).toBe(true);

    const pluginNames = snapshot.order.plugins.map((item) => item.name);
    const actionNames = snapshot.order.actions.map((item) => item.name);
    const providerNames = snapshot.order.providers.map((item) => item.name);
    const serviceTypes = snapshot.order.services.map(
      (item) => item.serviceType,
    );

    expect(pluginNames).toContain("@elizaos/plugin-computeruse");
    expect(actionNames).toEqual(
      expect.arrayContaining(["COMPUTER_USE", "WINDOW"]),
    );
    expect(providerNames).toContain("computerState");
    expect(serviceTypes).toContain("computeruse");
  });

  it("exposes the computer-use approval API against the live runtime", async () => {
    const response = await fetch(
      `http://127.0.0.1:${runtime.port}/api/computer-use/approvals`,
    );

    expect(response.ok, runtime.logs()).toBe(true);
    const snapshot = (await response.json()) as {
      mode: string;
      pendingCount: number;
      pendingApprovals: unknown[];
    };

    expect(snapshot.mode).toBeTruthy();
    expect(typeof snapshot.pendingCount).toBe("number");
    expect(Array.isArray(snapshot.pendingApprovals)).toBe(true);
  });
});
