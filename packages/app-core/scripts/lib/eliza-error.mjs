/**
 * Structured errors for standalone app-core build scripts.
 *
 * A workspace checkout uses core source so an ignored, stale `dist` tree cannot
 * change error identity. Installed packages have no workspace source and load
 * the package's compiled public root export instead.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const installedCoreUrl = import.meta.resolve("@elizaos/core");
const installedCorePath = fileURLToPath(installedCoreUrl);
const sourceCandidates = [
  new URL("../../../core/src/errors.ts", import.meta.url),
  new URL("../../../../core/src/errors.ts", import.meta.url),
];
const sourceUrl = sourceCandidates.find((candidate) =>
  fs.existsSync(fileURLToPath(candidate)),
);
const coreModuleUrl =
  sourceUrl?.href ??
  (fs.existsSync(installedCorePath) ? installedCoreUrl : undefined);

if (!coreModuleUrl) {
  throw new Error(
    `Could not load @elizaos/core ElizaError from ${installedCorePath} or the workspace source tree.`,
  );
}

const coreErrors = await import(coreModuleUrl);
if (typeof coreErrors.ElizaError !== "function") {
  throw new Error("@elizaos/core does not export ElizaError.");
}

export const ElizaError = coreErrors.ElizaError;
