/**
 * Type declarations for `verify-ondevice-artifact.mjs` — post-build artifact
 * verification gate (issue #9309).
 */
import type { RendererBuildManifest } from "./renderer-build-manifest.d.mts";

export function verifyStagedArtifact(opts: {
  rendererDir: string;
  freshDistDir?: string | null;
  requiredFiles?: string[];
  label?: string;
}): {
  ok: boolean;
  problems: string[];
  manifest: RendererBuildManifest | null;
};
