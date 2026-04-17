/**
 * Model-file integrity verification.
 *
 * GGUF files are large (0.8 – 20 GB). Corrupted files surface as cryptic
 * llama.cpp errors much later, so we verify at install time and expose a
 * manual verify button for users who want to re-check after a system
 * event (crash, disk fill, external tool edited the file, etc).
 *
 * We don't require SHA256 from HuggingFace — HF doesn't publish per-file
 * hashes in the standard API, and hand-curating them in the catalog would
 * drift. Instead, after a successful download we compute the SHA256
 * ourselves and stash it on the InstalledModel. Re-verify compares the
 * file's current hash against the stashed one. A mismatch means the file
 * changed on disk since we installed it — user can redownload.
 *
 * For GGUF specifically we also do a cheap structural header check
 * (the file starts with the magic bytes "GGUF") so obvious truncations
 * flag instantly without having to hash a 10GB file.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { registryPath } from "./paths";
import type { InstalledModel } from "./types";

export type VerifyState =
  | "unknown"
  | "ok"
  | "mismatch"
  | "missing"
  | "truncated";

export interface VerifyResult {
  state: VerifyState;
  /** SHA256 hex of the file as it exists now. Absent when file missing. */
  currentSha256: string | null;
  /** Hash from the registry, when available. */
  expectedSha256: string | null;
  /** Size read from the filesystem. */
  currentBytes: number | null;
}

const GGUF_MAGIC = Buffer.from("GGUF", "ascii");

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function isGgufHeader(path: string): Promise<boolean> {
  try {
    const fd = await fsp.open(path, "r");
    try {
      const buf = Buffer.alloc(4);
      await fd.read(buf, 0, 4, 0);
      return buf.equals(GGUF_MAGIC);
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

export async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hasher = createHash("sha256");
    const stream = fs.createReadStream(path, { highWaterMark: 1 << 20 });
    stream.on("data", (chunk: Buffer | string) => {
      hasher.update(chunk);
    });
    stream.on("end", () => resolve(hasher.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Run the full verification pipeline on a model. Returns the state and
 * the freshly computed hash so the caller can persist it to the registry.
 */
export async function verifyInstalledModel(
  model: InstalledModel,
): Promise<VerifyResult> {
  if (!(await fileExists(model.path))) {
    return {
      state: "missing",
      currentSha256: null,
      expectedSha256: model.sha256 ?? null,
      currentBytes: null,
    };
  }
  const stat = await fsp.stat(model.path);
  if (!(await isGgufHeader(model.path))) {
    return {
      state: "truncated",
      currentSha256: null,
      expectedSha256: model.sha256 ?? null,
      currentBytes: stat.size,
    };
  }
  const currentSha256 = await hashFile(model.path);
  if (!model.sha256) {
    // First-time verification — no baseline to compare against. Caller
    // decides whether to treat this as "ok" and persist the hash.
    return {
      state: "unknown",
      currentSha256,
      expectedSha256: null,
      currentBytes: stat.size,
    };
  }
  return {
    state: currentSha256 === model.sha256 ? "ok" : "mismatch",
    currentSha256,
    expectedSha256: model.sha256,
    currentBytes: stat.size,
  };
}

/** Helper for tests — no runtime use. */
export function __registryPathForTests(): string {
  return registryPath();
}
