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
  readRendererBuildManifest,
} from "./renderer-build-manifest.mjs";

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
}) {
  const problems = [];
  let manifest = null;

  if (freshDistDir) {
    try {
      manifest = assertStagedRendererMatchesBuild(freshDistDir, rendererDir, {
        label,
      });
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    manifest = readRendererBuildManifest(rendererDir);
    if (!manifest) {
      problems.push(
        `${label}: no renderer build stamp in ${rendererDir} — unverifiable renderer.`,
      );
    }
  }

  for (const file of requiredFiles) {
    const abs = path.isAbsolute(file) ? file : path.join(rendererDir, file);
    if (!fs.existsSync(abs)) {
      problems.push(`${label}: missing required artifact file ${file}`);
    }
  }

  return { ok: problems.length === 0, problems, manifest };
}
