import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DynamicViewManifest } from "../dynamic-views/types";

export const LAUNCH_DIAGNOSTICS_VIEW_ID = "launch.diagnostics";

const VIEW_FILE = "launch-diagnostics.html";

function currentDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveLaunchDiagnosticsEntrypoint(): string {
  const baseDir = currentDir();
  const candidates = [
    path.join(baseDir, "views", VIEW_FILE),
    path.join(baseDir, "launch", "views", VIEW_FILE),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return pathToFileURL(found ?? candidates[0]).href;
}

export function createLaunchDiagnosticsViewManifest(): DynamicViewManifest {
  return {
    id: LAUNCH_DIAGNOSTICS_VIEW_ID,
    title: "Launch Diagnostics",
    description: "Contextual diagnostics for startup, onboarding, and recovery.",
    source: "system",
    entrypoint: resolveLaunchDiagnosticsEntrypoint(),
    placement: "debug",
    metadata: {
      launch: true,
      productionPanel: false,
    },
  };
}
