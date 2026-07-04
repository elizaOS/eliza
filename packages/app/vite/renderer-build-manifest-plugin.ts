/**
 * Vite plugin that records renderer build outputs for desktop and mobile
 * packaging steps.
 */
import { execSync } from "node:child_process";
import type { Plugin } from "vite";
import {
  RENDERER_BUILD_MANIFEST_FILENAME,
  writeRendererBuildManifest,
} from "../../app-core/scripts/lib/renderer-build-manifest.mjs";

/**
 * Emits `dist/eliza-renderer-build.json` at the end of EVERY production renderer
 * build (mobile, desktop, web). The file is a content-derived build stamp that:
 *   - ships on-device (cap sync copies the whole webDir; the desktop Electrobun
 *     copy carries dist/), giving an asserted in-app "which renderer is this",
 *   - lets the platform orchestrators fail the build loudly when a stale or
 *     missing renderer would otherwise be staged (issue #9309).
 *
 * It runs in `closeBundle` (after all outputs are on disk) and reads the final
 * dist directory so the fingerprint reflects exactly what was emitted. Dev
 * servers never write a manifest (apply: "build").
 */
function resolveCommit(): string | null {
  const envCommit =
    process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim();
  if (envCommit) return envCommit;
  try {
    return execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function rendererBuildManifestPlugin(): Plugin {
  let outDir = "dist";
  return {
    name: "renderer-build-manifest",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      // Model-tester and other secondary single-file builds emit no index.html;
      // only stamp a real app bundle.
      try {
        const manifest = writeRendererBuildManifest(outDir, {
          commit: resolveCommit(),
          variant: process.env.ELIZA_BUILD_VARIANT ?? null,
          capacitorTarget: process.env.ELIZA_CAPACITOR_BUILD_TARGET ?? null,
          runtimeMode:
            process.env.VITE_ELIZA_IOS_RUNTIME_MODE ??
            process.env.VITE_ELIZA_ANDROID_RUNTIME_MODE ??
            process.env.ELIZA_RUNTIME_MODE ??
            null,
        });
        this.info?.(
          `[renderer-build-manifest] wrote ${RENDERER_BUILD_MANIFEST_FILENAME} buildId=${manifest.buildId.slice(0, 12)} (${manifest.assetCount} assets)`,
        );
      } catch (err) {
        // A renderer build with no index.html is a non-app output (e.g. the
        // model-tester entry); skip stamping rather than failing the build.
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not a built renderer")) return;
        throw err;
      }
    },
  };
}
