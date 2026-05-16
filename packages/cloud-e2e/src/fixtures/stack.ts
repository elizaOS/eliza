/**
 * Cloud E2E stack fixture.
 *
 * Boots the full mock-backed cloud stack:
 *   1. PGlite TCP bridge (via packages/scripts/cloud/admin/dev/pglite-server.ts)
 *   2. Hetzner mock (in-process, free port)
 *   3. Control-plane mock (in-process, free port, points at Hetzner mock)
 *   4. cloud-api worker subprocess (cloud-api-dev.mjs → wrangler dev)
 *   5. cloud-frontend Vite dev subprocess
 *
 * Returns a handle with URLs and a `stop()` that tears everything down.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  startHetznerMock,
  type RunningHetznerMock,
} from "@elizaos/cloud-test-mocks/hetzner";
import {
  startControlPlaneMock,
  type RunningControlPlaneMock,
} from "@elizaos/cloud-test-mocks/control-plane";

import { buildSharedEnv } from "./env";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const LOG_DIR = resolve(import.meta.dirname, "../../.logs");

export interface StackHandle {
  stop: () => Promise<void>;
  urls: {
    api: string;
    frontend: string;
    hetzner: string;
    controlPlane: string;
    pglite: string;
  };
  mocks: {
    hetzner: RunningHetznerMock;
    controlPlane: RunningControlPlaneMock;
  };
  dataDir: string;
  logDir: string;
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHttpOk(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 500;
  const label = opts.label ?? url;
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status < 500) return;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await delay(intervalMs);
  }
  throw new Error(
    `[stack] ${label} did not become healthy at ${url} within ${timeoutMs}ms: ${String(lastErr)}`,
  );
}

interface SpawnedProc {
  child: ChildProcess;
  log: WriteStream;
  name: string;
}

function spawnLogged(
  name: string,
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; logFile: string },
): SpawnedProc {
  const log = createWriteStream(options.logFile, { flags: "a" });
  log.write(
    `\n--- spawn ${name} @ ${new Date().toISOString()} ---\n` +
      `cmd: ${command} ${args.join(" ")}\ncwd: ${options.cwd}\n\n`,
  );
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on("error", (err) => {
    log.write(`\n[${name}] spawn error: ${String(err)}\n`);
  });
  child.on("exit", (code, signal) => {
    log.write(`\n[${name}] exited code=${code} signal=${signal}\n`);
  });
  return { child, log, name };
}

async function killProc(proc: SpawnedProc): Promise<void> {
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return;
  proc.child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (proc.child.exitCode === null && proc.child.signalCode === null) {
    if (Date.now() > deadline) {
      proc.child.kill("SIGKILL");
      break;
    }
    await delay(100);
  }
  await new Promise<void>((r) => proc.log.end(() => r()));
}

export interface StartCloudStackOptions {
  /** Skip running cloud-shared migrations. Defaults to false. */
  skipMigrate?: boolean;
  /** Override API port. Default: free port. */
  apiPort?: number;
  /** Override frontend port. Default: free port. */
  frontendPort?: number;
}

/**
 * Start the full cloud test stack. Heavy — only call once per worker.
 */
export async function startCloudStack(
  opts: StartCloudStackOptions = {},
): Promise<StackHandle> {
  await mkdir(LOG_DIR, { recursive: true });
  const dataDir = await mkdtemp(join(tmpdir(), "cloud-e2e-"));
  const pgDataDir = join(dataDir, "pgdata");
  await mkdir(pgDataDir, { recursive: true });

  const hetznerPort = await pickFreePort();
  const controlPlanePort = await pickFreePort();
  const pglitePort = await pickFreePort();
  const apiPort = opts.apiPort ?? (await pickFreePort());
  const frontendPort = opts.frontendPort ?? (await pickFreePort());

  // 1. In-process mocks
  const hetzner = await startHetznerMock({
    port: hetznerPort,
    actionMs: Number(process.env.MOCK_HETZNER_ACTION_MS ?? "30"),
  });
  const controlPlane = await startControlPlaneMock({
    port: controlPlanePort,
    hetznerUrl: hetzner.url,
    tickMs: Number(process.env.CONTROL_PLANE_TICK_MS ?? "50"),
  });

  const sharedEnv = buildSharedEnv(
    {
      hetzner: hetzner.url,
      controlPlane: controlPlane.url,
      pgliteHost: "127.0.0.1",
      pglitePort,
    },
    {
      PGLITE_DATA_DIR: pgDataDir,
      DEV_CLOUD_PGLITE_DATA_DIR: pgDataDir,
      DEV_CLOUD_PGLITE_PORT: String(pglitePort),
      API_DEV_PORT: String(apiPort),
      PORT: String(frontendPort),
    },
  );

  const procs: SpawnedProc[] = [];

  // 2. cloud-api worker subprocess. cloud-api-dev.mjs spins up the PGlite TCP
  //    bridge, runs migrations, and execs wrangler dev. We let it manage PGlite
  //    so we don't have to duplicate that logic.
  const apiEnv = {
    ...sharedEnv,
    DEV_CLOUD_SKIP_MIGRATE: opts.skipMigrate ? "1" : "0",
  };
  procs.push(
    spawnLogged(
      "cloud-api",
      "bun",
      ["run", "packages/scripts/cloud/admin/dev/cloud-api-dev.mjs"],
      {
        env: apiEnv,
        cwd: REPO_ROOT,
        logFile: join(LOG_DIR, "cloud-api.log"),
      },
    ),
  );

  const apiUrl = `http://127.0.0.1:${apiPort}`;
  await waitForHttpOk(`${apiUrl}/api/health`, {
    timeoutMs: 180_000,
    label: "cloud-api",
  });

  // 3. cloud-frontend Vite dev
  const frontendEnv = {
    ...sharedEnv,
    PORT: String(frontendPort),
    VITE_API_BASE_URL: apiUrl,
    NEXT_PUBLIC_API_BASE_URL: apiUrl,
  };
  procs.push(
    spawnLogged("cloud-frontend", "bun", ["run", "dev"], {
      env: frontendEnv,
      cwd: join(REPO_ROOT, "packages", "cloud-frontend"),
      logFile: join(LOG_DIR, "cloud-frontend.log"),
    }),
  );

  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  await waitForHttpOk(frontendUrl, {
    timeoutMs: 120_000,
    label: "cloud-frontend",
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // Reverse order: frontend, api, then mocks
    for (const proc of [...procs].reverse()) {
      await killProc(proc).catch(() => undefined);
    }
    await controlPlane.stop().catch(() => undefined);
    await hetzner.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  };

  // Best-effort cleanup if a test runner SIGINTs us
  const handler = () => {
    void stop();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);

  return {
    stop,
    urls: {
      api: apiUrl,
      frontend: frontendUrl,
      hetzner: hetzner.url,
      controlPlane: controlPlane.url,
      pglite: `postgresql://postgres@127.0.0.1:${pglitePort}/postgres`,
    },
    mocks: { hetzner, controlPlane },
    dataDir,
    logDir: LOG_DIR,
  };
}
