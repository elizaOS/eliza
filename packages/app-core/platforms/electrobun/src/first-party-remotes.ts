import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRemotePluginPayload } from "@elizaos/plugin-remote-manifest";
import { logger } from "./logger";
import {
  getRemotePluginHost,
  type RemotePluginHost,
} from "./native/remote-plugin-host";

export type FirstPartyRemoteKind = "required" | "recommended" | "dev";

export interface FirstPartyRemoteDefinition {
  id: string;
  displayName: string;
  sourceDir: string;
  kind: FirstPartyRemoteKind;
  autoStart: boolean;
}

export interface FirstPartyRemoteSeedResult {
  id: string;
  displayName: string;
  sourceDir: string;
  kind: FirstPartyRemoteKind;
  autoStart: boolean;
  disabled: boolean;
  hash: string;
  action: "installed" | "updated" | "unchanged" | "skipped";
  autoStarted: boolean;
}

interface FirstPartyRemoteState {
  version: 1;
  disabled: Record<string, boolean>;
}

const platformRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const remotesRoot = path.join(platformRoot, "remotes");
const stateFileName = "first-party-remotes.json";
const skippedHashEntries = new Set([
  ".DS_Store",
  ".git",
  "dist",
  "node_modules",
]);

export const FIRST_PARTY_REMOTES: FirstPartyRemoteDefinition[] = [
  {
    id: "eliza.runtime",
    displayName: "Eliza Runtime Remote",
    sourceDir: path.join(remotesRoot, "runtime"),
    kind: "required",
    autoStart: true,
  },
  {
    id: "eliza.fs",
    displayName: "Eliza File Remote",
    sourceDir: path.join(remotesRoot, "fs"),
    kind: "recommended",
    autoStart: true,
  },
  {
    id: "eliza.local-model",
    displayName: "Eliza Model Remote",
    sourceDir: path.join(remotesRoot, "local-model"),
    kind: "recommended",
    autoStart: true,
  },
  {
    id: "eliza.pty",
    displayName: "Eliza Terminal Remote",
    sourceDir: path.join(remotesRoot, "pty"),
    kind: "recommended",
    autoStart: false,
  },
  {
    id: "eliza.git",
    displayName: "Eliza Git Remote",
    sourceDir: path.join(remotesRoot, "git"),
    kind: "recommended",
    autoStart: false,
  },
  {
    id: "eliza.surface",
    displayName: "Eliza Surface Remote",
    sourceDir: path.join(remotesRoot, "surface"),
    kind: "dev",
    autoStart: false,
  },
];

export function getFirstPartyRemoteDefinitions(options?: {
  includeDev?: boolean;
}): FirstPartyRemoteDefinition[] {
  const includeDev =
    options?.includeDev ?? process.env.ELIZA_ENABLE_DEV_REMOTES === "1";
  return FIRST_PARTY_REMOTES.filter(
    (definition) => includeDev || definition.kind !== "dev",
  );
}

export function setFirstPartyRemoteDisabled(
  id: string,
  disabled: boolean,
  manager: RemotePluginHost = getRemotePluginHost(),
): void {
  const state = readFirstPartyRemoteState(manager);
  if (disabled) {
    state.disabled[id] = true;
  } else {
    delete state.disabled[id];
  }
  writeFirstPartyRemoteState(manager, state);
}

export function isFirstPartyRemoteDisabled(
  id: string,
  manager: RemotePluginHost = getRemotePluginHost(),
): boolean {
  return readFirstPartyRemoteState(manager).disabled[id] === true;
}

export function seedFirstPartyRemotes(options?: {
  manager?: RemotePluginHost;
  includeDev?: boolean;
  startAutoStart?: boolean;
}): FirstPartyRemoteSeedResult[] {
  const manager = options?.manager ?? getRemotePluginHost();
  const startAutoStart = options?.startAutoStart ?? true;
  const results: FirstPartyRemoteSeedResult[] = [];

  for (const definition of getFirstPartyRemoteDefinitions({
    includeDev: options?.includeDev,
  })) {
    const manifest = assertRemotePluginPayload(definition.sourceDir);
    if (manifest.id !== definition.id) {
      throw new Error(
        `First-party Remote id mismatch: registry=${definition.id} manifest=${manifest.id}`,
      );
    }

    const hash = hashDirectory(definition.sourceDir);
    const existing = manager.getRemotePlugin(definition.id);
    let action: FirstPartyRemoteSeedResult["action"] = "unchanged";
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

    const disabled = isFirstPartyRemoteDisabled(definition.id, manager);
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

export function seedFirstPartyRemotesForStartup(): void {
  try {
    const results = seedFirstPartyRemotes();
    logger.info("[FirstPartyRemotes] seed complete", {
      results: results.map((result) => ({
        id: result.id,
        action: result.action,
        autoStarted: result.autoStarted,
        disabled: result.disabled,
      })),
    });
  } catch (error) {
    logger.warn(
      "[FirstPartyRemotes] seed failed",
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { error: String(error) },
    );
  }
}

function readFirstPartyRemoteState(
  manager: RemotePluginHost,
): FirstPartyRemoteState {
  const statePath = firstPartyRemoteStatePath(manager);
  if (!fs.existsSync(statePath)) return { version: 1, disabled: {} };
  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
  if (!isFirstPartyRemoteState(parsed)) {
    return { version: 1, disabled: {} };
  }
  return parsed;
}

function writeFirstPartyRemoteState(
  manager: RemotePluginHost,
  state: FirstPartyRemoteState,
): void {
  const statePath = firstPartyRemoteStatePath(manager);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function firstPartyRemoteStatePath(manager: RemotePluginHost): string {
  return path.join(manager.getStoreRoot(), stateFileName);
}

function isFirstPartyRemoteState(
  value: unknown,
): value is FirstPartyRemoteState {
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
