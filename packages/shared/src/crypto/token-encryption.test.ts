/**
 * Verifies persisted connector keys with real files, crypto, and concurrent
 * Node workers. A barrier after observing a missing key forces the first-use
 * race without replacing the key loader or filesystem writes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptTokenEnvelope,
  type EncryptedTokenEnvelope,
  encryptTokenPayload,
  resolveTokenEncryptionKey,
} from "./token-encryption.js";

const directories: string[] = [];
function freshDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "connector-key-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const workerSource = `
import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
const { resolveTokenEncryptionKey, encryptTokenPayload } = await import(workerData.moduleUrl);
const barrier = new Int32Array(workerData.barrier);
let synchronized = false;
function rendezvous(file) {
  if (synchronized || String(file) !== workerData.keyPath) return;
  synchronized = true;
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  const deadline = Date.now() + 30_000;
  while (Atomics.load(barrier, 0) < workerData.count) {
    if (Date.now() >= deadline) throw new Error("Concurrent key writers did not rendezvous");
    Atomics.wait(barrier, 0, Atomics.load(barrier, 0), 100);
  }
}
const exists = fs.existsSync;
fs.existsSync = (file) => {
  const present = exists(file);
  if (!present) rendezvous(file);
  return present;
};
const read = fs.readFileSync;
fs.readFileSync = (...args) => {
  try { return read(...args); }
  catch (error) {
    // error-policy:J2 preserve the real missing-file result after synchronization.
    if (error.code === "ENOENT") rendezvous(args[0]);
    throw error;
  }
};
const key = resolveTokenEncryptionKey(workerData.directory, {});
parentPort.postMessage(encryptTokenPayload("synthetic connector token", key));
`;

describe("connector key publication", () => {
  it("keeps every concurrent first-write token decryptable after reloading the persisted key", async () => {
    const directory = freshDirectory();
    const count = 4;
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workers = Array.from(
      { length: count },
      () =>
        new Worker(
          new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`),
          {
            workerData: {
              moduleUrl: new URL("./token-encryption.ts", import.meta.url).href,
              directory,
              keyPath: path.join(directory, ".encryption-key"),
              barrier,
              count,
            },
          },
        ),
    );
    try {
      const envelopes = await Promise.all(
        workers.map(
          (worker) =>
            new Promise<EncryptedTokenEnvelope>((resolve, reject) => {
              worker.once("message", resolve);
              worker.once("error", reject);
              worker.once("exit", (code) => {
                if (code !== 0) reject(new Error(`Key writer exited ${code}`));
              });
            }),
        ),
      );
      const persistedKey = resolveTokenEncryptionKey(directory, {});
      for (const envelope of envelopes) {
        expect(decryptTokenEnvelope(envelope, persistedKey)).toBe(
          "synthetic connector token",
        );
      }
      expect(fs.readdirSync(directory)).toEqual([".encryption-key"]);
      if (process.platform !== "win32") {
        expect(
          fs.statSync(path.join(directory, ".encryption-key")).mode & 0o777,
        ).toBe(0o600);
      }
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }, 90_000);

  it("preserves existing key bytes and decrypts tokens written with that key", () => {
    const directory = freshDirectory();
    const key = Buffer.alloc(32, 9);
    const original = `${key.toString("base64")}\n`;
    const keyPath = path.join(directory, ".encryption-key");
    fs.writeFileSync(keyPath, original, { mode: 0o600 });
    const envelope = encryptTokenPayload("existing token", key);
    expect(
      decryptTokenEnvelope(envelope, resolveTokenEncryptionKey(directory, {})),
    ).toBe("existing token");
    expect(fs.readFileSync(keyPath, "utf8")).toBe(original);
  });

  it("rejects malformed persisted keys without replacing their bytes", () => {
    const directory = freshDirectory();
    const keyPath = path.join(directory, ".encryption-key");
    fs.writeFileSync(keyPath, "broken-key");
    expect(() => resolveTokenEncryptionKey(directory, {})).toThrowError(
      expect.objectContaining({ code: "TOKEN_ENCRYPTION_KEY_UNAVAILABLE" }),
    );
    expect(fs.readFileSync(keyPath, "utf8")).toBe("broken-key");
  });

  it("keeps configured keys authoritative without repairing an invalid key file", () => {
    const directory = freshDirectory();
    const keyPath = path.join(directory, ".encryption-key");
    fs.writeFileSync(keyPath, "broken-key");
    const key = Buffer.alloc(32, 7);
    expect(
      resolveTokenEncryptionKey(directory, {
        ELIZA_TOKEN_ENCRYPTION_KEY: key.toString("hex"),
      }),
    ).toEqual(key);
    expect(fs.readFileSync(keyPath, "utf8")).toBe("broken-key");
  });

  it("rejects an unreadable key target before returning usable key material", () => {
    const directory = freshDirectory();
    fs.mkdirSync(path.join(directory, ".encryption-key"));
    expect(() => resolveTokenEncryptionKey(directory, {})).toThrowError(
      expect.objectContaining({ code: "TOKEN_ENCRYPTION_KEY_UNAVAILABLE" }),
    );
  });
});
