/**
 * On-disk registry of installed models.
 *
 * Two sources feed the registry:
 *   1. Milady-owned downloads (source: "milady-download") — written on
 *      successful completion by the downloader.
 *   2. External scans (source: "external-scan") — merged in at read time
 *      from `scanExternalModels()`. These are never persisted to the
 *      registry file; a rescan runs whenever we read.
 *
 * The JSON file only holds Milady-owned entries. That way, if a user
 * cleans up LM Studio models we don't show stale ghosts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { scanExternalModels } from "./external-scanner";
import { isWithinMiladyRoot, localInferenceRoot, registryPath } from "./paths";
import type { InstalledModel } from "./types";

interface RegistryFile {
  version: 1;
  models: InstalledModel[];
}

async function ensureRootDir(): Promise<void> {
  await fs.mkdir(localInferenceRoot(), { recursive: true });
}

async function readMiladyOwned(): Promise<InstalledModel[]> {
  try {
    const raw = await fs.readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as RegistryFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.models)) {
      return [];
    }
    return parsed.models.filter(
      (m): m is InstalledModel =>
        m && typeof m === "object" && m.source === "milady-download",
    );
  } catch {
    return [];
  }
}

async function writeMiladyOwned(models: InstalledModel[]): Promise<void> {
  await ensureRootDir();
  const tmp = `${registryPath()}.tmp`;
  const payload: RegistryFile = { version: 1, models };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, registryPath());
}

/**
 * Return all models currently usable: persisted Milady downloads plus a
 * fresh external-tool scan. External duplicates of Milady-owned files are
 * filtered out by path.
 */
export async function listInstalledModels(): Promise<InstalledModel[]> {
  const [owned, external] = await Promise.all([
    readMiladyOwned(),
    scanExternalModels(),
  ]);

  // Filter out Milady-owned files that also survived a reboot of the local
  // file and got re-detected by the scanner.
  const ownedPaths = new Set(owned.map((m) => path.resolve(m.path)));
  const dedupedExternal = external.filter(
    (m) => !ownedPaths.has(path.resolve(m.path)),
  );

  return [...owned, ...dedupedExternal];
}

/** Add or update a Milady-owned entry. External entries are rejected. */
export async function upsertMiladyModel(model: InstalledModel): Promise<void> {
  if (model.source !== "milady-download") {
    throw new Error(
      "[local-inference] registry only accepts Milady-owned models",
    );
  }
  if (!isWithinMiladyRoot(model.path)) {
    throw new Error(
      "[local-inference] Milady-owned models must live under the local-inference root",
    );
  }
  const owned = await readMiladyOwned();
  const withoutCurrent = owned.filter((m) => m.id !== model.id);
  withoutCurrent.push(model);
  await writeMiladyOwned(withoutCurrent);
}

/** Mark an existing Milady-owned model as most-recently-used. */
export async function touchMiladyModel(id: string): Promise<void> {
  const owned = await readMiladyOwned();
  const target = owned.find((m) => m.id === id);
  if (!target) return;
  target.lastUsedAt = new Date().toISOString();
  await writeMiladyOwned(owned);
}

/**
 * Delete a Milady-owned model from the registry and from disk.
 *
 * Refuses if the model was discovered from another tool — Milady must not
 * touch files it doesn't own. Callers surface that refusal as a 4xx.
 */
export async function removeMiladyModel(id: string): Promise<{
  removed: boolean;
  reason?: "external" | "not-found";
}> {
  const owned = await readMiladyOwned();
  const target = owned.find((m) => m.id === id);
  if (!target) {
    // Check whether it's a known external entry so we can return a
    // helpful error message instead of 404.
    const external = await scanExternalModels();
    if (external.some((m) => m.id === id)) {
      return { removed: false, reason: "external" };
    }
    return { removed: false, reason: "not-found" };
  }

  if (!isWithinMiladyRoot(target.path)) {
    return { removed: false, reason: "external" };
  }

  try {
    await fs.rm(target.path, { force: true });
  } catch {
    // If the file was already gone we still want to clear the registry entry.
  }

  await writeMiladyOwned(owned.filter((m) => m.id !== id));
  return { removed: true };
}
