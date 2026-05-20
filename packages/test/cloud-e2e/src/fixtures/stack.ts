/**
 * Cloud E2E stack fixture.
 *
 * Boots the full mock-backed cloud stack:
 *   1. PGlite TCP bridge (via packages/scripts/cloud/admin/dev/pglite-server.ts)
 *   2. Hetzner mock (in-process, free port)
 *   3. Real container-control-plane sidecar with a test memory sandbox provider
 *   4. cloud-api worker subprocess (Node-hosted Worker fetch adapter)
 *   5. cloud-frontend Vite dev subprocess
 *
 * Returns a handle with URLs and a `stop()` that tears everything down.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type RunningHetznerMock,
  startHetznerMock,
} from "@elizaos/cloud-test-mocks/hetzner";
import { closeDatabaseConnectionsForTests } from "@elizaos/cloud-shared/db/client";

import { buildSharedEnv } from "./env";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const LOG_DIR = resolve(import.meta.dirname, "../../.logs");
const PGLITE_SERVER_SCRIPT = "packages/scripts/cloud/admin/dev/pglite-server.ts";
const CLOUD_API_E2E_SERVER_SCRIPT =
  "packages/scripts/cloud/admin/dev/cloud-api-e2e-server.mjs";

interface RunningControlPlaneService {
  url: string;
  port: number;
}

function isBunExecutable(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/");
  return normalized.endsWith("/bun") || normalized.includes("/.bun/bin/bun");
}

function isUsableNodeExecutable(candidate: string | undefined): candidate is string {
  if (!candidate || isBunExecutable(candidate) || !existsSync(candidate)) {
    return false;
  }
  const probe = spawnSync(
    candidate,
    ["-p", "Boolean(process.versions.bun) ? 'bun' : 'node'"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return probe.status === 0 && probe.stdout.trim() === "node";
}

function resolveNodeExecutable(): string {
  const pathCandidates =
    process.env.PATH?.split(":").map((entry) => resolve(entry, "node")) ?? [];
  const candidates = [
    process.env.ELIZA_CLOUD_E2E_NODE,
    process.env.NODE,
    process.env.npm_node_execpath,
    ...pathCandidates,
  ];
  const node = candidates.find(isUsableNodeExecutable);
  if (!node) {
    throw new Error("[stack] unable to locate a real Node.js executable");
  }
  return node;
}

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
    controlPlane: RunningControlPlaneService;
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

function runLoggedStep(
  name: string,
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; logFile: string },
): void {
  const log = createWriteStream(options.logFile, { flags: "a" });
  log.write(
    `\n--- run ${name} @ ${new Date().toISOString()} ---\n` +
      `cmd: ${command} ${args.join(" ")}\ncwd: ${options.cwd}\n\n`,
  );
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });
  if (result.stdout) log.write(result.stdout);
  if (result.stderr) log.write(result.stderr);
  log.end();
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `[stack] ${name} exited with code ${result.status ?? "unknown"}`,
    );
  }
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
  await access(resolve(REPO_ROOT, PGLITE_SERVER_SCRIPT));
  await access(resolve(REPO_ROOT, CLOUD_API_E2E_SERVER_SCRIPT));

  const dataDir = await mkdtemp(join(tmpdir(), "cloud-e2e-"));
  const pgDataDir = join(dataDir, "pgdata");
  await mkdir(pgDataDir, { recursive: true });

  const hetznerPort = await pickFreePort();
  const controlPlanePort = await pickFreePort();
  const pglitePort = await pickFreePort();
  const apiPort = opts.apiPort ?? (await pickFreePort());
  const frontendPort = opts.frontendPort ?? (await pickFreePort());
  const node = resolveNodeExecutable();

  // 1. In-process mocks
  const hetzner = await startHetznerMock({
    port: hetznerPort,
    actionMs: Number(process.env.MOCK_HETZNER_ACTION_MS ?? "30"),
  });
  const controlPlane = {
    url: `http://127.0.0.1:${controlPlanePort}`,
    port: controlPlanePort,
  };

  const sharedEnv = buildSharedEnv(
    {
      hetzner: hetzner.url,
      controlPlane: controlPlane.url,
      pgliteHost: "127.0.0.1",
      pglitePort,
    },
    {
      ELIZA_TEST_SANDBOX_PROVIDER: "memory",
      WARM_POOL_ENABLED: "false",
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
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    process.removeListener("SIGINT", handler);
    process.removeListener("SIGTERM", handler);
    const pgliteProcs = procs.filter((proc) => proc.name === "pglite");
    const appProcs = procs.filter((proc) => proc.name !== "pglite");
    // Reverse order: frontend, api, control-plane. Keep PGlite alive until
    // local repository pools are closed so teardown does not race open sockets.
    for (const proc of [...appProcs].reverse()) {
      await killProc(proc).catch(() => undefined);
    }
    await closeDatabaseConnectionsForTests().catch(() => undefined);
    for (const proc of [...pgliteProcs].reverse()) {
      await killProc(proc).catch(() => undefined);
    }
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
    await hetzner.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  };

  // Best-effort cleanup if a test runner SIGINTs us.
  const handler = () => {
    void stop();
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);

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
      spawnLogged("pglite", "bun", ["run", PGLITE_SERVER_SCRIPT], {
        env: pgliteEnv,
        cwd: REPO_ROOT,
        logFile: join(LOG_DIR, "pglite.log"),
      }),
    );
    await waitForTcp("127.0.0.1", pglitePort, {
      timeoutMs: 60_000,
      label: "pglite",
    });

    // 3. Real container-control-plane sidecar. It uses the production
    //    DB-backed provisioning queue with an explicit test memory sandbox
    //    provider, so CI does not need Docker or live Hetzner credentials.
    const controlPlaneEnv = {
      ...sharedEnv,
      HOST: "127.0.0.1",
      PORT: String(controlPlanePort),
      CONTAINER_CONTROL_PLANE_PORT: String(controlPlanePort),
      CONTAINER_CONTROL_PLANE_IDLE_TIMEOUT_SECONDS: "30",
    };
    procs.push(
      spawnLogged("container-control-plane", "bun", ["run", "start"], {
        env: controlPlaneEnv,
        cwd: join(REPO_ROOT, "packages", "cloud-services", "container-control-plane"),
        logFile: join(LOG_DIR, "container-control-plane.log"),
      }),
    );
    await waitForHttpOk(`${controlPlane.url}/health`, {
      timeoutMs: 60_000,
      label: "container-control-plane",
    });

    // 4. cloud-api worker subprocess. The mock-stack E2E harness uses a
    //    Node-hosted Worker fetch adapter so CI exercises the real routes and
    //    database without depending on Wrangler's interactive local runtime.
    const apiEnv = {
      ...sharedEnv,
      DEV_CLOUD_SKIP_MIGRATE: opts.skipMigrate ? "1" : "0",
    };
    if (!opts.skipMigrate) {
      runLoggedStep(
        "cloud-api-migrate",
        "bun",
        ["run", "packages/scripts/cloud/admin/migrate-with-diagnostics.ts"],
        {
          env: apiEnv,
          cwd: REPO_ROOT,
          logFile: join(LOG_DIR, "cloud-api.log"),
        },
      );
    }
    procs.push(
      spawnLogged(
        "cloud-api",
        node,
        ["--import", "tsx", resolve(REPO_ROOT, CLOUD_API_E2E_SERVER_SCRIPT)],
        {
          env: apiEnv,
          cwd: join(REPO_ROOT, "packages", "cloud-api"),
          logFile: join(LOG_DIR, "cloud-api.log"),
        },
      ),
    );

    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const databaseUrl = `postgresql://postgres@127.0.0.1:${pglitePort}/postgres`;
    await waitForHttpOk(`${apiUrl}/api/health`, {
      timeoutMs: 180_000,
      label: "cloud-api",
    });
    process.env.DATABASE_URL = databaseUrl;
    process.env.TEST_DATABASE_URL = databaseUrl;

    // 5. cloud-frontend Vite dev
    const frontendEnv = {
      ...sharedEnv,
      PORT: String(frontendPort),
      VITE_API_BASE_URL: apiUrl,
      NEXT_PUBLIC_API_BASE_URL: apiUrl,
    };
    procs.push(
      spawnLogged(
        "cloud-frontend",
        "bun",
        ["run", "dev", "--", "--host", "127.0.0.1"],
        {
          env: frontendEnv,
          cwd: join(REPO_ROOT, "packages", "cloud-frontend"),
          logFile: join(LOG_DIR, "cloud-frontend.log"),
        },
      ),
    );

    const frontendUrl = `http://127.0.0.1:${frontendPort}`;
    await waitForHttpOk(frontendUrl, {
      timeoutMs: 120_000,
      label: "cloud-frontend",
    });

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
    await stop();
    throw error;
  }
}
