/**
 * Build-verification for an on-device artifact (issue #9309).
 *
 * Asserts a staged platform artifact contains (a) the freshly built renderer
 * (via the build stamp), and (b) every required companion file — the agent
 * bundle and the platform's native lib set. Used as a post-build CI gate so a
 * device artifact that is missing the latest renderer, the agent bundle, or a
 * native lib FAILS loudly instead of shipping a half-staged build.
 */
import fs from "node:fs";
import path from "node:path";

import {
  assertStagedRendererMatchesBuild,
  type RendererBuildManifest,
  readRendererBuildManifest,
  rendererBuildManifestMatchesDist,
} from "./renderer-build-manifest.ts";

/**
 * @param {{
 *   rendererDir: string,            // the staged web root (holds index.html + the build stamp)
 *   freshDistDir?: string|null,     // the just-built dist to match against (optional)
 *   requiredFiles?: string[],       // companion files (agent bundle, native libs); relative→rendererDir
 *   label?: string,
 * }} opts
 * @returns {{ ok: boolean, problems: string[], manifest: object|null }}
 */
export function verifyStagedArtifact({
  rendererDir,
  freshDistDir = null,
  requiredFiles = [],
  label = "artifact",
}: {
  rendererDir: string;
  freshDistDir?: string | null;
  requiredFiles?: string[];
  label?: string;
}) {
  const problems: string[] = [];
  let manifest: RendererBuildManifest | null = null;

  if (freshDistDir) {
    try {
      manifest = assertStagedRendererMatchesBuild(freshDistDir, rendererDir, {
        label,
      });
    } catch (error) {
      // error-policy:J4: expose verification failures in the returned gate result.
      problems.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    manifest = readRendererBuildManifest(rendererDir);
    if (!manifest) {
      problems.push(
        `${label}: no renderer build stamp in ${rendererDir} — unverifiable renderer.`,
      );
    } else if (!rendererBuildManifestMatchesDist(rendererDir, manifest)) {
      problems.push(`${label}: renderer bytes do not match the build stamp.`);
    }
  }

  for (const file of requiredFiles) {
    const abs = path.isAbsolute(file) ? file : path.join(rendererDir, file);
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size === 0) {
        problems.push(
          `${label}: required artifact must be a nonempty file: ${file}`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        problems.push(`${label}: missing required artifact file ${file}`);
      } else {
        throw error;
      }
    }
  }

  return { ok: problems.length === 0, problems, manifest };
}
