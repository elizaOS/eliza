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

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { findCatalogModel } from "./catalog";
import { scanExternalModels } from "./external-scanner";
import { isWithinElizaRoot, localInferenceRoot, registryPath } from "./paths";
import type { InstalledModel } from "./types";

interface RegistryFile {
  version: 1;
  models: InstalledModel[];
}

interface BundleManifestFileEntry {
  path: string;
  sha256: string;
}

interface BundleManifest {
  id: string;
  version?: string;
  files?: {
    dflash?: BundleManifestFileEntry[];
  };
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

function resolveBundleFilePath(
  bundleRoot: string,
  relativePath: string,
): string | null {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    /^[a-zA-Z]:[\\/]/.test(relativePath)
  ) {
    return null;
  }

  const resolvedRoot = path.resolve(bundleRoot);
  const resolvedFile = path.resolve(resolvedRoot, relativePath);
  if (
    resolvedFile !== resolvedRoot &&
    !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    return null;
  }
  return resolvedFile;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function tryReadBundleManifest(
  model: InstalledModel,
): Promise<BundleManifest | null> {
  if (!model.manifestPath || !model.bundleRoot) return null;
  if (!isWithinElizaRoot(model.manifestPath)) return null;
  try {
    const raw = JSON.parse(
      await fs.readFile(model.manifestPath, "utf8"),
    ) as BundleManifest;
    if (!raw || raw.id !== model.id || !raw.files) return null;
    return raw;
  } catch {
    return null;
  }
}

async function maybeRecoverDflashCompanion(
  model: InstalledModel,
): Promise<InstalledModel | null> {
  if (model.runtimeRole && model.runtimeRole !== "chat") return null;
  if (!model.bundleRoot || !isWithinElizaRoot(model.bundleRoot)) return null;

  const catalog = findCatalogModel(model.id);
  const dflash = catalog?.runtime?.dflash;
  if (!dflash) return null;

  const companion = findCatalogModel(dflash.drafterModelId);
  if (!companion) return null;

  const manifest = await tryReadBundleManifest(model);
  const drafterEntry = manifest?.files?.dflash?.find(
    (entry) => entry.path === companion.ggufFile,
  );
  if (
    !manifest ||
    !drafterEntry ||
    !/^[a-f0-9]{64}$/.test(drafterEntry.sha256)
  ) {
    return null;
  }

  const drafterPath = resolveBundleFilePath(
    model.bundleRoot,
    drafterEntry.path,
  );
  if (!drafterPath || !isWithinElizaRoot(drafterPath)) return null;

  try {
    const [stat, sha256] = await Promise.all([
      fs.stat(drafterPath),
      hashFile(drafterPath),
    ]);
    if (!stat.isFile() || sha256 !== drafterEntry.sha256) return null;
    const now = new Date().toISOString();
    return {
      id: companion.id,
      displayName: companion.displayName,
      path: drafterPath,
      sizeBytes: stat.size,
      hfRepo: companion.hfRepo ?? model.hfRepo,
      installedAt: model.installedAt,
      lastUsedAt: null,
      source: "eliza-download",
      sha256,
      lastVerifiedAt: now,
      runtimeRole: "dflash-drafter",
      companionFor: model.id,
      bundleRoot: model.bundleRoot,
      manifestPath: model.manifestPath,
      manifestSha256: model.manifestSha256,
      bundleVersion: manifest.version ?? model.bundleVersion,
      bundleSizeBytes: model.bundleSizeBytes,
    };
  } catch {
    return null;
  }
}

async function recoverDflashCompanions(
  owned: InstalledModel[],
): Promise<InstalledModel[]> {
  const byId = new Map(owned.map((model) => [model.id, model]));
  let changed = false;

  for (const model of owned) {
    const catalog = findCatalogModel(model.id);
    const drafterId = catalog?.runtime?.dflash?.drafterModelId;
    if (!drafterId || byId.has(drafterId)) continue;

    const companion = await maybeRecoverDflashCompanion(model);
    if (!companion || byId.has(companion.id)) continue;
    byId.set(companion.id, companion);
    changed = true;
  }

  if (!changed) return owned;
  const recovered = [...byId.values()];
  try {
    await writeElizaOwned(recovered);
  } catch {
    // Listing should stay usable even if a read-only state dir prevents
    // persisting the repaired companion entry.
  }
  return recovered;
}

/**
 * Return all models currently usable: persisted Eliza downloads plus a
 * fresh external-tool scan. External duplicates of Eliza-owned files are
 * filtered out by path.
 */
export async function listInstalledModels(): Promise<InstalledModel[]> {
  const [ownedRaw, external] = await Promise.all([
    readElizaOwned(),
    scanExternalModels(),
  ]);
  const owned = await recoverDflashCompanions(ownedRaw);

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
