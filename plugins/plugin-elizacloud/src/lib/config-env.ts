import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "./state-paths";

const CONFIG_ENV_FILENAME = "config.env";
const BAK_SUFFIX = ".bak";
const TMP_SUFFIX = ".tmp";
const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

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

export interface PersistConfigEnvOptions {
  stateDir?: string;
}

interface ParsedConfigEnv {
  lines: string[];
  index: Map<string, number>;
}

function parseConfigEnv(contents: string): ParsedConfigEnv {
  const lines = contents.length === 0 ? [] : contents.split(/\r?\n/);
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
    if (KEY_PATTERN.test(key)) index.set(key, i);
  }
  return { lines, index };
}

function serialiseConfigEnv(parsed: ParsedConfigEnv): string {
  return parsed.lines.length === 0 ? "" : `${parsed.lines.join("\n")}\n`;
}

function encodeValue(value: string): string {
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
      `persistConfigEnv: invalid key "${key}" - must match /^[A-Z][A-Z0-9_]*$/`,
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
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

let writeChain: Promise<unknown> = Promise.resolve();

function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

function resolveConfigEnvPath(stateDir?: string): string {
  return path.join(stateDir ?? resolveStateDir(), CONFIG_ENV_FILENAME);
}

export async function persistConfigEnv(
  key: string,
  value: string,
  opts: PersistConfigEnvOptions = {},
): Promise<void> {
  validateKey(key);

  await serialise(async () => {
    const filePath = resolveConfigEnvPath(opts.stateDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const existing = (await readIfExists(filePath)) ?? "";
    const parsed = parseConfigEnv(existing);
    const existingIdx = parsed.index.get(key);
    const isDelete = value === "";

    if (isDelete) {
      if (existingIdx === undefined) {
        delete process.env[key];
        return;
      }
      parsed.lines.splice(existingIdx, 1);
    } else {
      const encoded = `${key}=${encodeValue(value)}`;
      if (existingIdx === undefined) {
        parsed.lines.push(encoded);
      } else {
        parsed.lines[existingIdx] = encoded;
      }
    }

    if (existing.length > 0) {
      await fs.writeFile(`${filePath}${BAK_SUFFIX}`, existing, {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    await writeAtomic(filePath, serialiseConfigEnv(parsed));
    if (isDelete) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
}
