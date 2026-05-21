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

export type FirstPartyRemotePluginKind = "required" | "recommended" | "dev";

export interface FirstPartyRemotePluginDefinition {
  id: string;
  displayName: string;
  sourceDir: string;
  kind: FirstPartyRemotePluginKind;
  autoStart: boolean;
}

export interface FirstPartyRemotePluginSeedResult {
  id: string;
  displayName: string;
  sourceDir: string;
  kind: FirstPartyRemotePluginKind;
  autoStart: boolean;
  disabled: boolean;
  hash: string;
  action: "installed" | "updated" | "unchanged" | "skipped";
  autoStarted: boolean;
}

interface FirstPartyRemotePluginState {
  version: 1;
  disabled: Record<string, boolean>;
}

const platformRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const remotePluginsRoot = path.join(platformRoot, "remotePlugins");
const stateFileName = "first-party-remotes.json";
const skippedHashEntries = new Set([
  ".DS_Store",
  ".git",
  "dist",
  "node_modules",
]);

export const FIRST_PARTY_REMOTE_PLUGINS: FirstPartyRemotePluginDefinition[] = [
  {
    id: "eliza.runtime",
    displayName: "Eliza Runtime RemotePlugin",
    sourceDir: path.join(remotePluginsRoot, "runtime"),
    kind: "required",
    autoStart: true,
  },
  {
    id: "eliza.fs",
    displayName: "Eliza File RemotePlugin",
    sourceDir: path.join(remotePluginsRoot, "fs"),
    kind: "recommended",
    autoStart: true,
  },
  {
    id: "eliza.local-model",
    displayName: "Eliza Model RemotePlugin",
    sourceDir: path.join(remotePluginsRoot, "local-model"),
    kind: "recommended",
    autoStart: true,
  },
  {
    id: "eliza.pty",
    displayName: "Eliza Terminal RemotePlugin",
    sourceDir: path.join(remotePluginsRoot, "pty"),
    kind: "recommended",
    autoStart: false,
  },
  {
    id: "eliza.git",
    displayName: "Eliza Git RemotePlugin",
    sourceDir: path.join(remotePluginsRoot, "git"),
    kind: "recommended",
    autoStart: false,
  },
  {
    id: "eliza.surface",
    displayName: "Eliza Surface RemotePlugin",
    sourceDir: path.join(remotePluginsRoot, "surface"),
    kind: "dev",
    autoStart: false,
  },
];

export function getFirstPartyRemotePluginDefinitions(options?: {
  includeDev?: boolean;
}): FirstPartyRemotePluginDefinition[] {
  const includeDev =
    options?.includeDev ?? process.env.ELIZA_ENABLE_DEV_REMOTE_PLUGINS === "1";
  return FIRST_PARTY_REMOTE_PLUGINS.filter(
    (definition) => includeDev || definition.kind !== "dev",
  );
}

export function setFirstPartyRemotePluginDisabled(
  id: string,
  disabled: boolean,
  manager: RemotePluginHost = getRemotePluginHost(),
): void {
  const state = readFirstPartyRemotePluginState(manager);
  if (disabled) {
    state.disabled[id] = true;
  } else {
    delete state.disabled[id];
  }
  writeFirstPartyRemotePluginState(manager, state);
}

export function isFirstPartyRemotePluginDisabled(
  id: string,
  manager: RemotePluginHost = getRemotePluginHost(),
): boolean {
  return readFirstPartyRemotePluginState(manager).disabled[id] === true;
}

export function seedFirstPartyRemotePlugins(options?: {
  manager?: RemotePluginHost;
  includeDev?: boolean;
  startAutoStart?: boolean;
}): FirstPartyRemotePluginSeedResult[] {
  const manager = options?.manager ?? getRemotePluginHost();
  const startAutoStart = options?.startAutoStart ?? true;
  const results: FirstPartyRemotePluginSeedResult[] = [];

  for (const definition of getFirstPartyRemotePluginDefinitions({
    includeDev: options?.includeDev,
  })) {
    const manifest = assertRemotePluginPayload(definition.sourceDir);
    if (manifest.id !== definition.id) {
      throw new Error(
        `First-party RemotePlugin id mismatch: registry=${definition.id} manifest=${manifest.id}`,
      );
    }

    const hash = hashDirectory(definition.sourceDir);
    const existing = manager.getRemotePlugin(definition.id);
    let action: FirstPartyRemotePluginSeedResult["action"] = "unchanged";
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

    const disabled = isFirstPartyRemotePluginDisabled(definition.id, manager);
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

export function seedFirstPartyRemotePluginsForStartup(): void {
  try {
    const results = seedFirstPartyRemotePlugins();
    logger.info("[FirstPartyRemotePlugins] seed complete", {
      results: results.map((result) => ({
        id: result.id,
        action: result.action,
        autoStarted: result.autoStarted,
        disabled: result.disabled,
      })),
    });
  } catch (error) {
    logger.warn(
      "[FirstPartyRemotePlugins] seed failed",
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { error: String(error) },
    );
  }
}

function readFirstPartyRemotePluginState(
  manager: RemotePluginHost,
): FirstPartyRemotePluginState {
  const statePath = firstPartyRemotePluginStatePath(manager);
  if (!fs.existsSync(statePath)) return { version: 1, disabled: {} };
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
  if (!isFirstPartyRemotePluginState(parsed)) {
    return { version: 1, disabled: {} };
  }
  return parsed;
}

function writeFirstPartyRemotePluginState(
  manager: RemotePluginHost,
  state: FirstPartyRemotePluginState,
): void {
  const statePath = firstPartyRemotePluginStatePath(manager);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function firstPartyRemotePluginStatePath(manager: RemotePluginHost): string {
  return path.join(manager.getStoreRoot(), stateFileName);
}

function isFirstPartyRemotePluginState(
  value: unknown,
): value is FirstPartyRemotePluginState {
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
