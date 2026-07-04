/** Supports app-core build, packaging, or development orchestration for mobile build decisions mjs. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { artifactStaleness } from "./artifact-staleness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appCoreScriptsDir = path.resolve(__dirname, "..");

/**
 * Brand-separation invariant (issue #9309): the shared canonical Android tree
 * is used only for the elizaOS app itself. Whitelabel builds use appDir/android
 * so identity overlays cannot corrupt another brand's native project.
 */
export function androidUsesAppDirFor(appId, env = process.env) {
  return env.ELIZA_ANDROID_USE_APP_DIR === "1" || appId !== "ai.elizaos.app";
}

const MTP_BUILD_SCRIPT = path.resolve(
  appCoreScriptsDir,
  "build-llama-cpp-mtp.mjs",
);

// The builder derives its repo root from packages/app-core/scripts, not from
// run-mobile-build's configurable repoRoot. Keep this identical so the
// staleness gate checks the same source tree the builder compiles.
export const mtpBuilderRepoRoot = path.resolve(
  appCoreScriptsDir,
  "..",
  "..",
  "..",
);

export const MTP_FORK_SRC_CANDIDATES = [
  process.env.ELIZA_MTP_LLAMA_CPP_SRC?.trim(),
  path.join(
    mtpBuilderRepoRoot,
    "plugins",
    "plugin-local-inference",
    "native",
    "llama.cpp",
  ),
  path.join(
    mtpBuilderRepoRoot,
    "packages",
    "native",
    "ios-deps",
    "llama.cpp",
    "src",
  ),
].filter(Boolean);

/**
 * Decide whether a staged MTP slice can be reused or is stale relative to the
 * fork it was built from.
 */
export function mtpSliceReuse(capabilitiesPath, forkSrc, currentRevision) {
  if (!fs.existsSync(capabilitiesPath)) {
    return { reusable: false, reason: "no CAPABILITIES.json" };
  }
  let recordedRevision = null;
  try {
    recordedRevision = JSON.parse(fs.readFileSync(capabilitiesPath, "utf8"))
      ?.fork?.revision;
  } catch {
    return { reusable: false, reason: "unreadable CAPABILITIES.json" };
  }
  if (recordedRevision === "unknown") recordedRevision = null;
  if (
    recordedRevision &&
    currentRevision &&
    recordedRevision !== currentRevision
  ) {
    return {
      reusable: false,
      reason: `fork revision changed (${recordedRevision} -> ${currentRevision})`,
    };
  }
  if (forkSrc) {
    const staleness = artifactStaleness(capabilitiesPath, {
      sourceDirs: [
        path.join(forkSrc, "ggml"),
        path.join(forkSrc, "src"),
        path.join(forkSrc, "common"),
      ],
      sourceFiles: [path.join(forkSrc, "CMakeLists.txt"), MTP_BUILD_SCRIPT],
    });
    if (staleness.stale) {
      return { reusable: false, reason: staleness.reason };
    }
  }
  return { reusable: true, reason: "fresh" };
}

export function mtpForceRebuildRequested(reuse, env = process.env) {
  return env.ELIZA_IOS_REBUILD_MTP === "1" || !reuse.reusable;
}
