/** Proves a failed canonical stack boot closes its owned process and temporary state. */

import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
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
