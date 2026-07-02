/**
 * On-disk registry of installed models.
 *
 * The default registry contains only Eliza-owned downloads
 * (source: "eliza-download") written on successful completion by the
 * curated bundle downloader. External scans are developer-only diagnostics
 * behind `ELIZA_LOCAL_INFERENCE_ENABLE_EXTERNAL_SCAN=1`; they never enter
 * first-run, setup, or normal Settings surfaces.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { scanExternalModels } from "./external-scanner";
import { isWithinElizaRoot, localInferenceRoot, registryPath } from "./paths";
import type { InstalledModel } from "./types";

type StoredInstalledModel = Omit<
  InstalledModel,
  "path" | "bundleRoot" | "manifestPath"
> & {
  /** Relative to localInferenceRoot() for Eliza-owned rows; legacy JSON may be absolute. */
  path: string;
  bundleRoot?: string;
  manifestPath?: string;
};

interface RegistryFile {
  version: 1;
  models: StoredInstalledModel[];
}

async function ensureRootDir(): Promise<void> {
  await fs.mkdir(localInferenceRoot(), { recursive: true });
}

function normalizeStoredPathSeparator(target: string): string {
  return target.split(/[\\/]+/).join(path.sep);
}

function storedRelativePath(target: string): string {
  const root = path.resolve(localInferenceRoot());
  const resolved = path.resolve(target);
  if (!isWithinElizaRoot(resolved)) return target;
  return path.relative(root, resolved).split(path.sep).join("/");
}

function reanchorLegacyAbsolutePath(target: string): string {
  const resolved = path.resolve(target);
  if (isWithinElizaRoot(resolved)) return resolved;

  const parts = normalizeStoredPathSeparator(resolved).split(path.sep);
  const markerIndex = parts.lastIndexOf("local-inference");
  if (markerIndex < 0 || markerIndex === parts.length - 1) {
    return resolved;
  }

  const candidate = path.resolve(
    localInferenceRoot(),
    ...parts.slice(markerIndex + 1),
  );
  return isWithinElizaRoot(candidate) ? candidate : resolved;
}

function resolveStoredElizaPath(target: string): string | null {
  if (typeof target !== "string" || target.trim().length === 0) return null;
  if (path.isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target)) {
    return reanchorLegacyAbsolutePath(target);
  }

  const resolved = path.resolve(
    localInferenceRoot(),
    normalizeStoredPathSeparator(target),
  );
  return isWithinElizaRoot(resolved) ? resolved : null;
}

function hydrateStoredModel(
  model: StoredInstalledModel,
): InstalledModel | null {
  const modelPath = resolveStoredElizaPath(model.path);
  if (!modelPath) return null;

  const bundleRoot = model.bundleRoot
    ? resolveStoredElizaPath(model.bundleRoot)
    : undefined;
  const manifestPath = model.manifestPath
    ? resolveStoredElizaPath(model.manifestPath)
    : undefined;

  if (model.bundleRoot && !bundleRoot) return null;
  if (model.manifestPath && !manifestPath) return null;

  return {
    ...model,
    path: modelPath,
    ...(bundleRoot ? { bundleRoot } : {}),
    ...(manifestPath ? { manifestPath } : {}),
  };
}

function dehydrateStoredModel(model: InstalledModel): StoredInstalledModel {
  return {
    ...model,
    path: storedRelativePath(model.path),
    ...(model.bundleRoot
      ? { bundleRoot: storedRelativePath(model.bundleRoot) }
      : {}),
    ...(model.manifestPath
      ? { manifestPath: storedRelativePath(model.manifestPath) }
      : {}),
  };
}

async function readElizaOwned(): Promise<InstalledModel[]> {
  try {
    const raw = await fs.readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as RegistryFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.models)) {
      return [];
    }
    return parsed.models
      .filter(
        (m): m is InstalledModel =>
          m && typeof m === "object" && m.source === "eliza-download",
      )
      .map(hydrateStoredModel)
      .filter((m): m is InstalledModel => m !== null);
  } catch {
    return [];
  }
}

async function writeElizaOwned(models: InstalledModel[]): Promise<void> {
  await ensureRootDir();
  const tmp = `${registryPath()}.tmp`;
  const payload: RegistryFile = {
    version: 1,
    models: models.map(dehydrateStoredModel),
  };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, registryPath());
}

function externalScanEnabled(): boolean {
  const value =
    process.env.ELIZA_LOCAL_INFERENCE_ENABLE_EXTERNAL_SCAN?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isSubpath(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

async function resolveRemovableElizaPath(
  target: string,
): Promise<
  | { status: "safe"; path: string }
  | { status: "missing" }
  | { status: "unsafe" }
> {
  if (!isWithinElizaRoot(target)) return { status: "unsafe" };

  let rootRealPath: string;
  try {
    rootRealPath = await fs.realpath(localInferenceRoot());
  } catch {
    return { status: "missing" };
  }

  try {
    const targetRealPath = await fs.realpath(target);
    if (!isSubpath(targetRealPath, rootRealPath)) {
      return { status: "unsafe" };
    }
    return { status: "safe", path: target };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
}

/**
 * Return models currently usable by the curated local-inference path.
 *
 * Normal product behavior is Eliza-1 only. The external scan remains available
 * only to developers who explicitly opt into the old arbitrary-GGUF diagnostic
 * path with `ELIZA_LOCAL_INFERENCE_ENABLE_EXTERNAL_SCAN=1`.
 */
export async function listInstalledModels(): Promise<InstalledModel[]> {
  const owned = await readElizaOwned();
  if (!externalScanEnabled()) return owned;

  // Filter out Eliza-owned files that also survived a reboot of the local
  // file and got re-detected by the scanner.
  const external = await scanExternalModels();
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
  const removable = await resolveRemovableElizaPath(removePath);
  if (removable.status === "unsafe") {
    return { removed: false, reason: "external" };
  }
  try {
    if (removable.status === "safe") {
      await fs.rm(removable.path, { recursive: true, force: true });
    }
  } catch {
    // If the file was already gone we still want to clear the registry entry.
  }

  await writeElizaOwned(owned.filter((m) => m.id !== id));
  return { removed: true };
}
