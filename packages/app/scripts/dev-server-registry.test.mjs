/**
 * Exercises deterministic port allocation and concurrent registry ownership
 * with temporary files, real loopback sockets, and a poisoned-path subprocess
 * that proves shared-server reuse without launching Vite.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  allocatePortsForWorktree,
  createEmptyRegistry,
  normalizeWorktreePath,
  portsForUiPort,
  preferredUiPortForWorktree,
  readRegistry,
  reservePortsForWorktree,
  updateRegistryEntry,
  writeRegistry,
} from "./dev-server-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const devSharedScript = path.join(here, "dev-shared.mjs");

function makeRegistryPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-dev-registry-"));
  t.after(() =>
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }),
  );
  return path.join(dir, "registry.json");
}

async function listenOnLoopback(port = 0) {
  const server = net.createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function findFreePort() {
  const server = await listenOnLoopback();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await closeServer(server);
  return address.port;
}

async function listenWithNextPortFree() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = await listenOnLoopback();
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    if (address.port >= 65_535) {
      await closeServer(server);
      continue;
    }
    try {
      const nextServer = await listenOnLoopback(address.port + 1);
      await closeServer(nextServer);
      return server;
    } catch {
      await closeServer(server);
    }
  }
  throw new Error("Could not find adjacent loopback ports for the test");
}

function worktreePreferring(baseDir, targetPort, { base, span }) {
  for (let index = 0; index < 100; index += 1) {
    const candidate = path.join(baseDir, `worktree-${index}`);
    if (preferredUiPortForWorktree(candidate, { base, span }) === targetPort) {
      return candidate;
    }
  }
  throw new Error(`Could not find a worktree preferring port ${targetPort}`);
}

function registryEntry(worktreePath, uiPort, patch = {}) {
  const worktree = normalizeWorktreePath(worktreePath);
  const ports = portsForUiPort(uiPort);
  return {
    worktree,
    packageDir: path.join(worktree, "packages", "app"),
    uiPort: ports.uiPort,
    apiPort: ports.apiPort,
    preferredUiPort: ports.uiPort,
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastRebuildAt: null,
    ...patch,
  };
}

async function runNode(scriptPath, { env, timeoutMs = 3_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(
          new Error(
            `Timed out waiting for ${path.basename(scriptPath)}\n${stdout}${stderr}`,
          ),
        ),
      );
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) =>
      finish(() => resolve({ code, signal, stdout, stderr })),
    );
  });
}

describe("shared dev server registry", () => {
  it("allocates stable deterministic ports for a worktree", () => {
    const worktree = "/tmp/eliza-workers/wt-alpha";
    const first = allocatePortsForWorktree(worktree, {
      registry: createEmptyRegistry(),
    }).entry;
    const second = allocatePortsForWorktree(worktree, {
      registry: createEmptyRegistry(),
    }).entry;

    assert.equal(first.uiPort, second.uiPort);
    assert.equal(first.apiPort, first.uiPort + 10_000);
    assert.equal(first.preferredUiPort, preferredUiPortForWorktree(worktree));
  });

  it("keeps two occupied worktrees on distinct ports", () => {
    const alpha = allocatePortsForWorktree("/tmp/eliza-workers/wt-alpha", {
      registry: createEmptyRegistry(),
    });
    alpha.entry.pid = process.pid;
    const beta = allocatePortsForWorktree("/tmp/eliza-workers/wt-beta", {
      registry: alpha.registry,
    });

    assert.notEqual(alpha.entry.uiPort, beta.entry.uiPort);
    assert.notEqual(alpha.entry.apiPort, beta.entry.apiPort);
  });

  it("linear-probes when two worktree hashes prefer the same small range", () => {
    const first = allocatePortsForWorktree("/tmp/a", {
      registry: createEmptyRegistry(),
      base: 2400,
      span: 1,
    });
    first.entry.pid = process.pid;

    assert.throws(
      () =>
        allocatePortsForWorktree("/tmp/b", {
          registry: first.registry,
          base: 2400,
          span: 1,
        }),
      /No free deterministic UI ports/,
    );
  });

  it("writes reservations through the lock-protected registry", async (t) => {
    const registryPath = makeRegistryPath(t);

    const alpha = await reservePortsForWorktree("/tmp/eliza-workers/wt-alpha", {
      registryPath,
    });
    const beta = await reservePortsForWorktree("/tmp/eliza-workers/wt-beta", {
      registryPath,
    });
    const registry = readRegistry(registryPath);

    assert.equal(alpha.reused, false);
    assert.equal(beta.reused, false);
    assert.equal(registry.entries.length, 2);
    assert.notEqual(alpha.entry.uiPort, beta.entry.uiPort);
  });

  it("reuses an established same-worktree server without rewriting it", async (t) => {
    const registryPath = makeRegistryPath(t);
    const server = await listenOnLoopback();
    t.after(() => closeServer(server));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const worktree = path.join(path.dirname(registryPath), "worktree");
    const existing = registryEntry(worktree, address.port);
    writeRegistry({ version: 1, entries: [existing] }, registryPath);
    const before = fs.readFileSync(registryPath, "utf8");

    const reservation = await reservePortsForWorktree(worktree, {
      registryPath,
      base: address.port,
      span: 1,
    });

    assert.equal(reservation.reused, true);
    assert.deepEqual(reservation.entry, existing);
    assert.equal(fs.readFileSync(registryPath, "utf8"), before);
  });

  it("does not reuse a stale reservation from its live PID alone", async (t) => {
    const registryPath = makeRegistryPath(t);
    const base = await findFreePort();
    const worktree = path.join(path.dirname(registryPath), "worktree");
    const existing = registryEntry(worktree, base, {
      reservationId: "stale-reservation",
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    writeRegistry({ version: 1, entries: [existing] }, registryPath);

    const reservation = await reservePortsForWorktree(worktree, {
      registryPath,
      base,
      span: 1,
    });

    assert.equal(reservation.reused, false);
    assert.equal(reservation.entry.uiPort, base);
    assert.notEqual(reservation.entry.reservationId, existing.reservationId);
  });

  it("does not reuse a stale reservation from its open port alone", async (t) => {
    const registryPath = makeRegistryPath(t);
    const server = await listenWithNextPortFree();
    t.after(() => closeServer(server));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = address.port;
    const span = 2;
    const worktree = worktreePreferring(
      path.dirname(registryPath),
      address.port,
      { base, span },
    );
    const existing = registryEntry(worktree, address.port, {
      pid: null,
      reservationId: "stale-reservation",
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    writeRegistry({ version: 1, entries: [existing] }, registryPath);

    const reservation = await reservePortsForWorktree(worktree, {
      registryPath,
      base,
      span,
    });

    assert.equal(reservation.reused, false);
    assert.equal(reservation.entry.uiPort, address.port + 1);
    assert.notEqual(reservation.entry.reservationId, existing.reservationId);
  });

  it("gives concurrent same-worktree starters one fresh reservation", async (t) => {
    const registryPath = makeRegistryPath(t);
    const base = await findFreePort();
    const worktree = path.join(path.dirname(registryPath), "worktree");

    const reservations = await Promise.all([
      reservePortsForWorktree(worktree, { registryPath, base, span: 1 }),
      reservePortsForWorktree(worktree, { registryPath, base, span: 1 }),
    ]);

    assert.deepEqual(reservations.map(({ reused }) => reused).sort(), [
      false,
      true,
    ]);
    assert.equal(reservations[0].entry.uiPort, reservations[1].entry.uiPort);
    const registry = readRegistry(registryPath);
    assert.equal(registry.entries.length, 1);
    assert.equal(registry.entries[0].pid, process.pid);
    assert.ok(registry.entries[0].reservationId);
    assert.equal(
      reservations[0].entry.reservationId,
      reservations[1].entry.reservationId,
    );
    assert.ok(registry.entries[0].startedAt);
  });

  it("reclaims dead same-worktree reservations", async (t) => {
    const registryPath = makeRegistryPath(t);
    const base = await findFreePort();
    const worktree = path.join(path.dirname(registryPath), "worktree");
    const child = spawn(process.execPath, ["-e", ""]);
    const deadPid = child.pid;
    assert.ok(deadPid);
    await once(child, "exit");
    writeRegistry(
      {
        version: 1,
        entries: [registryEntry(worktree, base, { pid: deadPid })],
      },
      registryPath,
    );

    const reservation = await reservePortsForWorktree(worktree, {
      registryPath,
      base,
      span: 1,
    });

    assert.equal(reservation.reused, false);
    assert.equal(reservation.entry.uiPort, base);
    assert.equal(reservation.entry.pid, process.pid);
  });

  it("reclaims explicitly stopped same-worktree reservations", async (t) => {
    const registryPath = makeRegistryPath(t);
    const base = await findFreePort();
    const worktree = path.join(path.dirname(registryPath), "worktree");
    writeRegistry(
      {
        version: 1,
        entries: [
          registryEntry(worktree, base, {
            stoppedAt: "2026-01-01T00:01:00.000Z",
          }),
        ],
      },
      registryPath,
    );

    const reservation = await reservePortsForWorktree(worktree, {
      registryPath,
      base,
      span: 1,
    });

    assert.equal(reservation.reused, false);
    assert.equal(reservation.entry.uiPort, base);
    assert.equal(reservation.entry.stoppedAt, undefined);
  });

  it("linear-probes to the next port for a distinct worktree collision", () => {
    const registry = createEmptyRegistry();
    const base = 2400;
    const span = 2;
    const alpha = "/tmp/eliza-workers/alpha";
    const preferred = preferredUiPortForWorktree(alpha, { base, span });
    let beta;
    for (let index = 0; index < 100; index += 1) {
      const candidate = `/tmp/eliza-workers/beta-${index}`;
      if (preferredUiPortForWorktree(candidate, { base, span }) === preferred) {
        beta = candidate;
        break;
      }
    }
    assert.ok(beta);
    const first = allocatePortsForWorktree(alpha, { registry, base, span });
    first.entry.pid = process.pid;

    const second = allocatePortsForWorktree(beta, {
      registry: first.registry,
      base,
      span,
    });

    assert.equal(first.entry.uiPort, preferred);
    assert.notEqual(second.entry.uiPort, preferred);
    assert.equal(second.registry.entries.length, 2);
  });

  it("does not let a stale owner update a replacement reservation", async (t) => {
    const registryPath = makeRegistryPath(t);
    const base = await findFreePort();
    const worktree = path.join(path.dirname(registryPath), "worktree");
    const original = await reservePortsForWorktree(worktree, {
      registryPath,
      base,
      span: 1,
    });
    assert.equal(original.reused, false);
    assert.ok(original.entry.reservationId);
    const replacement = registryEntry(worktree, base, {
      reservationId: "replacement-reservation",
    });
    writeRegistry({ version: 1, entries: [replacement] }, registryPath);

    const updated = await updateRegistryEntry(
      worktree,
      { pid: null, stoppedAt: "2026-01-01T00:02:00.000Z" },
      {
        registryPath,
        expectedReservationId: original.entry.reservationId,
      },
    );

    assert.equal(updated, null);
    assert.deepEqual(readRegistry(registryPath).entries, [replacement]);
  });

  it("dev:shared exits without resolving Vite when it reuses a server", async (t) => {
    const registryPath = makeRegistryPath(t);
    const server = await listenOnLoopback();
    t.after(() => closeServer(server));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const existing = registryEntry(repoRoot, address.port);
    writeRegistry({ version: 1, entries: [existing] }, registryPath);
    const before = fs.readFileSync(registryPath, "utf8");

    const result = await runNode(devSharedScript, {
      env: {
        ELIZA_DEV_SERVER_REGISTRY: registryPath,
        ELIZA_NODE_PATH: path.join(
          path.dirname(registryPath),
          "must-not-exist",
        ),
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.match(
      result.stdout,
      /reusing existing server; Vite was not started/,
    );
    assert.match(
      result.stdout,
      new RegExp(`ui=http://127\\.0\\.0\\.1:${address.port}`),
    );
    assert.equal(fs.readFileSync(registryPath, "utf8"), before);
  });
});
