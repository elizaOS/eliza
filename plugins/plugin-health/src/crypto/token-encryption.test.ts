/**
 * Preserves connector ciphertext and key-file compatibility with real crypto,
 * temporary files, Node workers, and child processes. Missing-file barriers
 * and delayed real writes exercise atomic publication; teardown reaps every
 * participant even when readiness or publication fails.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptTokenEnvelope,
  type EncryptedTokenEnvelope,
  encryptTokenPayload,
  resolveTokenEncryptionKey,
} from "./token-encryption.js";

const KEY = Buffer.alloc(32, 7);
const LEGACY_ENVELOPE = {
  __enc: "aes-256-gcm" as const,
  v: 1 as const,
  iv: "AAECAwQFBgcICQoL",
  tag: "M8rZ1OYoJsWd/+uvKkWHzg==",
  ct: "dOSOEX5w9D9G",
};
const raceChildPath = fileURLToPath(
  new URL("./fixtures/token-encryption-race-child.ts", import.meta.url),
);

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

type ChildOutcome =
  | {
      kind: "closed";
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }
  | { kind: "spawn-error"; error: Error };
interface Participant {
  child: ChildProcess;
  outcome: Promise<ChildOutcome>;
}

function startParticipant(dir: string, id: number, mode = "race"): Participant {
  const child = spawn("bun", [raceChildPath, dir, String(id), mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const outcome = new Promise<ChildOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ kind: "spawn-error", error }));
    child.on("close", (code, signal) =>
      resolve({ kind: "closed", code, signal, stdout, stderr }),
    );
  });
  return { child, outcome };
}

async function stopParticipants(participants: Participant[]): Promise<void> {
  for (const { child } of participants) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  await Promise.all(participants.map(({ outcome }) => outcome));
}

async function successfulKey(participant: Participant): Promise<string> {
  const outcome = await participant.outcome;
  if (outcome.kind === "spawn-error") throw outcome.error;
  if (outcome.code !== 0) {
    throw new Error(
      `Key participant exited ${outcome.code}/${outcome.signal}: ${outcome.stderr}`,
    );
  }
  return outcome.stdout;
}

async function waitForFiles(
  dir: string,
  names: string[],
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (names.every((name) => fs.existsSync(path.join(dir, name)))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for key-creation participants: ${names.join(", ")}`,
  );
}

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
      expect.objectContaining({
        code: "TOKEN_ENCRYPTION_KEY_UNAVAILABLE",
        cause: expect.objectContaining({
          name: "Error",
          message: expect.stringContaining("exactly 32 bytes"),
        }),
      }),
    );
    expect(fs.readFileSync(keyPath, "utf8")).toBe("broken-key");
    expect(fs.readdirSync(directory)).toEqual([".encryption-key"]);
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

describe("connector token encryption compatibility", () => {
  it("decrypts the exact v1 AES-256-GCM envelope emitted by legacy plugins", () => {
    expect(decryptTokenEnvelope(LEGACY_ENVELOPE, KEY)).toBe("legacy-v1");
  });

  it("emits the unchanged discriminator/version and round-trips plaintext", () => {
    const envelope = encryptTokenPayload("current", KEY);
    expect({ algorithm: envelope.__enc, version: envelope.v }).toEqual({
      algorithm: "aes-256-gcm",
      version: 1,
    });
    expect(decryptTokenEnvelope(envelope, KEY)).toBe("current");
  });

  it("returns the exclusive-create winner's key to every concurrent process", async () => {
    const dir = freshDirectory();
    const participants = Array.from({ length: 16 }, (_, id) =>
      startParticipant(dir, id),
    );
    try {
      await waitForFiles(
        dir,
        participants.map((_, id) => `ready-${id}`),
      );
      fs.writeFileSync(path.join(dir, "start"), "go");
      const keys = await Promise.all(participants.map(successfulKey));
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toHaveLength(64);
      expect(
        fs.readFileSync(path.join(dir, ".encryption-key"), "utf8").trim(),
      ).toBe(Buffer.from(keys[0], "hex").toString("base64"));
      expect(fs.statSync(path.join(dir, ".encryption-key")).mode & 0o777).toBe(
        0o600,
      );
      expect(
        fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      await stopParticipants(participants);
    }
  }, 30_000);

  it("never exposes an incomplete key while a competing creator is paused before its write", async () => {
    const dir = freshDirectory();
    const paused = startParticipant(dir, 0, "hold-write");
    try {
      await waitForFiles(dir, ["paused"]);
      const winner = resolveTokenEncryptionKey(dir, {});
      const envelope = encryptTokenPayload("concurrent credential", winner);
      fs.writeFileSync(path.join(dir, "release"), "continue");
      const delayedKey = Buffer.from(await successfulKey(paused), "hex");
      expect(decryptTokenEnvelope(envelope, delayedKey)).toBe(
        "concurrent credential",
      );
      expect(delayedKey.equals(winner)).toBe(true);
      expect(resolveTokenEncryptionKey(dir, {}).equals(winner)).toBe(true);
      expect(fs.readdirSync(dir).sort()).toEqual([
        ".encryption-key",
        "paused",
        "release",
      ]);
    } finally {
      fs.writeFileSync(path.join(dir, "release"), "continue");
      await stopParticipants([paused]);
    }
  }, 30_000);

  it("cleans its candidate when a competing publication contains an invalid key", async () => {
    const dir = freshDirectory();
    const paused = startParticipant(dir, 0, "hold-write");
    try {
      await waitForFiles(dir, ["paused"]);
      const file = path.join(dir, ".encryption-key");
      fs.writeFileSync(file, "invalid-key", { flag: "wx", mode: 0o600 });
      fs.writeFileSync(path.join(dir, "release"), "continue");
      const outcome = await paused.outcome;
      if (outcome.kind !== "closed") throw outcome.error;
      expect(outcome.code).toBe(1);
      expect(outcome.signal).toBeNull();
      const failure: unknown = JSON.parse(outcome.stderr);
      expect(failure).toMatchObject({
        phase: "resolve-token-encryption-key",
        code: "TOKEN_ENCRYPTION_KEY_UNAVAILABLE",
        cause: {
          name: "Error",
          message: expect.stringContaining("exactly 32 bytes"),
        },
      });
      expect(fs.readFileSync(file, "utf8")).toBe("invalid-key");
      expect(fs.readdirSync(dir).sort()).toEqual([
        ".encryption-key",
        "paused",
        "release",
      ]);
    } finally {
      fs.writeFileSync(path.join(dir, "release"), "continue");
      await stopParticipants([paused]);
    }
  }, 30_000);

  it("reaps a real participant when readiness times out", async () => {
    const dir = freshDirectory();
    const participant = startParticipant(dir, 0, "no-ready");
    try {
      await expect(waitForFiles(dir, ["never-ready"], 50)).rejects.toThrow(
        /Timed out/,
      );
    } finally {
      await stopParticipants([participant]);
    }
    const outcome = await participant.outcome;
    expect(outcome.kind).toBe("closed");
    if (outcome.kind !== "closed") throw outcome.error;
    expect(outcome.signal).toBe("SIGKILL");
  });
});
