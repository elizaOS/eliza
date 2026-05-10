/**
 * Atomic key/value writer for the on-disk `config.env` file.
 *
 * `config.env` lives under the Eliza state directory (default
 * `~/.eliza/config.env`, or whatever `ELIZA_STATE_DIR`
 * resolves to). It is an escape hatch for sensitive process-env-only
 * material (e.g. cloud-wallet client address keys, `WALLET_SOURCE_*`
 * bindings) that must not be mirrored into `eliza.json` but still needs
 * to survive restarts.
 *
 * ── Crash safety ────────────────────────────────────────────────────
 * Every write performs three on-disk steps:
 *   1. Snapshot existing contents to `config.env.bak`.
 *   2. Serialise the new contents to `config.env.tmp` and fsync.
 *   3. Rename `config.env.tmp` → `config.env` (atomic on POSIX).
 *
 * Failure modes:
 *   - Step 2 fails → no `config.env` mutation. `.bak` may exist but the
 *     live file is untouched.
 *   - Step 3 fails → `.bak` still holds the pre-image. Recover manually
 *     via `cp ~/.eliza/config.env.bak ~/.eliza/config.env` or the
 *     documented `bun run agent:repair-config` command.
 *
 * Concurrent writes in-process are serialised via a promise chain mutex.
 * Cross-process coordination is NOT provided — callers must ensure only
 * one agent runtime owns a given state dir (the PGlite postmaster lock
 * already enforces this).
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveStateDir } from "../config/paths.ts";

const CONFIG_ENV_FILENAME = "config.env";
const BAK_SUFFIX = ".bak";
const TMP_SUFFIX = ".tmp";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Keys we refuse to write even though `config.env` is the designated
 * escape hatch for sensitive process-env-only material. These are
 * shell/runtime hijack vectors — they must never be set from the
 * application layer, regardless of provenance.
 */
const BLOCKED_CONFIG_ENV_KEYS: ReadonlySet<string> = new Set([
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "PATH",
  "HOME",
  "SHELL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
]);

interface PersistOptions {
  /** Override state dir (mostly for tests). Defaults to `resolveStateDir()`. */
  stateDir?: string;
}

interface ParsedConfigEnv {
  /** Ordered list of raw lines (comments, blanks, key=value). */
  lines: string[];
  /** Map of key → index into `lines`, for in-place updates. */
  index: Map<string, number>;
}

function parseConfigEnv(contents: string): ParsedConfigEnv {
  const lines = contents.length === 0 ? [] : contents.split(/\r?\n/);
  // `split` on trailing newline produces an empty final element — drop it
  // so we don't re-emit a double blank at EOF on every rewrite.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const index = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) continue;
    // Last definition wins (standard dotenv behaviour).
    index.set(key, i);
  }
  return { lines, index };
}

function serialiseConfigEnv(parsed: ParsedConfigEnv): string {
  if (parsed.lines.length === 0) return "";
  return `${parsed.lines.join("\n")}\n`;
}

function encodeValue(value: string): string {
  // Quote values that contain whitespace, `#`, or non-printable characters,
  // and escape embedded quotes/backslashes/newlines so the file round-trips
  // through standard dotenv parsers.
  if (value === "") return "";
  const needsQuoting = /[\s#"'\\]|^\s|\s$/.test(value) || /\n|\r/.test(value);
  if (!needsQuoting) return value;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `persistConfigEnv: invalid key "${key}" — must match /^[A-Z][A-Z0-9_]*$/`,
    );
  }
  if (BLOCKED_CONFIG_ENV_KEYS.has(key)) {
    throw new Error(
      `persistConfigEnv: key "${key}" is a shell/runtime hijack vector and cannot be written`,
    );
  }
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const tmpPath = `${filePath}${TMP_SUFFIX}`;
  const handle = await fs.open(tmpPath, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, filePath);
}

// In-process serialisation. Cross-process coordination is out of scope.
let writeChain: Promise<unknown> = Promise.resolve();

function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

function resolveConfigEnvPath(stateDir?: string): string {
  const dir = stateDir ?? resolveStateDir();
  return path.join(dir, CONFIG_ENV_FILENAME);
}

/**
 * Read the on-disk `config.env` into a plain record. Does NOT touch
 * `process.env`. Missing file → empty record.
 */
export async function readConfigEnv(
  stateDir?: string,
): Promise<Record<string, string>> {
  const filePath = resolveConfigEnvPath(stateDir);
  const raw = await readIfExists(filePath);
  if (raw === null) return {};
  const parsed = parseConfigEnv(raw);
  const out: Record<string, string> = {};
  for (const [key, idx] of parsed.index) {
    const line = parsed.lines[idx] ?? "";
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const rawValue = line.slice(eq + 1);
    out[key] = decodeValue(rawValue);
  }
  return out;
}

/**
 * Synchronous variant for early startup paths such as `loadElizaConfig()`.
 * Missing file → empty record. Does NOT touch `process.env`.
 */
export function readConfigEnvSync(stateDir?: string): Record<string, string> {
  const filePath = resolveConfigEnvPath(stateDir);
  let raw: string;
  try {
    raw = fsSync.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }

  const parsed = parseConfigEnv(raw);
  const out: Record<string, string> = {};
  for (const [key, idx] of parsed.index) {
    const line = parsed.lines[idx] ?? "";
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[key] = decodeValue(line.slice(eq + 1));
  }
  return out;
}

function decodeValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const first = trimmed[0];
  if (
    (first === '"' || first === "'") &&
    trimmed.endsWith(first) &&
    trimmed.length >= 2
  ) {
    const inner = trimmed.slice(1, -1);
    if (first === '"') {
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return inner;
  }
  return trimmed;
}

/**
 * Atomically write `key=value` into `config.env`, preserving all other
 * entries, comments, and blank lines. Also updates `process.env[key]` so
 * the in-flight process observes the new value immediately.
 *
 * Pass empty string to delete the key. Missing file → created with 0600.
 *
 * @throws if `key` is malformed or in the hijack-vector blocklist.
 */
export async function persistConfigEnv(
  key: string,
  value: string,
  opts: PersistOptions = {},
): Promise<void> {
  validateKey(key);

  await serialise(async () => {
    const filePath = resolveConfigEnvPath(opts.stateDir);
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const existing = (await readIfExists(filePath)) ?? "";
    const parsed = parseConfigEnv(existing);

    const isDelete = value === "";
    const existingIdx = parsed.index.get(key);

    if (isDelete) {
      if (existingIdx === undefined) {
        // Nothing to do — don't write a .bak for a no-op.
        if (key in process.env) delete process.env[key];
        return;
      }
      parsed.lines.splice(existingIdx, 1);
      // Indices after removal are stale, but we're done mutating — no
      // further lookups happen in this call.
    } else {
      const encoded = `${key}=${encodeValue(value)}`;
      if (existingIdx === undefined) {
        parsed.lines.push(encoded);
      } else {
        parsed.lines[existingIdx] = encoded;
      }
    }

    const nextContents = serialiseConfigEnv(parsed);

    // Snapshot pre-image for manual recovery before touching the live file.
    if (existing.length > 0) {
      await fs.writeFile(`${filePath}${BAK_SUFFIX}`, existing, {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    await writeAtomic(filePath, nextContents);

    if (isDelete) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
}

/** Exposed for tests and recovery tooling. */
export const __testing = {
  BLOCKED_CONFIG_ENV_KEYS,
  CONFIG_ENV_FILENAME,
  BAK_SUFFIX,
  TMP_SUFFIX,
  parseConfigEnv,
  serialiseConfigEnv,
};
