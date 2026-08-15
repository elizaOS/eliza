/**
 * Resolves agent-surface browser artifacts to the canonical recorder's
 * explicit destination while retaining fixture-local output for direct runs.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const DIRECT_AGENT_SURFACE_OUTPUT_DIR = join(here, "output");

export const AGENT_SURFACE_ARTIFACT_NAMES = [
  "fixture.html",
  "real-view.html",
  "agent-surface-rest.png",
  "agent-surface-highlight.png",
  "agent-surface-real-view.png",
];

export function resolveAgentSurfaceOutputDir(env = process.env) {
  if (env.E2E_RECORD === "1" && env.E2E_RECORDING_DIR) {
    return resolve(env.E2E_RECORDING_DIR);
  }
  return DIRECT_AGENT_SURFACE_OUTPUT_DIR;
}
