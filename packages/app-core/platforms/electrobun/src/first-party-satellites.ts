import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRemotePluginPayload } from "@elizaos/plugin-remote-manifest";
import { logger } from "./logger";
import {
  type RemotePluginHost,
  getRemotePluginHost,
} from "./native/remote-plugin-host";

export type FirstPartySatelliteKind = "required" | "recommended" | "dev";

export interface FirstPartySatelliteDefinition {
  id: string;
  displayName: string;
  sourceDir: string;
  kind: FirstPartySatelliteKind;
  autoStart: boolean;
}

export interface FirstPartySatelliteSeedResult {
  id: string;
  displayName: string;
  sourceDir: string;
  kind: FirstPartySatelliteKind;
  autoStart: boolean;
  disabled: boolean;
  hash: string;
  action: "installed" | "updated" | "unchanged" | "skipped";
  autoStarted: boolean;
}

interface FirstPartySatelliteState {
  version: 1;
  disabled: Record<string, boolean>;
}

const platformRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const satellitesRoot = path.join(platformRoot, "satellites");
const stateFileName = "first-party-satellites.json";
const skippedHashEntries = new Set([
  ".DS_Store",
  ".git",
  "dist",
  "node_modules",
]);

export const FIRST_PARTY_SATELLITES: FirstPartySatelliteDefinition[] = [
  {
    id: "eliza.runtime",
    displayName: "Eliza Runtime Satellite",
    sourceDir: path.join(satellitesRoot, "runtime"),
    kind: "required",
    autoStart: true,
  },
  {
    id: "eliza.fs",
    displayName: "Eliza File Satellite",
    sourceDir: path.join(satellitesRoot, "fs"),
    kind: "recommended",
    autoStart: true,
  },
  {
    id: "eliza.local-model",
    displayName: "Eliza Model Satellite",
    sourceDir: path.join(satellitesRoot, "local-model"),
    kind: "recommended",
    autoStart: true,
  },
  {
    id: "eliza.pty",
    displayName: "Eliza Terminal Satellite",
    sourceDir: path.join(satellitesRoot, "pty"),
    kind: "recommended",
    autoStart: false,
  },
  {
    id: "eliza.git",
    displayName: "Eliza Git Satellite",
    sourceDir: path.join(satellitesRoot, "git"),
    kind: "recommended",
    autoStart: false,
  },
  {
    id: "eliza.surface",
    displayName: "Eliza Surface Satellite",
    sourceDir: path.join(satellitesRoot, "surface"),
    kind: "dev",
    autoStart: false,
  },
];

export function getFirstPartySatelliteDefinitions(options?: {
  includeDev?: boolean;
}): FirstPartySatelliteDefinition[] {
  const includeDev =
    options?.includeDev ?? process.env.ELIZA_ENABLE_DEV_SATELLITES === "1";
  return FIRST_PARTY_SATELLITES.filter(
    (definition) => includeDev || definition.kind !== "dev",
  );
}

export function setFirstPartySatelliteDisabled(
  id: string,
  disabled: boolean,
  manager: RemotePluginHost = getRemotePluginHost(),
): void {
  const state = readFirstPartySatelliteState(manager);
  if (disabled) {
    state.disabled[id] = true;
  } else {
    delete state.disabled[id];
  }
  writeFirstPartySatelliteState(manager, state);
}

export function isFirstPartySatelliteDisabled(
  id: string,
  manager: RemotePluginHost = getRemotePluginHost(),
): boolean {
  return readFirstPartySatelliteState(manager).disabled[id] === true;
}

export function seedFirstPartySatellites(options?: {
  manager?: RemotePluginHost;
  includeDev?: boolean;
  startAutoStart?: boolean;
}): FirstPartySatelliteSeedResult[] {
  const manager = options?.manager ?? getRemotePluginHost();
  const startAutoStart = options?.startAutoStart ?? true;
  const results: FirstPartySatelliteSeedResult[] = [];

  for (const definition of getFirstPartySatelliteDefinitions({
    includeDev: options?.includeDev,
  })) {
    const manifest = assertRemotePluginPayload(definition.sourceDir);
    if (manifest.id !== definition.id) {
      throw new Error(
        `First-party Satellite id mismatch: registry=${definition.id} manifest=${manifest.id}`,
      );
    }

    const hash = hashDirectory(definition.sourceDir);
    const existing = manager.getRemotePlugin(definition.id);
    let action: FirstPartySatelliteSeedResult["action"] = "unchanged";
    if (!existing) {
      manager.installFromDirectory({
        sourceDir: definition.sourceDir,
        devMode: definition.kind === "dev",
        currentHash: hash,
      });
      action = "installed";
    } else if (existing.currentHash !== hash) {
      manager.installFromDirectory({
        sourceDir: definition.sourceDir,
        devMode: definition.kind === "dev",
        currentHash: hash,
      });
      action = "updated";
    }

    const disabled = isFirstPartySatelliteDisabled(definition.id, manager);
    let autoStarted = false;
    if (definition.autoStart && startAutoStart && !disabled) {
      manager.startWorker(definition.id);
      autoStarted = true;
    }

    results.push({
      ...definition,
      disabled,
      hash,
      action,
      autoStarted,
    });
  }

  return results;
}

export function seedFirstPartySatellitesForStartup(): void {
  try {
    const results = seedFirstPartySatellites();
    logger.info("[FirstPartySatellites] seed complete", {
      results: results.map((result) => ({
        id: result.id,
        action: result.action,
        autoStarted: result.autoStarted,
        disabled: result.disabled,
      })),
    });
  } catch (error) {
    logger.warn(
      "[FirstPartySatellites] seed failed",
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { error: String(error) },
    );
  }
}

function readFirstPartySatelliteState(
  manager: RemotePluginHost,
): FirstPartySatelliteState {
  const statePath = firstPartySatelliteStatePath(manager);
  if (!fs.existsSync(statePath)) return { version: 1, disabled: {} };
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
  if (!isFirstPartySatelliteState(parsed)) {
    return { version: 1, disabled: {} };
  }
  return parsed;
}

function writeFirstPartySatelliteState(
  manager: RemotePluginHost,
  state: FirstPartySatelliteState,
): void {
  const statePath = firstPartySatelliteStatePath(manager);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function firstPartySatelliteStatePath(manager: RemotePluginHost): string {
  return path.join(manager.getStoreRoot(), stateFileName);
}

function isFirstPartySatelliteState(
  value: unknown,
): value is FirstPartySatelliteState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  const disabled = record.disabled;
  return (
    typeof disabled === "object" &&
    disabled !== null &&
    !Array.isArray(disabled)
  );
}

function hashDirectory(directory: string): string {
  const hasher = crypto.createHash("sha256");
  for (const filePath of listHashableFiles(directory)) {
    const relativePath = path
      .relative(directory, filePath)
      .replaceAll(path.sep, "/");
    hasher.update(relativePath);
    hasher.update("\0");
    hasher.update(fs.readFileSync(filePath));
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

function listHashableFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skippedHashEntries.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listHashableFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}
