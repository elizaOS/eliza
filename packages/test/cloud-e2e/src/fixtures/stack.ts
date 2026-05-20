/**
 * Cloud E2E stack fixture.
 *
 * Boots the full mock-backed cloud stack:
 *   1. PGlite TCP bridge (via packages/scripts/cloud/admin/dev/pglite-server.ts)
 *   2. Hetzner mock (in-process, free port)
 *   3. Control-plane mock (in-process, free port, points at Hetzner mock)
 *   4. cloud-api Hono subprocess (same app, local Bun server)
 *   5. cloud-frontend Vite dev subprocess
 *
 * Returns a handle with URLs and a `stop()` that tears everything down.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type RunningControlPlaneMock,
  startControlPlaneMock,
} from "@elizaos/cloud-test-mocks/control-plane";
import {
  type RunningHetznerMock,
  startHetznerMock,
} from "@elizaos/cloud-test-mocks/hetzner";

import { buildSharedEnv } from "./env";

const CLOUD_E2E_ROOT = resolve(import.meta.dirname, "../..");
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const LOG_DIR = resolve(CLOUD_E2E_ROOT, ".logs");

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

async function waitForTcp(
  host: string,
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 250;
  const label = opts.label ?? `${host}:${port}`;
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((res) => {
      const sock = createConnection({ host, port });
      sock.setTimeout(1_000);
      sock.once("connect", () => {
        sock.end();
        res(true);
      });
      sock.once("timeout", () => {
        sock.destroy();
        res(false);
      });
      sock.once("error", (e) => {
        lastErr = e;
        sock.destroy();
        res(false);
      });
    });
    if (ok) return;
    await delay(intervalMs);
  }
  throw new Error(
    `[stack] ${label} TCP did not open within ${timeoutMs}ms: ${String(lastErr)}`,
  );
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
  try {
    if (proc.child.exitCode === null && proc.child.signalCode === null) {
      proc.child.kill("SIGTERM");
      const deadline = Date.now() + 5_000;
      while (proc.child.exitCode === null && proc.child.signalCode === null) {
        if (Date.now() > deadline) {
          proc.child.kill("SIGKILL");
          break;
        }
        await delay(100);
      }
    }
  } finally {
    await new Promise<void>((r) => proc.log.end(() => r()));
  }
}

async function runLogged(
  name: string,
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; logFile: string },
): Promise<void> {
  const proc = spawnLogged(name, command, args, options);
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveResult, rejectResult) => {
    proc.child.once("error", rejectResult);
    proc.child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
  await killProc(proc);
  if (result.code !== 0) {
    throw new Error(
      `[stack] ${name} exited with code=${result.code} signal=${result.signal}`,
    );
  }
}

async function closeProcessDbConnections(): Promise<void> {
  const { closeDatabaseConnectionsForTests } = await import(
    "@elizaos/cloud-shared/db/client"
  );
  await closeDatabaseConnectionsForTests();
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
    token: "test-token",
    expectedAuxToken: "test-token",
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
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  let stopped = false;
  let processEnvUsesStackDatabase = false;
  const restoreProcessDatabaseEnv = () => {
    if (!processEnvUsesStackDatabase) return;
    processEnvUsesStackDatabase = false;
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (previousTestDatabaseUrl === undefined) {
      delete process.env.TEST_DATABASE_URL;
    } else {
      process.env.TEST_DATABASE_URL = previousTestDatabaseUrl;
    }
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // Reverse order, but keep PGlite alive until process-local pg pools are
    // closed. Otherwise Playwright can pass all tests and then report a
    // teardown-level "Connection terminated unexpectedly" outside any test.
    const reverseProcs = [...procs].reverse();
    for (const proc of reverseProcs) {
      if (proc.name === "pglite") continue;
      await killProc(proc).catch(() => undefined);
    }
    await closeProcessDbConnections().catch(() => undefined);
    for (const proc of reverseProcs) {
      if (proc.name !== "pglite") continue;
      await killProc(proc).catch(() => undefined);
    }
    restoreProcessDatabaseEnv();
    await controlPlane.stop().catch(() => undefined);
    await hetzner.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    // 2. PGlite TCP bridge. We start it directly (rather than letting
    //    cloud-api-dev.mjs manage it) because cloud-api-dev only spawns PGlite
    //    when DATABASE_URL is empty or `pglite://...`, and we set it to a
    //    real postgres URL pointing at this very bridge.
    const pgliteEnv = {
      ...sharedEnv,
      PGLITE_HOST: "127.0.0.1",
      PGLITE_PORT: String(pglitePort),
      PGLITE_DATA_DIR: pgDataDir,
      PGLITE_MAX_CONNECTIONS: process.env.PGLITE_MAX_CONNECTIONS ?? "16",
    };
    procs.push(
      spawnLogged(
        "pglite",
        "bun",
        ["run", "packages/scripts/cloud/admin/dev/pglite-server.ts"],
        {
          env: pgliteEnv,
          cwd: REPO_ROOT,
          logFile: join(LOG_DIR, "pglite.log"),
        },
      ),
    );
    await waitForTcp("127.0.0.1", pglitePort, {
      timeoutMs: 60_000,
      label: "pglite",
    });

    const databaseUrl = `postgresql://postgres@127.0.0.1:${pglitePort}/postgres`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.TEST_DATABASE_URL = databaseUrl;
    processEnvUsesStackDatabase = true;

    if (!opts.skipMigrate) {
      await runLogged("cloud-api-migrate", "bun", ["run", "db:cloud:migrate"], {
        env: sharedEnv,
        cwd: REPO_ROOT,
        logFile: join(LOG_DIR, "cloud-api.log"),
      });
    }

    // 3. cloud-api subprocess. The mock stack uses the same Hono app as the
    //    Worker, but runs it under Bun instead of Wrangler/workerd so CI
    //    validates provisioning/onboarding behavior without coupling these
    //    tests to Wrangler's local dev proxy startup.
    const apiEnv = {
      ...sharedEnv,
      DEV_CLOUD_SKIP_MIGRATE: opts.skipMigrate ? "1" : "0",
    };
    procs.push(
      spawnLogged(
        "cloud-api",
        "bun",
        ["run", "packages/scripts/cloud/admin/dev/cloud-api-hono-dev.ts"],
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

    // 4. cloud-frontend Vite dev
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
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
