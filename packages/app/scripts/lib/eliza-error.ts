/**
 * Structured errors for standalone app build scripts.
 *
 * A workspace checkout uses core source so an ignored, stale `dist` tree cannot
 * change error identity. Installed packages have no workspace source and load
 * the package's compiled public root export instead.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sourceCandidates = [
  new URL("../../../core/src/errors.ts", import.meta.url),
  new URL("../../../../core/src/errors.ts", import.meta.url),
];
const sourceUrl = sourceCandidates.find((candidate) =>
  fs.existsSync(fileURLToPath(candidate)),
);
// Do not resolve an installed package before checking the source tree: setup
// scripts must also work before workspace package links have been installed.
const coreModuleUrl = sourceUrl?.href ?? import.meta.resolve("@elizaos/core");

const coreErrors = await import(coreModuleUrl);
if (typeof coreErrors.ElizaError !== "function") {
  throw new Error("@elizaos/core does not export ElizaError.");
}

export const ElizaError: typeof import("@elizaos/core").ElizaError =
  coreErrors.ElizaError;
