/**
 * On-disk registry of installed models.
 *
 * Two sources feed the registry:
 *   1. Eliza-owned downloads (source: "eliza-download") — written on
 *      successful completion by the downloader.
 *   2. External scans (source: "external-scan") — merged in at read time
 *      from `scanExternalModels()`. These are never persisted to the
 *      registry file; a rescan runs whenever we read.
 *
 * The JSON file only holds Eliza-owned entries. That way, if a user
 * cleans up LM Studio models we don't show stale ghosts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { scanExternalModels } from "./external-scanner";
import { isWithinElizaRoot, localInferenceRoot, registryPath } from "./paths";
import type { InstalledModel } from "./types";

interface RegistryFile {
  version: 1;
  models: InstalledModel[];
}

async function ensureRootDir(): Promise<void> {
  await fs.mkdir(localInferenceRoot(), { recursive: true });
}

async function readElizaOwned(): Promise<InstalledModel[]> {
  try {
    const raw = await fs.readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as RegistryFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.models)) {
      return [];
    }
    return parsed.models.filter(
      (m): m is InstalledModel =>
        m && typeof m === "object" && m.source === "eliza-download",
    );
  } catch {
    return [];
  }
}

async function writeElizaOwned(models: InstalledModel[]): Promise<void> {
  await ensureRootDir();
  const tmp = `${registryPath()}.tmp`;
  const payload: RegistryFile = { version: 1, models };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, registryPath());
}

/**
 * Return all models currently usable: persisted Eliza downloads plus a
 * fresh external-tool scan. External duplicates of Eliza-owned files are
 * filtered out by path.
 */
export async function listInstalledModels(): Promise<InstalledModel[]> {
  const [owned, external] = await Promise.all([
    readElizaOwned(),
    scanExternalModels(),
  ]);

  // Filter out Eliza-owned files that also survived a reboot of the local
  // file and got re-detected by the scanner.
  const ownedPaths = new Set(owned.map((m) => path.resolve(m.path)));
  const dedupedExternal = external.filter(
    (m) => !ownedPaths.has(path.resolve(m.path)),
  );

  return [...owned, ...dedupedExternal];
}

/** Add or update a Eliza-owned entry. External entries are rejected. */
export async function upsertElizaModel(model: InstalledModel): Promise<void> {
  if (model.source !== "eliza-download") {
    throw new Error(
      "[local-inference] registry only accepts Eliza-owned models",
    );
  }
  if (!isWithinElizaRoot(model.path)) {
    throw new Error(
      "[local-inference] Eliza-owned models must live under the local-inference root",
    );
  }
  if (model.bundleRoot && !isWithinElizaRoot(model.bundleRoot)) {
    throw new Error(
      "[local-inference] Eliza-owned bundle roots must live under the local-inference root",
    );
  }
  if (model.manifestPath && !isWithinElizaRoot(model.manifestPath)) {
    throw new Error(
      "[local-inference] Eliza-owned manifests must live under the local-inference root",
    );
  }
  const owned = await readElizaOwned();
  const withoutCurrent = owned.filter((m) => m.id !== model.id);
  withoutCurrent.push(model);
  await writeElizaOwned(withoutCurrent);
}

/** Mark an existing Eliza-owned model as most-recently-used. */
export async function touchElizaModel(id: string): Promise<void> {
  const owned = await readElizaOwned();
  const target = owned.find((m) => m.id === id);
  if (!target) return;
  target.lastUsedAt = new Date().toISOString();
  await writeElizaOwned(owned);
}

/**
 * Delete a Eliza-owned model from the registry and from disk.
 *
 * Refuses if the model was discovered from another tool — Eliza must not
 * touch files it doesn't own. Callers surface that refusal as a 4xx.
 */
export async function removeElizaModel(id: string): Promise<{
  removed: boolean;
  reason?: "external" | "not-found";
}> {
  const owned = await readElizaOwned();
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

  if (!isWithinElizaRoot(target.path)) {
    return { removed: false, reason: "external" };
  }

  const removePath =
    target.bundleRoot && isWithinElizaRoot(target.bundleRoot)
      ? target.bundleRoot
      : target.path;
  try {
    await fs.rm(removePath, { recursive: true, force: true });
  } catch {
    // If the file was already gone we still want to clear the registry entry.
  }

  await writeElizaOwned(owned.filter((m) => m.id !== id));
  return { removed: true };
}
