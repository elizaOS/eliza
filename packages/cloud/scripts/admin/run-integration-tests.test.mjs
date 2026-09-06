/**
 * Exercises the integration harness lifecycle with real loopback processes and
 * independent PGlite databases, including concurrent ownership boundaries.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  acquirePortLease,
  cleanupRunContext,
  createManagedRunContext,
  createOwnedChildRegistry,
  externalApiHealthy,
  installSignalTeardown,
  managedApiHealthy,
  releasePortLease,
  spawnOwnedChild,
  startOwnedApi,
  startOwnedPGlite,
  stopOwnedChild,
  tcpListening,
  withPreservedTeardown,
} from "./integration-harness-lifecycle.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const cloudApiRoot = path.join(repoRoot, "packages/cloud/api");
const { Client } = pg;
const require = createRequire(import.meta.url);

const tcpFixture = `
  const net = require("node:net");
  const server = net.createServer(() => {});
  server.listen(Number.parseInt(process.env.FIXTURE_PORT, 10), "127.0.0.1");
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
`;

const nestedWranglerWrapperFixture = `
  const { spawn } = require("node:child_process");
  const { writeFileSync } = require("node:fs");
  const wrangler = spawn(process.execPath, [
    process.env.WRANGLER_SCRIPT,
    "dev",
    "--config", process.env.WRANGLER_CONFIG,
    "--ip", process.env.FIXTURE_HOST,
    "--port", process.env.FIXTURE_PORT,
    "--inspector-port", "0",
    "--local",
    "--persist-to", process.env.WRANGLER_PERSIST_TO,
  ], {
    cwd: process.env.WRANGLER_CWD,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: "ignore",
  });
  wrangler.once("spawn", () => {
    writeFileSync(process.env.WRANGLER_PID_FILE, String(wrangler.pid));
  });
  wrangler.once("error", (error) => {
    writeFileSync(process.env.WRANGLER_PID_FILE, "ERROR:" + error.message);
    process.exit(1);
  });
  process.once("SIGTERM", () => process.exit(0));
  process.once("SIGINT", () => process.exit(0));
  setInterval(() => {}, 1000);
`;

function spawnLongLivedFixture(options = {}, extraEnv = {}) {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    ...options,
    env: { ...(options.env ?? process.env), ...extraEnv },
    stdio: "ignore",
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function unusedLoopbackPort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await closeServer(server);
  return port;
}

function resolveWranglerScript() {
  const packagePath = require.resolve("wrangler/package.json", {
    paths: [cloudApiRoot, repoRoot],
  });
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const relativeBin =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin.wrangler;
  return path.join(path.dirname(packagePath), relativeBin);
}

function writeWranglerHealthFixture(context) {
  const workerPath = path.join(context.runRoot, "concurrent-worker.mjs");
  const configPath = path.join(context.runRoot, "concurrent-wrangler.jsonc");
  writeFileSync(
    workerPath,
    `export default { fetch() { return Response.json({ status: "ok", commit: ${JSON.stringify(context.runId)} }); } };\n`,
  );
  writeFileSync(
    configPath,
    `${JSON.stringify({
      name: `cloud-integration-concurrent-${context.runId}`.toLowerCase(),
      main: workerPath,
      compatibility_date: "2025-01-01",
    })}\n`,
  );
  return configPath;
}

function spawnRealWranglerFixture(context, configPath, options) {
  return spawn(
    process.execPath,
    [
      resolveWranglerScript(),
      "dev",
      "--config",
      configPath,
      "--ip",
      context.host,
      "--port",
      String(context.apiPort),
      "--inspector-port",
      "0",
      "--local",
      "--persist-to",
      context.wranglerPersistPath,
    ],
    {
      ...options,
      cwd: context.runRoot,
      env: {
        ...(options.env ?? process.env),
        WRANGLER_CACHE_DIR: context.wranglerCachePath,
        WRANGLER_SEND_METRICS: "false",
        TMPDIR: context.tempDir,
        TMP: context.tempDir,
        TEMP: context.tempDir,
      },
      stdio: "ignore",
    },
  );
}

async function assertStartupSignalStopsChild(kind, signal) {
  const context = await createManagedRunContext();
  const childRegistry = createOwnedChildRegistry();
  const processTarget = new EventEmitter();
  let child;
  let resolveResignal;
  const resignaled = new Promise((resolve) => {
    resolveResignal = resolve;
  });
  const removeSignalHandlers = installSignalTeardown(
    () => childRegistry.stopAll(),
    {
      processTarget,
      resignal: resolveResignal,
    },
  );
  const onSpawn = (spawned) => {
    child = spawned;
    const published = childRegistry.publish(`${kind} startup fixture`, spawned);
    queueMicrotask(() => processTarget.emit(signal));
    return published;
  };
  const spawnImpl = (_command, _args, options) =>
    spawnLongLivedFixture(options);

  try {
    const startup =
      kind === "API"
        ? startOwnedApi(context, {
            spawnImpl,
            signal: childRegistry.signal,
            onSpawn,
            timeoutMs: 5_000,
          })
        : startOwnedPGlite(context, {
            repoRoot,
            spawnImpl,
            signal: childRegistry.signal,
            onSpawn,
            timeoutMs: 5_000,
          });
    const [startupResult, receivedSignal] = await Promise.all([
      startup.then(
        () => ({ status: "fulfilled" }),
        (reason) => ({ status: "rejected", reason }),
      ),
      resignaled,
    ]);
    assert.equal(startupResult.status, "rejected");
    assert.match(startupResult.reason.message, /startup was cancelled/);
    assert.equal(receivedSignal, signal);
    assert.ok(child?.pid);
    assert.equal(processAlive(child.pid), false);
    const port = kind === "API" ? context.apiPort : context.pglitePort;
    assert.equal(await tcpListening(context.host, port), false);
  } finally {
    removeSignalHandlers();
    await childRegistry.stopAll();
    cleanupRunContext(context);
  }
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function writeMarker(context, value) {
  const client = new Client({ connectionString: context.databaseUrl });
  await client.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS harness_marker (id integer PRIMARY KEY, value text NOT NULL)",
    );
    await client.query(
      "INSERT INTO harness_marker (id, value) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value",
      [value],
    );
  } finally {
    await client.end();
  }
}

async function readMarker(context) {
  const client = new Client({ connectionString: context.databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      "SELECT value FROM harness_marker WHERE id = 1",
    );
    return result.rows[0]?.value;
  } finally {
    await client.end();
  }
}

test("refuses a listener that already occupies an explicit port", async () => {
  const foreignServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", commit: "foreign-run" }));
  });

  try {
    foreignServer.listen(0, "127.0.0.1");
    await once(foreignServer, "listening");
    const address = foreignServer.address();
    assert.ok(address && typeof address === "object");

    await assert.rejects(
      createManagedRunContext({ apiPort: address.port }),
      /already owned or listening; refusing to adopt or replace/,
    );
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(response.ok, true);
    assert.equal((await response.json()).commit, "foreign-run");
  } finally {
    await closeServer(foreignServer);
  }
});

test("refuses a listener that races a lease without stopping it", async () => {
  const context = await createManagedRunContext();
  const foreignServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", commit: "foreign-run" }));
  });
  let spawnCalled = false;

  try {
    foreignServer.listen(context.apiPort, context.host);
    await once(foreignServer, "listening");

    await assert.rejects(
      startOwnedApi(context, {
        spawnImpl: (_command, _args, options) => {
          spawnCalled = true;
          return spawnLongLivedFixture(options);
        },
      }),
      /became occupied; refusing to adopt or kill/,
    );
    assert.equal(spawnCalled, false);

    cleanupRunContext(context);
    const response = await fetch(
      `http://${context.host}:${context.apiPort}/api/health`,
    );
    assert.equal(response.ok, true);
    assert.equal((await response.json()).commit, "foreign-run");
  } finally {
    await closeServer(foreignServer);
    if (existsSync(context.runRoot)) cleanupRunContext(context);
  }
});

test("stale lease reclamation compares token and inode before replacement", async () => {
  const leaseRoot = mkdtempSync(
    path.join(os.tmpdir(), "cloud-integration-lease-race-"),
  );
  const port = await unusedLoopbackPort();
  const leasePath = path.join(leaseRoot, `${port}.json`);
  const staleToken = "stale-lease-token";
  writeFileSync(
    leasePath,
    `${JSON.stringify({
      runId: "dead-run",
      token: staleToken,
      pid: 2_147_483_647,
      host: "127.0.0.1",
      port,
      label: "API",
      createdAt: new Date(0).toISOString(),
    })}\n`,
    { mode: 0o600 },
  );

  let observations = 0;
  let releaseObservers;
  const bothObserved = new Promise((resolve) => {
    releaseObservers = resolve;
  });
  const observeStaleLease = async (snapshot) => {
    assert.equal(snapshot.record.token, staleToken);
    assert.ok(snapshot.inode);
    observations += 1;
    if (observations === 2) releaseObservers();
    await bothObserved;
  };

  let winnerLease;
  try {
    const attempts = await Promise.allSettled([
      acquirePortLease({
        runId: "replacement-a",
        label: "API",
        preferredPort: port,
        leaseRoot,
        onStaleLeaseObserved: observeStaleLease,
      }),
      acquirePortLease({
        runId: "replacement-b",
        label: "API",
        preferredPort: port,
        leaseRoot,
        onStaleLeaseObserved: observeStaleLease,
      }),
    ]);
    assert.equal(observations, 2);
    const winners = attempts.filter((result) => result.status === "fulfilled");
    const losers = attempts.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.match(losers[0].reason.message, /already owned or listening/);

    winnerLease = winners[0].value;
    const stored = JSON.parse(readFileSync(leasePath, "utf8"));
    assert.equal(stored.token, winnerLease.token);
    assert.notEqual(stored.token, staleToken);
  } finally {
    releasePortLease(winnerLease);
    rmSync(leaseRoot, { recursive: true, force: true });
  }
});

test("startup signals stop children published before either service is ready", {
  timeout: 30_000,
}, async (t) => {
  await t.test("SIGINT during API startup", async () => {
    await assertStartupSignalStopsChild("API", "SIGINT");
  });
  await t.test("SIGTERM during PGlite startup", async () => {
    await assertStartupSignalStopsChild("PGlite", "SIGTERM");
  });
});

test("PGlite restart ignores a replayed marker and validates the new start identity", {
  timeout: 120_000,
}, async () => {
  const context = await createManagedRunContext();
  const staleToken = "previous-start-token";
  let pgliteChild;

  try {
    writeFileSync(
      context.pgliteReadyFile,
      `${JSON.stringify({
        ownerToken: staleToken,
        runId: context.runId,
        pid: process.pid,
        host: context.host,
        port: context.pglitePort,
        dataDir: context.pgliteDataDir,
      })}\n`,
      { mode: 0o600 },
    );

    await assert.rejects(
      startOwnedPGlite(context, {
        repoRoot,
        timeoutMs: 750,
        spawnImpl: (_command, _args, options) =>
          spawn(process.execPath, ["-e", tcpFixture], {
            ...options,
            env: {
              ...(options.env ?? process.env),
              FIXTURE_PORT: String(context.pglitePort),
            },
            stdio: "ignore",
          }),
      }),
      /timed out waiting for owned PGlite/,
    );
    assert.equal(await tcpListening(context.host, context.pglitePort), false);

    pgliteChild = await startOwnedPGlite(context, {
      repoRoot,
      stdio: "ignore",
    });
    const marker = JSON.parse(readFileSync(context.pgliteReadyFile, "utf8"));
    assert.notEqual(marker.ownerToken, staleToken);
    assert.equal(marker.runId, context.runId);
    assert.equal(marker.pid, pgliteChild.pid);
    assert.equal(marker.host, context.host);
    assert.equal(marker.port, context.pglitePort);
    assert.equal(
      path.resolve(marker.dataDir),
      path.resolve(context.pgliteDataDir),
    );
  } finally {
    await stopOwnedChild(pgliteChild, "PGlite readiness fixture");
    cleanupRunContext(context);
  }
});

test("stopping an owned wrapper terminates its real nested Wrangler process tree", {
  timeout: 60_000,
}, async () => {
  const context = await createManagedRunContext();
  const workerPath = path.join(context.runRoot, "tree-fixture-worker.mjs");
  const configPath = path.join(context.runRoot, "wrangler-tree-fixture.jsonc");
  const pidPath = path.join(context.runRoot, "wrangler-child.pid");
  writeFileSync(
    workerPath,
    `export default { fetch() { return Response.json({ status: "ok" }); } };\n`,
  );
  writeFileSync(
    configPath,
    `${JSON.stringify({
      name: `cloud-integration-tree-${context.runId}`.toLowerCase(),
      main: workerPath,
      compatibility_date: "2025-01-01",
    })}\n`,
  );

  let wrapper;
  let wranglerPid;
  await withPreservedTeardown(
    async () => {
      wrapper = spawnOwnedChild(
        process.execPath,
        ["-e", nestedWranglerWrapperFixture],
        {
          cwd: context.runRoot,
          env: {
            ...process.env,
            WRANGLER_SCRIPT: resolveWranglerScript(),
            WRANGLER_CONFIG: configPath,
            WRANGLER_CWD: context.runRoot,
            WRANGLER_PERSIST_TO: context.wranglerPersistPath,
            WRANGLER_PID_FILE: pidPath,
            FIXTURE_HOST: context.host,
            FIXTURE_PORT: String(context.apiPort),
          },
          stdio: "ignore",
        },
      );
      await waitFor(
        () => existsSync(pidPath),
        "nested Wrangler did not publish its pid",
      );
      const pidText = readFileSync(pidPath, "utf8").trim();
      assert.doesNotMatch(pidText, /^ERROR:/);
      wranglerPid = Number.parseInt(pidText, 10);
      assert.equal(processAlive(wranglerPid), true);
      await waitFor(
        () => externalApiHealthy(context.baseUrl),
        "nested Wrangler did not become healthy",
        30_000,
      );

      await stopOwnedChild(wrapper, "nested Wrangler wrapper", 10_000);
      assert.equal(processAlive(wrapper.pid), false);
      assert.equal(processAlive(wranglerPid), false);
      await waitFor(
        async () => !(await tcpListening(context.host, context.apiPort)),
        "nested Wrangler listener survived owned process-tree teardown",
      );
    },
    async () => {
      await stopOwnedChild(wrapper, "nested Wrangler wrapper", 10_000);
      cleanupRunContext(context);
    },
  );
});

test("operation and teardown failures retain both causes", async () => {
  const primary = new Error("integration batch failed");
  const teardown = new Error("owned process tree failed to stop");
  let teardownCalled = false;

  await assert.rejects(
    withPreservedTeardown(
      async () => {
        throw primary;
      },
      async () => {
        teardownCalled = true;
        throw teardown;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, teardown]);
      assert.equal(error.cause, primary);
      return true;
    },
  );
  assert.equal(teardownCalled, true);
});

test("concurrent managed runs keep ports, databases, and teardown isolated", {
  timeout: 120_000,
}, async () => {
  let contextA;
  let contextB;
  let pgliteA;
  let pgliteB;
  let apiA;
  let apiB;
  let testFailure;

  try {
    [contextA, contextB] = await Promise.all([
      createManagedRunContext(),
      createManagedRunContext(),
    ]);
    assert.notEqual(contextA.apiPort, contextB.apiPort);
    assert.notEqual(contextA.pglitePort, contextB.pglitePort);
    assert.notEqual(contextA.runRoot, contextB.runRoot);
    assert.notEqual(contextA.devVarsPath, contextB.devVarsPath);
    assert.notEqual(contextA.wranglerPersistPath, contextB.wranglerPersistPath);
    assert.notEqual(contextA.wranglerLogPath, contextB.wranglerLogPath);
    const wranglerConfigA = writeWranglerHealthFixture(contextA);
    const wranglerConfigB = writeWranglerHealthFixture(contextB);

    [pgliteA, pgliteB] = await Promise.all([
      startOwnedPGlite(contextA, { repoRoot, stdio: "ignore" }),
      startOwnedPGlite(contextB, { repoRoot, stdio: "ignore" }),
    ]);
    await Promise.all([
      writeMarker(contextA, "run-a"),
      writeMarker(contextB, "run-b"),
    ]);
    assert.deepEqual(
      await Promise.all([readMarker(contextA), readMarker(contextB)]),
      ["run-a", "run-b"],
    );

    [apiA, apiB] = await Promise.all([
      startOwnedApi(contextA, {
        spawnImpl: (_command, _args, options) =>
          spawnRealWranglerFixture(contextA, wranglerConfigA, options),
      }),
      startOwnedApi(contextB, {
        spawnImpl: (_command, _args, options) =>
          spawnRealWranglerFixture(contextB, wranglerConfigB, options),
      }),
    ]);
    assert.equal(await managedApiHealthy(contextA), true);
    assert.equal(await managedApiHealthy(contextB), true);

    await Promise.all([
      stopOwnedChild(apiA, "API fixture A"),
      stopOwnedChild(pgliteA, "PGlite A"),
    ]);
    apiA = null;
    pgliteA = null;
    cleanupRunContext(contextA);

    assert.equal(await managedApiHealthy(contextB), true);
    assert.equal(await readMarker(contextB), "run-b");
    assert.equal(apiB.exitCode, null);
    assert.equal(pgliteB.exitCode, null);
  } catch (error) {
    testFailure = error;
  }

  const stopResults = await Promise.allSettled([
    stopOwnedChild(apiA, "API fixture A"),
    stopOwnedChild(apiB, "API fixture B"),
    stopOwnedChild(pgliteA, "PGlite A"),
    stopOwnedChild(pgliteB, "PGlite B"),
  ]);
  if (contextA && existsSync(contextA.runRoot)) {
    cleanupRunContext(contextA);
  }
  if (contextB && existsSync(contextB.runRoot)) {
    cleanupRunContext(contextB);
  }
  const stopFailures = stopResults
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (testFailure && stopFailures.length > 0) {
    throw new AggregateError(
      [testFailure, ...stopFailures],
      "test and child teardown failed",
    );
  }
  if (testFailure) throw testFailure;
  if (stopFailures.length > 0) {
    throw new AggregateError(stopFailures, "test child teardown failed");
  }
});
