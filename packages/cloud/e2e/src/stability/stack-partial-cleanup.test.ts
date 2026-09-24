/** Proves a failed canonical stack boot closes its owned process and temporary state. */

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  trackOwnedReadiness,
  waitForOwnedReadiness,
} from "../fixtures/owned-readiness.ts";
import { reserveStackPort } from "../fixtures/port-reservation.ts";
import { startCloudStack } from "../fixtures/stack.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const absent = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", absent);
    socket.once("timeout", absent);
  });
}

async function occupyPortIfFree(port: number): Promise<Server | undefined> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return server;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EADDRINUSE"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("foreign HTTP success cannot replace a fresh child readiness announcement", async () => {
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ healthy: true }),
  });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const announced = trackOwnedReadiness(child);
  const url = `http://127.0.0.1:${foreign.port}`;
  try {
    expect((await fetch(`${url}/api/health`)).status).toBe(200);
    expect(child.exitCode).toBeNull();
    await expect(
      waitForOwnedReadiness(child, announced, url, 150),
    ).rejects.toThrow("did not announce");
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    foreign.stop(true);
  }
});

test("readiness accepts only the current child's exact announced URL", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    process.stdout.write("[wrangler:info] Ready on http://127.0.0.1:12345\\n");
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const announced = trackOwnedReadiness(child);
  try {
    await waitForOwnedReadiness(
      child,
      announced,
      "http://127.0.0.1:12345",
      2000,
    );
    expect(announced("http://127.0.0.1:1234")).toBe(false);
    expect(announced("http://127.0.0.1:12345")).toBe(true);
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
});

test("stack reservations exclude competing listeners until handoff", async () => {
  const reservation = await reserveStackPort();
  let replacement: Server | undefined;
  try {
    expect(await occupyPortIfFree(reservation.port)).toBeUndefined();
    await expect(reserveStackPort(reservation.port)).rejects.toHaveProperty(
      "code",
      "EADDRINUSE",
    );
    await Promise.all([reservation.release(), reservation.release()]);
    replacement = await occupyPortIfFree(reservation.port);
    expect(replacement).toBeDefined();
  } finally {
    await reservation.release();
    await closeServer(replacement);
  }
});

test("an unrelated HTTP server cannot satisfy stack API readiness", async () => {
  const foreignServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ healthy: true }),
  });
  const logDir = await mkdtemp(path.join(tmpdir(), "cloud-stack-foreign-"));
  try {
    await expect(
      startCloudStack({
        apiPort: foreignServer.port,
        logDir,
        frontend: false,
        skipMigrate: true,
      }),
    ).rejects.toHaveProperty("code", "EADDRINUSE");
    expect(
      (await fetch(`http://127.0.0.1:${foreignServer.port}/api/health`)).status,
    ).toBe(200);
  } finally {
    foreignServer.stop(true);
    await rm(logDir, { recursive: true, force: true });
  }
});

test("partial startup failure removes PGlite process and data directory", async () => {
  const logDir = await mkdtemp(path.join(tmpdir(), "cloud-stack-cleanup-"));
  const port = await freePort();
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    await expect(
      startCloudStack({
        frontend: false,
        pglitePort: port,
        logDir,
        testFailAfterPgliteStart: true,
      }),
    ).rejects.toThrow(/injected Cloud stack startup failure/);
    const log = await readFile(path.join(logDir, "pglite.log"), "utf8");
    const dataPath = log.match(/\(data: ([^)]+)\)/)?.[1];
    expect(dataPath).toBeDefined();
    for (
      let attempt = 0;
      attempt < 20 && (await portAcceptsConnections(port));
      attempt += 1
    ) {
      await Bun.sleep(25);
    }
    expect(await portAcceptsConnections(port)).toBe(false);
    await expect(access(path.dirname(dataPath as string))).rejects.toThrow();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await rm(logDir, { recursive: true, force: true });
  }
}, 10_000);

test("stack assigns Wrangler an inspector port instead of fixed 9229", async () => {
  const logDir = await mkdtemp(path.join(tmpdir(), "cloud-stack-inspector-"));
  const legacyInspectorBlocker = await occupyPortIfFree(9229);
  const inspectorPort = await freePort();
  let stack: Awaited<ReturnType<typeof startCloudStack>> | undefined;
  try {
    expect(await portAcceptsConnections(9229)).toBe(true);
    stack = await startCloudStack({
      frontend: false,
      inspectorPort,
      logDir,
      skipMigrate: true,
    });
    expect(await portAcceptsConnections(inspectorPort)).toBe(true);
    expect(await fetch(`${stack.urls.api}/api/health`)).toHaveProperty(
      "status",
      200,
    );
  } finally {
    await stack?.stop();
    await closeServer(legacyInspectorBlocker);
    await rm(logDir, { recursive: true, force: true });
  }
}, 180_000);
