/**
 * Cloud E2E stack fixture.
 *
 * Boots the full mock-backed cloud stack:
 *   1. PGlite TCP bridge (via packages/cloud/scripts/admin/dev/pglite-server.ts)
 *   2. Hetzner mock (in-process, free port)
 *   3. Control-plane mock (in-process, free port, points at Hetzner mock)
 *   4. cloud-api worker subprocess (cloud-api-e2e-server.mjs)
 *   5. packages/app (apex) Vite dev subprocess
 *
 * Returns a handle with URLs and a `stop()` that tears everything down.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type AddressInfo, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
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
import { type RunningMockLlm, startMockLlm } from "./mock-llm";
import {
  type CloudSyntheticStackManifest,
  type RunningSyntheticStack,
  startSyntheticStack,
} from "./synthetic-stack";

/**
 * Resolve the bun executable for `child_process.spawn`. On Windows, Node cannot
 * spawn the extensionless npm `bun` shim (spawn ENOENT) nor a `.cmd` without
 * `shell: true`, so probe the native `bun.exe` first. POSIX uses plain `bun`.
 */
function resolveBun(): string {
  if (process.env.BUN && existsSync(process.env.BUN)) return process.env.BUN;
  const names = process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const dirs = [
    resolve(home, ".bun/bin"),
    ...(process.env.PATH?.split(delimiter) ?? []),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return process.platform === "win32" ? "bun.exe" : "bun";
}

const BUN = resolveBun();

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const LOG_DIR = resolve(import.meta.dirname, "../../.logs");

export interface StackHandle {
  stop: () => Promise<void>;
  urls: {
    api: string;
    /** Empty string when the stack was started with `frontend: false`. */
    frontend: string;
    hetzner: string;
    controlPlane: string;
    pglite: string;
    /** Mock LLM `/v1` base URL — present only when started with `mockLlm`. */
    mockLlm?: string;
    /** Named provider sidecars owned by the synthetic manifest. */
    providers?: Readonly<Record<string, string>>;
  };
  /**
   * True when the frontend Vite dev was NOT booted (API-only stacks started
   * with `frontend: false`). The apex frontend is packages/app's web dev; when
   * a stack opts out of it, frontend-dependent fixtures MUST gate on this flag
   * and skip explicitly, never silently pass on an empty `urls.frontend`.
   */
  frontendSkipped: boolean;
  /** Human-readable reason the frontend was skipped (when frontendSkipped). */
  frontendSkipReason?: string;
  mocks: {
    hetzner: RunningHetznerMock;
    controlPlane: RunningControlPlaneMock;
    mockLlm?: RunningMockLlm;
    providers?: RunningSyntheticStack["providers"];
  };
  synthetic?: RunningSyntheticStack;
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

async function assertSyntheticCloudReadiness(
  apiUrl: string,
  controlPlaneUrl: string,
  synthetic: RunningSyntheticStack,
): Promise<void> {
  const response = await fetch(`${apiUrl}/api/health`, {
    signal: AbortSignal.timeout(2_000),
  });
  const body = (await response.json()) as {
    syntheticWorld?: {
      bootstrapHash?: string;
      providerBindings?: string[];
    } | null;
  };
  const expectedBindings = (
    synthetic.processEnv.ELIZA_SYNTHETIC_PROVIDER_BINDINGS ?? ""
  )
    .split(",")
    .filter(Boolean)
    .sort();
  if (
    body.syntheticWorld?.bootstrapHash !==
      synthetic.processEnv.ELIZA_SYNTHETIC_WORLD_BOOTSTRAP_HASH ||
    JSON.stringify(body.syntheticWorld.providerBindings) !==
      JSON.stringify(expectedBindings)
  ) {
    throw new Error(
      "cloud-api readiness did not receive the synthetic metadata and provider binding names",
    );
  }
  const controlResponse = await fetch(`${controlPlaneUrl}/health`, {
    signal: AbortSignal.timeout(2_000),
  });
  const controlBody = (await controlResponse.json()) as typeof body;
  if (
    controlBody.syntheticWorld?.bootstrapHash !==
      synthetic.processEnv.ELIZA_SYNTHETIC_WORLD_BOOTSTRAP_HASH ||
    JSON.stringify(controlBody.syntheticWorld.providerBindings) !==
      JSON.stringify(expectedBindings)
  ) {
    throw new Error(
      "control-plane readiness did not receive the synthetic metadata and provider binding names",
    );
  }
  synthetic.world.ledger.append({
    kind: "lifecycle",
    status: "observed",
    target: "cloud-api.synthetic-readiness",
    attempt: 1,
    payloadHash: body.syntheticWorld.bootstrapHash,
  });
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

async function runLoggedStep(
  name: string,
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; logFile: string },
): Promise<void> {
  const proc = spawnLogged(name, command, args, options);
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    proc.child.once("error", reject);
    proc.child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve) => proc.log.end(() => resolve()));
  if (result.code !== 0) {
    const suffix = result.signal
      ? `signal ${result.signal}`
      : `code ${result.code}`;
    throw new Error(`[stack] ${name} exited with ${suffix}`);
  }
}

async function killProc(proc: SpawnedProc): Promise<void> {
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
  await new Promise<void>((r) => proc.log.end(() => r()));
}

async function closeCloudSharedDatabaseConnections(): Promise<void> {
  const { closeDatabaseConnectionsForTests } = await import(
    "@elizaos/cloud-shared/db/client"
  );
  await closeDatabaseConnectionsForTests();
}

async function boundedTeardown(
  label: string,
  teardown: () => Promise<void>,
  timeoutMs = 10_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      teardown(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} teardown exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface StartCloudStackOptions {
  /** Skip running cloud-shared migrations. Defaults to false. */
  skipMigrate?: boolean;
  /** Override API port. Default: free port. */
  apiPort?: number;
  /** Override frontend port. Default: free port. */
  frontendPort?: number;
  /**
   * Boot the packages/app (apex) Vite dev server. Defaults to true. Set to false
   * for API-only stacks (e.g. the monetized-app loop) that never drive a browser
   * — skips the Vite spawn + health wait, and leaves `urls.frontend` empty.
   */
  frontend?: boolean;
  /**
   * Boot an in-process OpenAI-compatible mock LLM and point the worker's
   * `OPENAI_BASE_URL` / `OPENAI_API_KEY` at it. Lets `POST /api/v1/messages`
   * run the real billing/markup/earnings seam against an `openai/<model>` id
   * with no paid provider key. Defaults to false.
   */
  mockLlm?: boolean;
  /**
   * Boot the mock LLM in context-aware echo mode (implies `mockLlm`). The
   * assistant reply is derived from the conversation the caller replayed into
   * the model call instead of a fixed string, so a multi-turn spec can assert
   * the reply itself reflects retained history. Defaults to false (fixed reply).
   */
  mockLlmEchoContext?: boolean;
  /**
   * Test-only subprocess environment overrides. Values are scoped to this
   * stack's local PGlite/Worker/frontend processes and never mutate the parent
   * runner, so specs can exercise configuration boundaries without changing
   * another worker's fixture contract.
   */
  env?: Readonly<Record<string, string>>;
  /** Boot one canonical manifest-owned world with strict model/provider sidecars. */
  synthetic?: CloudSyntheticStackManifest;
}

let parentDatabaseEnvOwner: symbol | undefined;

/**
 * Start the full cloud test stack. Heavy — only call once per worker.
 */
export async function startCloudStack(
  opts: StartCloudStackOptions = {},
): Promise<StackHandle> {
  const envOwner = Symbol("cloud-e2e-stack");
  if (parentDatabaseEnvOwner) {
    throw new Error(
      "another Cloud E2E stack owns the parent database environment",
    );
  }
  parentDatabaseEnvOwner = envOwner;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  const procs: SpawnedProc[] = [];
  const startupTeardowns: Array<() => Promise<void>> = [
    async () => {
      for (const proc of [...procs].reverse()) await killProc(proc);
    },
  ];
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const dataDir = await mkdtemp(join(tmpdir(), "cloud-e2e-"));
    startupTeardowns.push(() => rm(dataDir, { recursive: true, force: true }));
    const runId = basename(dataDir);
    const logDir = join(LOG_DIR, runId);
    await mkdir(logDir, { recursive: true });
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
    startupTeardowns.push(() => hetzner.stop());
    const synthetic = opts.synthetic
      ? await startSyntheticStack(opts.synthetic, runId)
      : undefined;
    const mockLlm =
      synthetic?.model ??
      (opts.mockLlm || opts.mockLlmEchoContext
        ? await startMockLlm({ echoContext: opts.mockLlmEchoContext ?? false })
        : undefined);
    if (synthetic) startupTeardowns.push(() => synthetic.stop());
    else if (mockLlm) startupTeardowns.push(() => mockLlm.stop());
    const syntheticProviderBindings = (
      synthetic?.processEnv.ELIZA_SYNTHETIC_PROVIDER_BINDINGS ?? ""
    )
      .split(",")
      .filter(Boolean)
      .sort();
    const controlPlane = await startControlPlaneMock({
      port: controlPlanePort,
      hetznerUrl: hetzner.url,
      tickMs: Number(process.env.CONTROL_PLANE_TICK_MS ?? "50"),
      syntheticBootstrapHash:
        synthetic?.processEnv.ELIZA_SYNTHETIC_WORLD_BOOTSTRAP_HASH,
      syntheticProviderBindings,
    });
    startupTeardowns.push(() => controlPlane.stop());
    const mockLlmEnv: Record<string, string> = mockLlm
      ? {
          OPENAI_API_KEY: "mock-llm-key",
          OPENAI_BASE_URL: mockLlm.url,
        }
      : {};

    const sharedEnv = buildSharedEnv(
      {
        hetzner: hetzner.url,
        controlPlane: controlPlane.url,
        pgliteHost: "127.0.0.1",
        pglitePort,
      },
      {
        DATABASE_URL: `pglite://${pgDataDir}`,
        TEST_DATABASE_URL: "",
        PGLITE_DATA_DIR: pgDataDir,
        DEV_CLOUD_PGLITE_DATA_DIR: pgDataDir,
        DEV_CLOUD_PGLITE_PORT: String(pglitePort),
        API_DEV_PORT: String(apiPort),
        PORT: String(frontendPort),
        ...opts.env,
        ...synthetic?.processEnv,
      },
    );

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
        BUN,
        ["run", "packages/cloud/scripts/admin/dev/pglite-server.ts"],
        {
          env: pgliteEnv,
          cwd: REPO_ROOT,
          logFile: join(logDir, "pglite.log"),
        },
      ),
    );
    await waitForTcp("127.0.0.1", pglitePort, {
      timeoutMs: 60_000,
      label: "pglite",
    });

    const databaseUrl = `postgresql://postgres@127.0.0.1:${pglitePort}/postgres`;
    const stackEnv = {
      ...sharedEnv,
      DATABASE_URL: databaseUrl,
      TEST_DATABASE_URL: databaseUrl,
      // Provider override → the cloud-api dev wrapper syncs OPENAI_API_KEY/
      // OPENAI_BASE_URL into .dev.vars (providerOverrideKeys), so the worker's
      // getOpenAIClient() targets the in-process mock for `openai/<model>` ids.
      ...mockLlmEnv,
    };
    process.env.DATABASE_URL = databaseUrl;
    process.env.TEST_DATABASE_URL = databaseUrl;

    if (!opts.skipMigrate) {
      await runLoggedStep(
        "cloud-migrate",
        BUN,
        ["run", "--cwd", "packages/cloud/shared", "db:migrate"],
        {
          env: stackEnv,
          cwd: REPO_ROOT,
          logFile: join(logDir, "cloud-migrate.log"),
        },
      );
    }

    // Boot cloud-api through its wrangler dev launcher — the same entrypoint the
    // cloud:mock stack uses (`bun run --cwd packages/cloud/api dev`). The earlier
    // no-wrangler "e2e-server" adapter imported cloud-api straight from TypeScript
    // source, which neither node (it can't load the extensionless `.ts` relative
    // imports) nor bun (cloud-api's `@/…` path aliases need a tsconfig `baseUrl`
    // that tsgo forbids) can resolve — only wrangler/esbuild bundling does. The
    // `stripBunAncestryEnv` in env.ts exists precisely so wrangler starts from a
    // bun-spawned context. wrangler pre-bundles, so requests are fast.
    procs.push(
      spawnLogged(
        "cloud-api",
        BUN,
        ["run", "--cwd", "packages/cloud/api", "dev"],
        {
          env: stackEnv,
          cwd: REPO_ROOT,
          logFile: join(logDir, "cloud-api.log"),
        },
      ),
    );

    const apiUrl = `http://127.0.0.1:${apiPort}`;
    await waitForHttpOk(`${apiUrl}/api/health`, {
      timeoutMs: 180_000,
      label: "cloud-api",
    });
    if (synthetic) {
      await assertSyntheticCloudReadiness(apiUrl, controlPlane.url, synthetic);
    }

    // 3. console (apex) frontend Vite dev (skipped for API-only stacks).
    // The apex moved to packages/app in the cloud-frontend→packages/app cutover.
    // packages/app's vite dev does NOT honour VITE_API_PROXY_TARGET; it computes
    // its own ports from ELIZA_API_PORT/ELIZA_PORT (the /api + /ws proxy target)
    // and ELIZA_UI_PORT (the dev server listen port). Inject those so the dev
    // server listens on `frontendPort` and proxies /api at this stack's cloud-api.
    let frontendUrl = "";
    let frontendSkipReason: string | undefined;
    const frontendDir = join(REPO_ROOT, "packages", "app");
    const frontendEnabled = opts.synthetic
      ? opts.synthetic.frontendTargets.includes("app")
      : opts.frontend !== false;
    if (frontendEnabled) {
      if (!existsSync(frontendDir)) {
        throw new Error(
          `[stack] frontend boot requested but ${frontendDir} is missing — ` +
            "the cloud-e2e harness expects packages/app (the apex web dev). " +
            "Pass { frontend: false } for API-only stacks.",
        );
      }
      const frontendEnv = {
        ...stackEnv,
        // packages/app vite dev: UI listen port + /api proxy target.
        ELIZA_UI_PORT: String(frontendPort),
        ELIZA_API_PORT: String(apiPort),
        ELIZA_PORT: String(apiPort),
        VITE_API_BASE_URL: apiUrl,
        NEXT_PUBLIC_API_BASE_URL: apiUrl,
      };
      procs.push(
        spawnLogged(
          "frontend",
          BUN,
          ["run", "dev", "--", "--host", "127.0.0.1"],
          {
            env: frontendEnv,
            cwd: frontendDir,
            logFile: join(logDir, "frontend.log"),
          },
        ),
      );

      frontendUrl = `http://127.0.0.1:${frontendPort}`;
      await waitForHttpOk(frontendUrl, {
        timeoutMs: 120_000,
        label: "frontend",
      });
    } else {
      // API-only stack: no frontend booted. Record why so the handle's
      // frontendSkipped/frontendSkipReason stay coherent and frontend-dependent
      // fixtures (authenticatedPage) skip explicitly rather than reading an empty
      // `urls.frontend` as a pass.
      frontendSkipReason =
        "frontend boot disabled (stack started with { frontend: false }).";
    }

    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const errors: Error[] = [];
        const processResults = await Promise.allSettled([
          boundedTeardown("cloud database connections", () =>
            closeCloudSharedDatabaseConnections(),
          ),
          ...[...procs]
            .reverse()
            .map((proc) => boundedTeardown(proc.name, () => killProc(proc))),
        ]);
        for (const result of processResults) {
          if (result.status === "rejected") {
            // error-policy:J6 Teardown aggregates every component failure below.
            errors.push(
              result.reason instanceof Error
                ? result.reason
                : new Error(String(result.reason)),
            );
          }
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
        const componentResults = await Promise.allSettled([
          boundedTeardown("control-plane", () => controlPlane.stop()),
          boundedTeardown("hetzner", () => hetzner.stop()),
          ...(synthetic
            ? [boundedTeardown("synthetic services", () => synthetic.stop())]
            : mockLlm
              ? [boundedTeardown("mock model", () => mockLlm.stop())]
              : []),
          boundedTeardown("temporary data", () =>
            rm(dataDir, { recursive: true, force: true }),
          ),
        ]);
        for (const result of componentResults) {
          if (result.status === "rejected") {
            // error-policy:J6 Teardown aggregates every component failure below.
            errors.push(
              result.reason instanceof Error
                ? result.reason
                : new Error(String(result.reason)),
            );
          }
        }
        process.removeListener("SIGINT", handler);
        process.removeListener("SIGTERM", handler);
        if (parentDatabaseEnvOwner === envOwner)
          parentDatabaseEnvOwner = undefined;
        if (errors.length > 0)
          throw new AggregateError(errors, "Cloud E2E stack teardown failed");
      })();
      return stopPromise;
    };

    // Best-effort cleanup if a test runner SIGINTs us
    const handler = () => {
      stop().catch(() => {
        // error-policy:J5 The same rejection remains observable through handle.stop().
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);

    const handle: StackHandle = {
      stop,
      urls: {
        api: apiUrl,
        frontend: frontendUrl,
        hetzner: hetzner.url,
        controlPlane: controlPlane.url,
        pglite: `postgresql://postgres@127.0.0.1:${pglitePort}/postgres`,
        ...(mockLlm ? { mockLlm: mockLlm.url } : {}),
        ...(synthetic
          ? {
              providers: Object.fromEntries(
                [...synthetic.providers].map(([id, provider]) => [
                  id,
                  provider.url,
                ]),
              ),
            }
          : {}),
      },
      frontendSkipped: frontendSkipReason !== undefined,
      frontendSkipReason,
      mocks: {
        hetzner,
        controlPlane,
        ...(mockLlm ? { mockLlm } : {}),
        ...(synthetic ? { providers: synthetic.providers } : {}),
      },
      synthetic,
      dataDir,
      logDir,
    };
    return handle;
  } catch (error) {
    const cleanupResults = await Promise.allSettled(
      [...startupTeardowns]
        .reverse()
        .map((teardown, index) =>
          boundedTeardown(`startup resource ${index + 1}`, teardown),
        ),
    );
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousTestDatabaseUrl === undefined)
      delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previousTestDatabaseUrl;
    if (parentDatabaseEnvOwner === envOwner) parentDatabaseEnvOwner = undefined;
    const cleanupErrors = cleanupResults.flatMap((result) =>
      result.status === "rejected"
        ? [
            result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
          ]
        : [],
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [
          error instanceof Error ? error : new Error(String(error)),
          ...cleanupErrors,
        ],
        "Cloud E2E stack startup and cleanup failed",
      );
    }
    throw error;
  }
}
