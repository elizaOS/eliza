#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalElizaDisabled } from "./lib/eliza-source-mode.mjs";

const LOG_PREFIX = "[ensure-elizaos-optional-app-stubs]";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const nodeModulesDir = path.join(repoRoot, "node_modules");

const optionalPackages = [
  "@elizaos/app-clawville",
  "@elizaos/app-companion",
  "@elizaos/app-elizamaker",
  "@elizaos/app-hyperliquid",
  "@elizaos/app-documents",
  "@elizaos/app-lifeops",
  "@elizaos/app-polymarket",
  "@elizaos/app-shopify",
  "@elizaos/app-steward",
  "@elizaos/app-task-coordinator",
  "@elizaos/app-training",
  "@elizaos/app-vincent",
];

const stubSource = `const optionalStub = Object.freeze({
  name: "optional-elizaos-app-stub",
  routes: [],
});

export const EMOTE_BY_ID = Object.freeze({});
export const EMOTE_CATALOG = Object.freeze([]);
export const LIFEOPS_CONNECTOR_DEGRADATION_AXES = Object.freeze([]);
export const appPlugin = optionalStub;
export const defaultPlugin = optionalStub;
export const hyperliquidPlugin = optionalStub;
export const documentsPlugin = optionalStub;
export const lifeopsPlugin = optionalStub;
export const polymarketPlugin = optionalStub;
export const plugin = optionalStub;
export const shopifyPlugin = optionalStub;
export const stewardPlugin = optionalStub;
export const trainingPlugin = optionalStub;
export const vincentPlugin = optionalStub;

export const documentsRoutes = Object.freeze([]);
export const trainingRoutes = Object.freeze([]);

export function clearBackendCache() {}
export async function detectAvailableBackends() {
  return { available: false, backends: [] };
}
export function getElizaMakerRegistryService() {
  return null;
}
export function getSelfControlPermissionState() {
  return { granted: false, status: "unavailable" };
}
export async function handleCloudFeaturesRoute() {
  return false;
}
export async function handleDocumentsRoutes() {
  return false;
}
export async function handleTrainingRoutes() {
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
export async function loadTrainingConfig() {
  return {};
}
export function normalizePreflightAuth(auth) {
  return auth ?? null;
}
export async function openSelfControlPermissionLocation() {
  return false;
}
export async function requestSelfControlPermission() {
  return { granted: false, status: "unavailable" };
}
export async function registerTrainingRuntimeHooks() {}
export function sanitizeAuthResult(result) {
  return result ?? null;
}
export async function saveTrainingConfig() {}
export function setActiveTrainingService() {}
export async function stewardEvmPostBoot() {}
export async function stewardEvmPreBoot() {}

export default optionalStub;
`;

function packageDir(packageName) {
  return path.join(nodeModulesDir, ...packageName.split("/"));
}

function ensureStubPackage(packageName) {
  const dir = packageDir(packageName);
  const packageJsonPath = path.join(dir, "package.json");

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

const created = optionalPackages.filter(ensureStubPackage);
if (created.length === 0) {
  console.log(`${LOG_PREFIX} optional app stubs already present or installed.`);
} else {
  console.log(`${LOG_PREFIX} created ${created.length} optional app stub(s).`);
}
