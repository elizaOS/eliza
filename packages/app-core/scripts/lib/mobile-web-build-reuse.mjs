/** Supports app-core build, packaging, or development orchestration for mobile web build reuse mjs. */
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

/**
 * `expectedRuntimeMode` semantics (issue #11030): pass the runtime mode the
 * lane bakes (`local`, `cloud-hybrid`, `cloud`, …), or `null` to assert the
 * lane bakes no runtime mode. Omit the option (undefined) ONLY for surfaces
 * with no runtime-mode lane at all (plain web/desktop dist reuse) — when
 * omitted the runtime-mode check is skipped, which is how a stale cloud-mode
 * dist once leaked into `build:ios:local` via cap sync.
 */
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
    if (expectedRuntimeMode !== undefined) {
      const manifestRuntimeMode = manifest.runtimeMode ?? null;
      const wantedRuntimeMode = expectedRuntimeMode ?? null;
      if (manifestRuntimeMode !== wantedRuntimeMode) {
        const wantedLabel =
          wantedRuntimeMode == null
            ? "an unset runtime mode"
            : `'${wantedRuntimeMode}'`;
        problems.push(
          manifestRuntimeMode == null
            ? `dist manifest is missing runtime mode; this build targets ${wantedLabel}`
            : `dist built for runtime mode '${manifestRuntimeMode}' but this build targets ${wantedLabel}`,
        );
      }
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
