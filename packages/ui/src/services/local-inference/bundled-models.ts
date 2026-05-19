/**
 * Bundled-models bootstrap for AOSP / on-device installs.
 *
 * The AOSP build pipeline stages Eliza-1 models into the APK at
 * `assets/agent/models/{file}.gguf` plus a
 * `manifest.json` describing each one (id, role, sha256, sizeBytes).
 * `ElizaAgentService.extractAssetsIfNeeded()` copies those files into
 * `$ELIZA_STATE_DIR/local-inference/models/` on first launch.
 *
 * This module reads the manifest at runtime startup and registers each
 * file as a eliza-owned model in the local-inference registry, so the
 * auto-assign pass picks them up for TEXT_LARGE / TEXT_SMALL /
 * TEXT_EMBEDDING slots without needing the user to download anything.
 *
 * Idempotent: re-running with the registry already populated is a
 * no-op for unchanged entries (`upsertElizaModel` overwrites entries
 * with the same id, so updated sha256s on a future re-bundle replace
 * the old metadata cleanly).
 *
 * Source classification: the runtime treats bundled models as
 * `source: "eliza-download"` because Eliza ships the file and Eliza
 * owns it on disk — same lifecycle as a user-initiated download
 * (uninstall removes the file, the registry tracks the install). The
 * only difference is the file arrived via APK extraction rather than
 * an HTTP transfer.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureDefaultAssignment,
  readAssignments,
  writeAssignments,
} from "./assignments";
import { elizaModelsDir } from "./paths";
import { upsertElizaModel } from "./registry";
import type { InstalledModel } from "./types";

interface BundledModelEntry {
  id: string;
  displayName: string;
  hfRepo: string;
  ggufFile: string;
  role: "chat" | "embedding";
  sizeBytes: number;
  sha256: string | null;
}

interface BundledModelManifest {
  version: 1;
  models: BundledModelEntry[];
}

function manifestPath(): string {
  return path.join(elizaModelsDir(), "manifest.json");
}

async function readManifest(): Promise<BundledModelManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(), "utf8");
    const parsed = JSON.parse(raw) as BundledModelManifest;
    if (parsed?.version !== 1 || !Array.isArray(parsed.models)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function ensureBundledAssignment(
  modelId: string,
  role: BundledModelEntry["role"],
): Promise<void> {
  if (role !== "embedding") {
    await ensureDefaultAssignment(modelId);
    return;
  }

  const current = await readAssignments();
  if (current.TEXT_EMBEDDING) return;
  await writeAssignments({ ...current, TEXT_EMBEDDING: modelId });
}

/**
 * Walk the manifest and register every bundled GGUF file in the
 * local-inference registry. Returns the number of entries successfully
 * registered. A missing manifest is normal on Capacitor / desktop /
 * non-AOSP installs and returns 0 silently.
 */
export async function registerBundledModels(): Promise<number> {
  const manifest = await readManifest();
  if (!manifest) return 0;
  const dir = elizaModelsDir();
  let registered = 0;
  for (const entry of manifest.models) {
    const filePath = path.join(dir, entry.ggufFile);
    let sizeBytes = entry.sizeBytes;
    try {
      const stat = await fs.stat(filePath);
      sizeBytes = stat.size;
    } catch {
      // File didn't extract — manifest references something the APK
      // didn't ship. Skip this entry rather than registering a broken
      // path. AOSP build's stage-default-models.mjs is the source of
      // truth; if a file is missing the build is broken upstream.
      continue;
    }
    const installed: InstalledModel = {
      id: entry.id,
      displayName: entry.displayName,
      path: filePath,
      sizeBytes,
      hfRepo: entry.hfRepo,
      installedAt: new Date().toISOString(),
      lastUsedAt: null,
      source: "eliza-download",
      sha256: entry.sha256 ?? undefined,
    };
    await upsertElizaModel(installed);
    // Auto-assign each bundled model to its manifest role if the user
    // hasn't already assigned that slot. This keeps Eliza-1 chat models
    // eligible for TEXT_EMBEDDING when the bundle explicitly marks them
    // as the local embedding bootstrap model.
    await ensureBundledAssignment(entry.id, entry.role);
    registered += 1;
  }
  return registered;
}
