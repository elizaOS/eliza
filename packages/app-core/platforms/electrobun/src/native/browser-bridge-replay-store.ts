/** Persists consumed native-enrollment nonces across broker and app restarts. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "./auth-bridge";
import {
  BrowserBridgeNativeProtocolError,
  NATIVE_MESSAGE_CLOCK_SKEW_MS,
  NativeEnrollmentReplayGuard,
} from "./browser-bridge-native-protocol";

interface ReplayStoreDocument {
  version: 1;
  entries: Array<{ digest: string; expiresAt: number }>;
}

export function resolveBrowserBridgeReplayStorePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    resolveStateDir(env),
    "browser-bridge",
    "enrollment-replay.json",
  );
}

function parseReplayStore(value: string): ReplayStoreDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    // error-policy:J2 corrupt security state must fail closed with a typed protocol error.
    throw new BrowserBridgeNativeProtocolError(
      "replay_store_corrupt",
      `native enrollment replay store is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "replay_store_corrupt",
      "native enrollment replay store has an invalid schema",
    );
  }
  const entries = (parsed as ReplayStoreDocument).entries;
  if (
    entries.some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.digest) ||
        typeof entry.expiresAt !== "number" ||
        !Number.isSafeInteger(entry.expiresAt),
    )
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "replay_store_corrupt",
      "native enrollment replay store contains an invalid entry",
    );
  }
  return { version: 1, entries };
}

function readReplayStore(filePath: string): ReplayStoreDocument {
  if (!fs.existsSync(filePath)) return { version: 1, entries: [] };
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new BrowserBridgeNativeProtocolError(
      "replay_store_unsafe",
      "native enrollment replay store must be a regular file",
    );
  }
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
    throw new BrowserBridgeNativeProtocolError(
      "replay_store_unsafe",
      "native enrollment replay store must use mode 0600",
    );
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new BrowserBridgeNativeProtocolError(
      "replay_store_unsafe",
      "native enrollment replay store is not owned by the current user",
    );
  }
  return parseReplayStore(fs.readFileSync(filePath, "utf8"));
}

function ensureReplayStoreDirectory(filePath: string): string {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    (process.platform !== "win32" &&
      ((directoryStat.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === "function" &&
          directoryStat.uid !== process.getuid())))
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "replay_store_unsafe",
      "native enrollment replay directory must be a real directory",
    );
  }
  return directory;
}

function atomicWriteReplayStore(
  filePath: string,
  document: ReplayStoreDocument,
): void {
  ensureReplayStoreDirectory(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(document), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
  } catch (error) {
    // error-policy:J2 clean the private temporary file before preserving persistence failure.
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      // error-policy:J2 a failed cleanup is preserved alongside the write failure.
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AggregateError(
          [error, cleanupError],
          "native enrollment replay store write and cleanup failed",
        );
      }
    }
    throw error;
  }
}

export class PersistentNativeEnrollmentReplayGuard extends NativeEnrollmentReplayGuard {
  /**
   * Consumption is synchronous and the Electrobun desktop is single-instance;
   * desktop lifecycle wiring shares one guard across both native brokers.
   */
  constructor(
    private readonly filePath: string,
    private readonly digestKey: Uint8Array,
    private readonly storeTtlMs = NATIVE_MESSAGE_CLOCK_SKEW_MS * 2,
    private readonly storeCapacity = 4096,
  ) {
    super(storeTtlMs, storeCapacity);
    if (digestKey.byteLength < 32) {
      throw new BrowserBridgeNativeProtocolError(
        "weak_broker_secret",
        "replay digest key must contain at least 32 bytes",
      );
    }
  }

  override consume(nonce: string, nowMs: number): void {
    const digest = crypto
      .createHmac("sha256", this.digestKey)
      .update(nonce, "utf8")
      .digest("hex");
    const document = readReplayStore(this.filePath);
    const entries = document.entries.filter((entry) => entry.expiresAt > nowMs);
    if (entries.some((entry) => entry.digest === digest)) {
      throw new BrowserBridgeNativeProtocolError(
        "replayed_nonce",
        "native enrollment nonce has already been used",
      );
    }
    if (entries.length >= this.storeCapacity) {
      throw new BrowserBridgeNativeProtocolError(
        "replay_capacity_exceeded",
        "native enrollment replay window is full",
      );
    }
    entries.push({ digest, expiresAt: nowMs + this.storeTtlMs });
    atomicWriteReplayStore(this.filePath, { version: 1, entries });
  }
}
