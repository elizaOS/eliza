/** Exercises the real Unix-socket proof used by desktop session bootstrap. */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consumeDesktopSocketProof } from "./desktop-auth-bootstrap-routes";

const createdPaths: string[] = [];

afterEach(() => {
  for (const socketPath of createdPaths.splice(0)) {
    try {
      fs.unlinkSync(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
});

async function openProofSocket(options?: {
  bytes?: number;
  mode?: number;
  name?: string;
}): Promise<{ path: string; close: () => Promise<void> }> {
  const socketPath = path.join(
    os.tmpdir(),
    options?.name ?? `mda-${crypto.randomBytes(4).toString("hex")}.sock`,
  );
  createdPaths.push(socketPath);
  const server = net.createServer((connection) => {
    connection.end(crypto.randomBytes(options?.bytes ?? 32));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, options?.mode ?? 0o600);
  return {
    path: socketPath,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("consumeDesktopSocketProof", () => {
  it("accepts one owner-only socket yielding the exact proof length", async () => {
    const socket = await openProofSocket();
    expect(await consumeDesktopSocketProof(socket.path)).toBe(true);
    await socket.close();
  });

  it("rejects a permissive socket before connecting", async () => {
    const socket = await openProofSocket({ mode: 0o666 });
    expect(await consumeDesktopSocketProof(socket.path)).toBe(false);
    await socket.close();
  });

  it("rejects unexpected socket names and malformed proof lengths", async () => {
    const wrongName = await openProofSocket({ name: "untrusted.sock" });
    expect(await consumeDesktopSocketProof(wrongName.path)).toBe(false);
    await wrongName.close();

    const shortProof = await openProofSocket({ bytes: 16 });
    expect(await consumeDesktopSocketProof(shortProof.path)).toBe(false);
    await shortProof.close();
  });
});
