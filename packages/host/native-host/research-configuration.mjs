import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { acquireExclusiveDatabaseLease } from "./database-lease.mjs";
import { NativeHostError } from "./errors.mjs";

function privatePath(path, directory = false) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new NativeHostError(
      "Research configuration and database directory must be owner-only",
    );
}
function syncDirectory(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function readResearchConfiguration(path) {
  if (!path || !isAbsolute(path))
    throw new NativeHostError(
      "An absolute private research configuration path is required",
    );
  privatePath(path);
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new NativeHostError("Invalid private research configuration JSON");
  }
  if (
    !config ||
    !isAbsolute(config.databasePath || "") ||
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535 ||
    typeof config.encryptionKey !== "string" ||
    Buffer.from(config.encryptionKey, "base64").length !== 32
  )
    throw new NativeHostError("Invalid research configuration");
  privatePath(dirname(config.databasePath), true);
  return config;
}
/** Host selects study retention, capacity, operator identity and bind port. No enrollment. */
export function initializeResearchConfiguration({
  directory,
  port,
  retentionMs,
  maxEvents,
  operatorName,
  databaseName,
}) {
  if (
    !isAbsolute(directory || "") ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !Number.isSafeInteger(retentionMs) ||
    retentionMs < 60000 ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 10 ||
    maxEvents > 1000000 ||
    typeof operatorName !== "string" ||
    !/^[A-Za-z0-9_.-]+$/.test(operatorName) ||
    typeof databaseName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(databaseName)
  )
    throw new NativeHostError(
      "Explicit research storage and operator settings are required",
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privatePath(directory, true);
  const tokenPath = join(directory, "operator-token"),
    configPath = join(directory, "config.json");
  const token = randomBytes(32).toString("hex");
  const config = {
    port,
    databasePath: join(directory, databaseName),
    encryptionKey: randomBytes(32).toString("base64"),
    retentionMs,
    maxEvents,
    operators: [
      {
        name: operatorName,
        role: "admin",
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      },
    ],
  };
  const created = [];
  try {
    writeFileSync(tokenPath, `${token}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    created.push(tokenPath);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    created.push(configPath);
    syncDirectory(directory);
  } catch (error) {
    for (const path of created.reverse()) unlinkSync(path);
    throw error;
  }
  return { configPath, tokenPath };
}
/** Offline transaction with recovery files retained even when database rotation fails. */
export function rotateResearchConfiguration({ path, openStore, actor }) {
  if (
    typeof openStore !== "function" ||
    actor?.role !== "admin" ||
    typeof actor.name !== "string" ||
    !actor.name
  )
    throw new NativeHostError(
      "Explicit research store and admin identity are required",
    );
  const config = readResearchConfiguration(path),
    release = acquireExclusiveDatabaseLease(config.databasePath);
  let store;
  try {
    const nextKey = randomBytes(32),
      next = { ...config, encryptionKey: nextKey.toString("base64") };
    writeFileSync(
      `${path}.rotation-previous`,
      `${JSON.stringify(config, null, 2)}\n`,
      { flag: "wx", mode: 0o600, flush: true },
    );
    writeFileSync(
      `${path}.rotation-next`,
      `${JSON.stringify(next, null, 2)}\n`,
      { flag: "wx", mode: 0o600, flush: true },
    );
    syncDirectory(dirname(path));
    store = openStore({
      path: config.databasePath,
      key: Buffer.from(config.encryptionKey, "base64"),
      retentionMs: config.retentionMs,
      maxEvents: config.maxEvents,
    });
    store.rotateKey(actor, nextKey);
    store.close();
    store = null;
    renameSync(`${path}.rotation-next`, path);
    syncDirectory(dirname(path));
    return { configPath: path, recoveryPath: `${path}.rotation-previous` };
  } finally {
    try {
      store?.close();
    } finally {
      release();
    }
  }
}
