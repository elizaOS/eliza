import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  flattenCarrotPermissions,
  normalizeCarrotPermissions,
} from "./permissions.js";
import type {
  BunPermission,
  CarrotInstallRecord,
  CarrotInstallSource,
  CarrotIsolation,
  CarrotManifest,
  CarrotPermissionGrant,
  CarrotRegistry,
  HostPermission,
  JsonObject,
  JsonValue,
} from "./types.js";
import {
  BUN_PERMISSIONS,
  CARROT_ISOLATIONS,
  HOST_PERMISSIONS,
} from "./types.js";
import { validateCarrotManifest } from "./validation.js";

const REGISTRY_FILE_NAME = "registry.json";
const INSTALL_FILE_NAME = "install.json";
const REGISTRY_VERSION = 1;

export interface InstalledCarrot {
  install: CarrotInstallRecord;
  manifest: CarrotManifest;
  rootDir: string;
  currentDir: string;
  stateDir: string;
  extractionDir: string;
  installPath: string;
  bundleWorkerPath: string;
  workerPath: string;
  viewPath: string;
  viewUrl: string;
}

export interface CarrotStorePaths {
  rootDir: string;
  currentDir: string;
  stateDir: string;
  extractionDir: string;
  installPath: string;
}

export interface InstallPrebuiltCarrotOptions {
  permissionsGranted?: CarrotPermissionGrant;
  source?: CarrotInstallSource;
  currentHash?: string | null;
  devMode?: boolean;
  lastBuildAt?: number | null;
  now?: () => number;
}

export class CarrotStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarrotStoreError";
  }
}

function parseJsonFile(filePath: string): JsonValue {
  return JSON.parse(readFileSync(filePath, "utf8")) as JsonValue;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function ensureStoreRoot(storeRoot: string): void {
  mkdirSync(storeRoot, { recursive: true });
}

function stringField(object: JsonObject, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CarrotStoreError(`Invalid ${path}.${key}: expected string.`);
  }
  return value;
}

function numberField(object: JsonObject, key: string, path: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CarrotStoreError(`Invalid ${path}.${key}: expected number.`);
  }
  return value;
}

function optionalBooleanField(
  object: JsonObject,
  key: string,
  path: string,
): boolean | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new CarrotStoreError(`Invalid ${path}.${key}: expected boolean.`);
  }
  return value;
}

function nullableStringField(
  object: JsonObject,
  key: string,
  path: string,
): string | null {
  const value = object[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new CarrotStoreError(
      `Invalid ${path}.${key}: expected string or null.`,
    );
  }
  return value;
}

function optionalNullableStringField(
  object: JsonObject,
  key: string,
  path: string,
): string | null | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new CarrotStoreError(
      `Invalid ${path}.${key}: expected string or null.`,
    );
  }
  return value;
}

function parseOptionalNumberOrNull(
  value: JsonValue | undefined,
  path: string,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CarrotStoreError(`Invalid ${path}: expected number or null.`);
  }
  return value;
}

function parseBooleanRecord<K extends string>(
  value: JsonValue | undefined,
  path: string,
  allowed: readonly K[],
): Partial<Record<K, boolean>> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    throw new CarrotStoreError(`Invalid ${path}: expected object.`);
  }
  const output: Partial<Record<K, boolean>> = {};
  for (const [key, entry] of Object.entries(value)) {
    const permission = allowed.find((allowedKey) => allowedKey === key);
    if (!permission) {
      throw new CarrotStoreError(`Invalid ${path}.${key}: unknown permission.`);
    }
    if (typeof entry !== "boolean") {
      throw new CarrotStoreError(`Invalid ${path}.${key}: expected boolean.`);
    }
    output[permission] = entry;
  }
  return output;
}

function isCarrotIsolation(value: string): value is CarrotIsolation {
  return CARROT_ISOLATIONS.some((entry) => entry === value);
}

function parsePermissionGrant(
  value: JsonValue | undefined,
  path: string,
): CarrotPermissionGrant {
  if (!isJsonObject(value)) {
    throw new CarrotStoreError(`Invalid ${path}: expected object.`);
  }
  const grant: CarrotPermissionGrant = {};
  const host = parseBooleanRecord<HostPermission>(
    value.host,
    `${path}.host`,
    HOST_PERMISSIONS,
  );
  const bun = parseBooleanRecord<BunPermission>(
    value.bun,
    `${path}.bun`,
    BUN_PERMISSIONS,
  );
  if (host) grant.host = host;
  if (bun) grant.bun = bun;
  const isolation = value.isolation;
  if (isolation === undefined) {
    grant.isolation = "shared-worker";
  } else if (typeof isolation === "string" && isCarrotIsolation(isolation)) {
    grant.isolation = isolation;
  } else {
    throw new CarrotStoreError(
      `Invalid ${path}.isolation: expected shared-worker or isolated-process.`,
    );
  }
  return grant;
}

function parseInstallSource(
  value: JsonValue | undefined,
  path: string,
  fallbackHashValue: JsonValue | undefined,
): CarrotInstallSource {
  if (!isJsonObject(value)) {
    throw new CarrotStoreError(`Invalid ${path}: expected object.`);
  }
  const kind = value.kind;
  if (kind === "prototype") {
    return {
      kind,
      prototypeId: stringField(value, "prototypeId", path),
      bundledViewFolder: stringField(value, "bundledViewFolder", path),
    };
  }
  if (kind === "local") {
    return {
      kind,
      path: stringField(value, "path", path),
    };
  }
  if (kind === "artifact") {
    const fallbackHash =
      typeof fallbackHashValue === "string" ? fallbackHashValue : null;
    return {
      kind,
      location: stringField(value, "location", path),
      updateLocation: nullableStringField(value, "updateLocation", path),
      tarballLocation: nullableStringField(value, "tarballLocation", path),
      currentHash:
        nullableStringField(value, "currentHash", path) ?? fallbackHash,
      baseUrl: nullableStringField(value, "baseUrl", path),
    };
  }
  throw new CarrotStoreError(`Invalid ${path}.kind.`);
}

function registryPath(storeRoot: string): string {
  return join(storeRoot, REGISTRY_FILE_NAME);
}

function normalizeInstallSource(
  source: CarrotInstallSource,
  fallbackHash: string | null,
): CarrotInstallSource {
  if (source.kind !== "artifact") return source;
  return {
    kind: "artifact",
    location: source.location,
    updateLocation: source.updateLocation ?? null,
    tarballLocation: source.tarballLocation ?? null,
    currentHash: source.currentHash ?? fallbackHash,
    baseUrl: source.baseUrl ?? null,
  };
}

function normalizeInstallRecord(
  record: CarrotInstallRecord,
): CarrotInstallRecord {
  return {
    ...record,
    source: normalizeInstallSource(record.source, record.currentHash),
    permissionsGranted: normalizeCarrotPermissions(record.permissionsGranted),
    devMode: record.devMode ?? false,
    lastBuildAt: record.lastBuildAt ?? null,
    lastBuildError: record.lastBuildError ?? null,
  };
}

function parseInstallRecord(
  value: JsonValue,
  filePath: string,
): CarrotInstallRecord {
  if (!isJsonObject(value)) {
    throw new CarrotStoreError(
      `Invalid install record at ${filePath}: expected object.`,
    );
  }
  const status = value.status;
  if (status !== "installed" && status !== "broken") {
    throw new CarrotStoreError(
      `Invalid install record at ${filePath}: bad status.`,
    );
  }
  return normalizeInstallRecord({
    id: stringField(value, "id", "install"),
    name: stringField(value, "name", "install"),
    version: stringField(value, "version", "install"),
    currentHash: nullableStringField(value, "currentHash", "install"),
    installedAt: numberField(value, "installedAt", "install"),
    updatedAt: numberField(value, "updatedAt", "install"),
    permissionsGranted: parsePermissionGrant(
      value.permissionsGranted,
      "install.permissionsGranted",
    ),
    devMode: optionalBooleanField(value, "devMode", "install"),
    lastBuildAt: parseOptionalNumberOrNull(
      value.lastBuildAt,
      "install.lastBuildAt",
    ),
    lastBuildError: optionalNullableStringField(
      value,
      "lastBuildError",
      "install",
    ),
    status,
    source: parseInstallSource(
      value.source,
      "install.source",
      value.currentHash,
    ),
  });
}

function parseRegistry(value: JsonValue): CarrotRegistry {
  if (!isJsonObject(value)) {
    throw new CarrotStoreError("Invalid carrot registry: expected object.");
  }
  if (value.version !== REGISTRY_VERSION || !isJsonObject(value.carrots)) {
    throw new CarrotStoreError("Invalid carrot registry.");
  }
  const carrots: Record<string, CarrotInstallRecord> = {};
  for (const [id, record] of Object.entries(value.carrots)) {
    carrots[id] = parseInstallRecord(record, `registry.carrots.${id}`);
  }
  return { version: REGISTRY_VERSION, carrots };
}

export function getCarrotStorePaths(
  storeRoot: string,
  id: string,
): CarrotStorePaths {
  const rootDir = join(storeRoot, id);
  return {
    rootDir,
    currentDir: join(rootDir, "current"),
    stateDir: join(rootDir, "data"),
    extractionDir: join(rootDir, "self-extraction"),
    installPath: join(rootDir, INSTALL_FILE_NAME),
  };
}

export function resolveCarrotPathInside(
  rootDir: string,
  relativePath: string,
): string {
  const normalizedRoot = resolve(rootDir);
  const resolvedPath = resolve(rootDir, relativePath);
  if (
    resolvedPath !== normalizedRoot &&
    !resolvedPath.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new CarrotStoreError(`Path escapes carrot root: ${relativePath}`);
  }
  return resolvedPath;
}

export function toCarrotViewUrl(relativePath: string): string {
  return `views://${relativePath.replace(/^\/+/, "")}`;
}

export function readCarrotManifestAt(manifestPath: string): CarrotManifest {
  const parsed = parseJsonFile(manifestPath);
  const result = validateCarrotManifest(parsed);
  if (!result.ok) {
    const details = result.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ");
    throw new CarrotStoreError(
      `Invalid carrot manifest at ${manifestPath}: ${details}`,
    );
  }
  return result.manifest;
}

export function assertCarrotPayload(payloadDir: string): CarrotManifest {
  const manifestPath = join(payloadDir, "carrot.json");
  if (!existsSync(manifestPath)) {
    throw new CarrotStoreError(`Missing carrot.json in ${payloadDir}`);
  }

  const manifest = readCarrotManifestAt(manifestPath);
  const workerPath = resolveCarrotPathInside(
    payloadDir,
    manifest.worker.relativePath,
  );
  if (!existsSync(workerPath)) {
    throw new CarrotStoreError(
      `Missing worker for ${manifest.id}: ${workerPath}`,
    );
  }

  const viewPath = resolveCarrotPathInside(
    payloadDir,
    manifest.view.relativePath,
  );
  if (!existsSync(viewPath)) {
    throw new CarrotStoreError(
      `Missing view entry for ${manifest.id}: ${viewPath}`,
    );
  }

  return manifest;
}

export function readCarrotRegistry(storeRoot: string): CarrotRegistry {
  ensureStoreRoot(storeRoot);
  const filePath = registryPath(storeRoot);
  if (!existsSync(filePath)) {
    return { version: REGISTRY_VERSION, carrots: {} };
  }
  return parseRegistry(parseJsonFile(filePath));
}

export function writeCarrotRegistry(
  storeRoot: string,
  registry: CarrotRegistry,
): CarrotRegistry {
  ensureStoreRoot(storeRoot);
  const normalized: CarrotRegistry = {
    version: REGISTRY_VERSION,
    carrots: {},
  };
  for (const record of Object.values(registry.carrots)) {
    normalized.carrots[record.id] = normalizeInstallRecord(record);
  }
  writeFileSync(
    registryPath(storeRoot),
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );
  return normalized;
}

export function listInstalledCarrotDirectories(storeRoot: string): string[] {
  ensureStoreRoot(storeRoot);
  return readdirSync(storeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function readCarrotInstallRecord(
  storeRoot: string,
  id: string,
): CarrotInstallRecord | null {
  const installPath = getCarrotStorePaths(storeRoot, id).installPath;
  if (!existsSync(installPath)) return null;
  return parseInstallRecord(parseJsonFile(installPath), installPath);
}

export function writeCarrotInstallRecord(
  storeRoot: string,
  record: CarrotInstallRecord,
): CarrotInstallRecord {
  const normalized = normalizeInstallRecord(record);
  const paths = getCarrotStorePaths(storeRoot, normalized.id);
  mkdirSync(paths.rootDir, { recursive: true });
  writeFileSync(
    paths.installPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );
  syncCarrotRegistry(storeRoot);
  return normalized;
}

export function writeCarrotWorkerBootstrap(
  currentDir: string,
  manifest: CarrotManifest,
  install: CarrotInstallRecord,
  bundleWorkerPath: string,
  stateDir: string,
): string {
  const bootstrapDir = join(currentDir, ".bunny");
  const bootstrapPath = join(bootstrapDir, "carrot-bun-entrypoint.mjs");
  const workerRelativePath = bundleWorkerPath
    .slice(currentDir.length + 1)
    .replaceAll(sep, "/");
  const workerImportPath = workerRelativePath.startsWith(".")
    ? workerRelativePath
    : `../${workerRelativePath}`;

  mkdirSync(bootstrapDir, { recursive: true });
  writeFileSync(
    bootstrapPath,
    [
      `globalThis.__bunnyCarrotBootstrap = ${JSON.stringify({
        manifest,
        context: {
          currentDir,
          statePath: join(stateDir, "state.json"),
          logsPath: join(stateDir, "logs.txt"),
          permissions: flattenCarrotPermissions(install.permissionsGranted),
          grantedPermissions: install.permissionsGranted,
        },
      })};`,
      `await import(${JSON.stringify(workerImportPath)});`,
      "",
    ].join("\n"),
    "utf8",
  );

  return bootstrapPath;
}

function loadInstalledCarrotRecord(
  storeRoot: string,
  record: CarrotInstallRecord,
): InstalledCarrot {
  const paths = getCarrotStorePaths(storeRoot, record.id);
  const manifest = readCarrotManifestAt(join(paths.currentDir, "carrot.json"));
  const bundleWorkerPath = resolveCarrotPathInside(
    paths.currentDir,
    manifest.worker.relativePath,
  );
  const viewPath = resolveCarrotPathInside(
    paths.currentDir,
    manifest.view.relativePath,
  );
  if (!existsSync(bundleWorkerPath)) {
    throw new CarrotStoreError(
      `Missing worker for ${record.id}: ${bundleWorkerPath}`,
    );
  }
  if (!existsSync(viewPath)) {
    throw new CarrotStoreError(
      `Missing view entry for ${record.id}: ${viewPath}`,
    );
  }

  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.extractionDir, { recursive: true });
  const workerPath = writeCarrotWorkerBootstrap(
    paths.currentDir,
    manifest,
    record,
    bundleWorkerPath,
    paths.stateDir,
  );

  return {
    install: record,
    manifest,
    ...paths,
    bundleWorkerPath,
    workerPath,
    viewPath,
    viewUrl: toCarrotViewUrl(manifest.view.relativePath),
  };
}

export function loadInstalledCarrot(
  storeRoot: string,
  id: string,
): InstalledCarrot | null {
  const record = readCarrotInstallRecord(storeRoot, id);
  return record ? loadInstalledCarrotRecord(storeRoot, record) : null;
}

export function syncCarrotRegistry(storeRoot: string): CarrotRegistry {
  const records = new Map<string, CarrotInstallRecord>();
  for (const directory of listInstalledCarrotDirectories(storeRoot)) {
    const record = readCarrotInstallRecord(storeRoot, directory);
    if (record) {
      records.set(record.id, record);
    }
  }
  const sortedRecords = Array.from(records.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return writeCarrotRegistry(storeRoot, {
    version: REGISTRY_VERSION,
    carrots: Object.fromEntries(
      sortedRecords.map((record) => [record.id, record]),
    ),
  });
}

export function loadInstalledCarrots(storeRoot: string): InstalledCarrot[] {
  const registry = syncCarrotRegistry(storeRoot);
  return Object.values(registry.carrots)
    .map((record) => loadInstalledCarrotRecord(storeRoot, record))
    .sort((left, right) =>
      left.manifest.name.localeCompare(right.manifest.name),
    );
}

export function installPrebuiltCarrot(
  storeRoot: string,
  payloadDir: string,
  options: InstallPrebuiltCarrotOptions = {},
): InstalledCarrot {
  const manifest = assertCarrotPayload(payloadDir);
  const previousInstall = readCarrotInstallRecord(storeRoot, manifest.id);
  const paths = getCarrotStorePaths(storeRoot, manifest.id);
  const now = options.now?.() ?? Date.now();

  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.extractionDir, { recursive: true });
  const tempRootDir = mkdtempSync(join(paths.rootDir, "incoming-"));
  const tempCurrentDir = join(tempRootDir, "current");

  try {
    cpSync(payloadDir, tempCurrentDir, { recursive: true, force: true });
    rmSync(paths.currentDir, { recursive: true, force: true });
    renameSync(tempCurrentDir, paths.currentDir);
  } finally {
    rmSync(tempRootDir, { recursive: true, force: true });
  }

  const installRecord = writeCarrotInstallRecord(storeRoot, {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    currentHash: options.currentHash ?? previousInstall?.currentHash ?? null,
    installedAt: previousInstall?.installedAt ?? now,
    updatedAt: now,
    permissionsGranted: normalizeCarrotPermissions(
      options.permissionsGranted ?? manifest.permissions,
    ),
    devMode: options.devMode ?? previousInstall?.devMode ?? false,
    lastBuildAt: options.lastBuildAt ?? previousInstall?.lastBuildAt ?? null,
    lastBuildError: null,
    status: "installed",
    source: options.source ?? { kind: "artifact", location: payloadDir },
  });

  return loadInstalledCarrotRecord(storeRoot, installRecord);
}

export function uninstallInstalledCarrot(
  storeRoot: string,
  id: string,
): CarrotInstallRecord | null {
  const record = readCarrotInstallRecord(storeRoot, id);
  if (!record) return null;
  rmSync(getCarrotStorePaths(storeRoot, id).rootDir, {
    recursive: true,
    force: true,
  });
  syncCarrotRegistry(storeRoot);
  return record;
}

export function isCarrotSourceDirectory(directory: string): boolean {
  return (
    existsSync(join(directory, "electrobun.config.ts")) ||
    existsSync(join(directory, "carrot.json")) ||
    existsSync(join(directory, "web")) ||
    existsSync(join(directory, "build.ts")) ||
    existsSync(join(directory, "worker.ts")) ||
    existsSync(join(directory, "src", "bun", "worker.ts"))
  );
}

export function ensureCarrotSourceDirectory(directory: string): string {
  const normalized = resolve(directory);
  if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
    throw new CarrotStoreError(`Carrot source folder not found: ${normalized}`);
  }
  if (!isCarrotSourceDirectory(normalized)) {
    throw new CarrotStoreError(
      `Selected folder does not look like a Carrot source tree: ${normalized}`,
    );
  }
  return normalized;
}
