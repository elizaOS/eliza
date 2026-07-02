import fs from "node:fs";
import path from "node:path";

import {
  RENDERER_BUILD_MANIFEST_FILENAME,
  readRendererBuildManifest,
} from "./renderer-build-manifest.mjs";
import { viteRendererBuildNeeded } from "./vite-renderer-dist-stale.mjs";

function targetLabel(expectedTarget) {
  return expectedTarget ? `'${expectedTarget}'` : "an unset target";
}

export function mobileWebDistReuseStatus({
  appDir,
  repoRoot,
  expectedVariant,
  expectedTarget,
  expectedRuntimeMode,
  readManifest = readRendererBuildManifest,
  buildNeeded = viteRendererBuildNeeded,
} = {}) {
  if (!appDir) {
    throw new Error("mobileWebDistReuseStatus: appDir is required");
  }
  if (!repoRoot) {
    throw new Error("mobileWebDistReuseStatus: repoRoot is required");
  }

  const distDir = path.join(appDir, "dist");
  const indexPath = path.join(distDir, "index.html");
  const problems = [];
  const hasIndex = fs.existsSync(indexPath);
  if (!hasIndex) {
    problems.push(`missing renderer entrypoint: ${indexPath}`);
  }

  const manifest = readManifest(distDir);
  if (!manifest) {
    problems.push(
      `no ${path.join("dist", RENDERER_BUILD_MANIFEST_FILENAME)} (renderer not built with the build-manifest plugin)`,
    );
  } else {
    if (typeof manifest.buildId !== "string" || manifest.buildId.length === 0) {
      problems.push("dist manifest is missing buildId");
    }
    if (manifest.variant !== expectedVariant) {
      problems.push(
        manifest.variant == null
          ? `dist manifest is missing variant; this build targets '${expectedVariant}'`
          : `dist built for variant '${manifest.variant}' but this build targets '${expectedVariant}'`,
      );
    }
    if (manifest.capacitorTarget !== expectedTarget) {
      problems.push(
        manifest.capacitorTarget == null
          ? `dist manifest is missing capacitor target; this build targets ${targetLabel(expectedTarget)}`
          : `dist built for capacitor target '${manifest.capacitorTarget}' but this build targets ${targetLabel(expectedTarget)}`,
      );
    }
    // Never reuse a dist baked for a different runtime mode. `ios` (store,
    // cloud-hybrid) and `build:ios:local:device:full-bun:release` (store,
    // local) share variant+target, so without this check a cloud sideload's
    // dist was silently reused by a local device lane and the phone hung on
    // "Booting up…" with no Agent.apiBase (issue #11030).
    if (
      expectedRuntimeMode !== undefined &&
      manifest.runtimeMode !== expectedRuntimeMode
    ) {
      problems.push(
        manifest.runtimeMode == null
          ? `dist manifest is missing runtime mode; this build targets '${expectedRuntimeMode}'`
          : `dist built for runtime mode '${manifest.runtimeMode}' but this build targets '${expectedRuntimeMode}'`,
      );
    }
  }

  if (hasIndex && buildNeeded(appDir, repoRoot)) {
    problems.push("dist is older than renderer sources (stale)");
  }

  return {
    reusable: problems.length === 0,
    distDir,
    indexPath,
    manifest,
    problems,
  };
}

export function formatMobileWebDistProblems(problems) {
  return problems.map((problem) => `  - ${problem}`).join("\n");
}
