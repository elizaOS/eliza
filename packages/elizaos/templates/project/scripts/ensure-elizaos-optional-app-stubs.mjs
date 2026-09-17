#!/usr/bin/env node
/**
 * Disables the unsupported WhatsApp QR connector in package-mode projects.
 * Removes obsolete placeholder plugins so optional capabilities remain absent;
 * installed first-party packages are never patched after installation.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalElizaDisabled } from "./lib/eliza-source-mode.mjs";

const LOG_PREFIX = "[ensure-elizaos-optional-app-stubs]";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const nodeModulesDir = path.join(repoRoot, "node_modules");
const cleanupHelperPath = path.join(scriptDir, "rm-path-recursive.mjs");

const retiredStubPackages = [
  "@elizaos/plugin-documents",
  "@elizaos/plugin-personal-assistant",
  "@elizaos/plugin-task-coordinator",
];

const forcedStubPackages = ["@elizaos/plugin-whatsapp"];

const stubSource = `const optionalStub = Object.freeze({
  name: "optional-elizaos-app-stub",
  routes: [],
});

export const LIFEOPS_CONNECTOR_DEGRADATION_AXES = Object.freeze([]);
export const appPlugin = optionalStub;
export const defaultPlugin = optionalStub;
export const documentsPlugin = optionalStub;
export const personalAssistantPlugin = optionalStub;
export const plugin = optionalStub;
export const stewardPlugin = optionalStub;
export const documentsRoutes = Object.freeze([]);
export function getSelfControlPermissionState() {
  return { granted: false, status: "unavailable" };
}
export async function handleCloudFeaturesRoute() {
  return false;
}
export async function handleDocumentsRoutes() {
  return false;
}
export async function handleWhatsAppRoute() {
  return false;
}
export async function handleTrajectoryRoute() {
  return false;
}
export async function handleTravelProviderRelayRoute() {
  return false;
}
export async function handleWalletCoreRoutes() {
  return false;
}
export async function initializeOGCode() {}
export function normalizePreflightAuth(auth) {
  return auth ?? null;
}
export function applyWhatsAppQrOverride() {
  return false;
}
export async function openSelfControlPermissionLocation() {
  return false;
}
export async function requestSelfControlPermission() {
  return { granted: false, status: "unavailable" };
}
export function sanitizeAuthResult(result) {
  return result ?? null;
}
export function sanitizeWhatsAppAccountId(value) {
  return typeof value === "string" ? value.trim() : "";
}
export class WhatsAppPairingSession {}
export async function whatsappAuthExists() {
  return false;
}
export async function whatsappLogout() {
  return false;
}

export default optionalStub;
`;

function packageDir(packageName) {
  return path.join(nodeModulesDir, ...packageName.split("/"));
}

function removePathRecursive(targetPath) {
  const result = spawnSync(process.execPath, [cleanupHelperPath, targetPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `rm-path-recursive failed for ${targetPath} with status ${result.status}`,
    );
  }
}

function ensureStubPackage(packageName, { force = false } = {}) {
  const dir = packageDir(packageName);
  const packageJsonPath = path.join(dir, "package.json");

  if (force && fs.existsSync(packageJsonPath)) {
    try {
      const existingPackageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf8"),
      );
      if (existingPackageJson?.version === "0.0.0-elizaos-stub") return false;
    } catch {
      // Replace unreadable package metadata with a known stub below.
    }
    removePathRecursive(dir);
  }

  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(dir);
      if (target.includes("/eliza/") || !fs.existsSync(packageJsonPath)) {
        fs.unlinkSync(dir);
      }
    }
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !("code" in cause) ||
      cause.code !== "ENOENT"
    ) {
      throw cause;
    }
  }

  if (fs.existsSync(packageJsonPath)) return false;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    packageJsonPath,
    `${JSON.stringify(
      {
        name: packageName,
        version: "0.0.0-elizaos-stub",
        type: "module",
        private: true,
        exports: {
          ".": "./stub.js",
          "./*": "./stub.js",
          "./package.json": "./package.json",
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(dir, "stub.js"), stubSource);
  return true;
}

if (!fs.existsSync(nodeModulesDir)) {
  console.warn(`${LOG_PREFIX} node_modules is not installed; skipping.`);
  process.exit(0);
}

if (!isLocalElizaDisabled({ repoRoot })) {
  console.log(`${LOG_PREFIX} local elizaOS source mode; skipping stubs.`);
  process.exit(0);
}

for (const packageName of retiredStubPackages) {
  const manifestPath = path.join(packageDir(packageName), "package.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version === "0.0.0-elizaos-stub" && manifest.name === packageName) {
    removePathRecursive(packageDir(packageName));
  }
}

const forced = forcedStubPackages.filter((packageName) =>
  ensureStubPackage(packageName, { force: true }),
);
if (forced.length > 0) {
  console.log(
    `${LOG_PREFIX} replaced ${forced.length} unsupported connector package(s).`,
  );
}
