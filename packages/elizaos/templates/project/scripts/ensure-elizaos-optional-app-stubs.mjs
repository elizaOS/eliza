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

const forcedStubPackages = ["@elizaos/plugin-whatsapp"];

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
export async function handleWhatsAppRoute() {
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
export function applyWhatsAppQrOverride() {
  return false;
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
export function sanitizeWhatsAppAccountId(value) {
  return typeof value === "string" ? value.trim() : "";
}
export async function stewardEvmPostBoot() {}
export async function stewardEvmPreBoot() {}
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
    fs.rmSync(dir, { recursive: true, force: true });
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

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function patchPackagedAppCoreDevUi() {
  const devUiPath = path.join(
    nodeModulesDir,
    "@elizaos",
    "app-core",
    "scripts",
    "dev-ui.mjs",
  );
  if (!fs.existsSync(devUiPath)) return false;

  const before = fs.readFileSync(devUiPath, "utf8");
  const after = before.replace(
    `const packagedAppCoreEntry = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "packages",
    "app-core",
    "src",
    "runtime",
    "dev-server.js",
  );`,
    `const packagedAppCoreEntry = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "runtime",
    "dev-server.js",
  );`,
  );

  if (after === before) return false;
  fs.writeFileSync(devUiPath, after);
  return true;
}

function patchPackagedCoreSandboxPolicyExports() {
  const coreIndexPath = path.join(
    nodeModulesDir,
    "@elizaos",
    "core",
    "dist",
    "node",
    "index.node.js",
  );
  if (!fs.existsSync(coreIndexPath)) return false;

  const before = fs.readFileSync(coreIndexPath, "utf8");
  const hasBuildVariantExports = before.includes("export const BUILD_VARIANTS");
  const hasSandboxPolicyExports = before.includes("isLocalCodeExecutionAllowed");
  if (hasBuildVariantExports && hasSandboxPolicyExports) return false;

  let jsPatch = "";
  if (!hasBuildVariantExports) {
    jsPatch += `
export const BUILD_VARIANTS = ["store", "direct"];
export const DEFAULT_BUILD_VARIANT = "direct";
const __elizaosBuildVariantValues = new Set(BUILD_VARIANTS);
const __elizaosBuildVariantDirectDownloadUrl = "https://milady.so/download";
let __elizaosBuildVariantResolved = null;

export function getBuildVariant() {
  if (__elizaosBuildVariantResolved !== null) {
    return __elizaosBuildVariantResolved;
  }
  const raw =
    (typeof process !== "undefined" &&
      (process.env?.MILADY_BUILD_VARIANT ?? process.env?.ELIZA_BUILD_VARIANT)) ||
    "";
  const normalized = raw.trim().toLowerCase();
  __elizaosBuildVariantResolved = __elizaosBuildVariantValues.has(normalized)
    ? normalized
    : DEFAULT_BUILD_VARIANT;
  return __elizaosBuildVariantResolved;
}

export function getDirectDownloadUrl() {
  return __elizaosBuildVariantDirectDownloadUrl;
}

export function isStoreBuild() {
  return getBuildVariant() === "store";
}

export function isDirectBuild() {
  return getBuildVariant() === "direct";
}

export function _resetBuildVariantForTests() {
  __elizaosBuildVariantResolved = null;
}
`;
  }

  if (!hasSandboxPolicyExports) {
    jsPatch += `
const __elizaosSandboxBuildVariants = new Set(["store", "direct"]);
const __elizaosSandboxDirectDownloadUrl = "https://milady.so/download";
let __elizaosSandboxResolvedVariant = null;

function __elizaosSandboxBuildVariant() {
  if (__elizaosSandboxResolvedVariant !== null) {
    return __elizaosSandboxResolvedVariant;
  }
  const raw =
    (typeof process !== "undefined" &&
      (process.env?.MILADY_BUILD_VARIANT ?? process.env?.ELIZA_BUILD_VARIANT)) ||
    "";
  const normalized = raw.trim().toLowerCase();
  __elizaosSandboxResolvedVariant = __elizaosSandboxBuildVariants.has(normalized)
    ? normalized
    : "direct";
  return __elizaosSandboxResolvedVariant;
}

export function isLocalCodeExecutionAllowed() {
  return __elizaosSandboxBuildVariant() === "direct";
}

export function buildStoreVariantBlockedMessage(featureLabel) {
  return [
    \`\${featureLabel} requires the direct download build of Milady.\`,
    "Store-distributed builds run in an OS sandbox that blocks forking user-installed CLIs.",
    \`To use this feature, install from \${__elizaosSandboxDirectDownloadUrl}.\`,
  ].join(" ");
}
`;
  }

  fs.appendFileSync(coreIndexPath, jsPatch);

  for (const dtsPath of [
    path.join(nodeModulesDir, "@elizaos", "core", "dist", "index.d.ts"),
    path.join(nodeModulesDir, "@elizaos", "core", "dist", "index.node.d.ts"),
  ]) {
    if (!fs.existsSync(dtsPath)) continue;
    const dtsBefore = fs.readFileSync(dtsPath, "utf8");
    let dtsPatch = "";
    if (!dtsBefore.includes("BUILD_VARIANTS")) {
      dtsPatch += `
export declare const BUILD_VARIANTS: readonly ["store", "direct"];
export type BuildVariant = (typeof BUILD_VARIANTS)[number];
export declare const DEFAULT_BUILD_VARIANT: BuildVariant;
export declare function getBuildVariant(): BuildVariant;
export declare function getDirectDownloadUrl(): string;
export declare function isStoreBuild(): boolean;
export declare function isDirectBuild(): boolean;
export declare function _resetBuildVariantForTests(): void;
`;
    }
    if (!dtsBefore.includes("isLocalCodeExecutionAllowed")) {
      dtsPatch += `
export declare function isLocalCodeExecutionAllowed(): boolean;
export declare function buildStoreVariantBlockedMessage(featureLabel: string): string;
`;
    }
    if (!dtsPatch) continue;
    fs.appendFileSync(
      dtsPath,
      dtsPatch,
    );
  }

  return true;
}

function patchPackagedAppCoreSandboxPolicy() {
  const coreIndexPath = path.join(
    nodeModulesDir,
    "@elizaos",
    "core",
    "dist",
    "node",
    "index.node.js",
  );
  if (
    fs.existsSync(coreIndexPath) &&
    fs
      .readFileSync(coreIndexPath, "utf8")
      .includes("isLocalCodeExecutionAllowed")
  ) {
    return false;
  }

  const sandboxPolicyPath = path.join(
    nodeModulesDir,
    "@elizaos",
    "app-core",
    "runtime",
    "sandbox-policy.js",
  );
  if (!fs.existsSync(sandboxPolicyPath)) return false;

  const before = fs.readFileSync(sandboxPolicyPath, "utf8");
  if (!before.includes('from "@elizaos/core"')) return false;

  fs.writeFileSync(
    sandboxPolicyPath,
    `const BUILD_VARIANTS = new Set(["store", "direct"]);
const DIRECT_DOWNLOAD_URL = "https://milady.so/download";
let resolvedVariant = null;

function getBuildVariant() {
  if (resolvedVariant !== null) return resolvedVariant;
  const raw =
    (typeof process !== "undefined" &&
      (process.env?.MILADY_BUILD_VARIANT ?? process.env?.ELIZA_BUILD_VARIANT)) ||
    "";
  const normalized = raw.trim().toLowerCase();
  resolvedVariant = BUILD_VARIANTS.has(normalized) ? normalized : "direct";
  return resolvedVariant;
}

export function isLocalCodeExecutionAllowed() {
  return getBuildVariant() === "direct";
}

export function buildStoreVariantBlockedMessage(featureLabel) {
  return [
    \`\${featureLabel} requires the direct download build of Milady.\`,
    "Store-distributed builds run in an OS sandbox that blocks forking user-installed CLIs.",
    \`To use this feature, install from \${DIRECT_DOWNLOAD_URL}.\`,
  ].join(" ");
}
`,
  );

  const dtsPath = path.join(
    nodeModulesDir,
    "@elizaos",
    "app-core",
    "runtime",
    "sandbox-policy.d.ts",
  );
  if (fs.existsSync(dtsPath)) {
    fs.writeFileSync(
      dtsPath,
      `export declare function isLocalCodeExecutionAllowed(): boolean;
export declare function buildStoreVariantBlockedMessage(featureLabel: string): string;
`,
    );
  }

  return true;
}

function patchBunExportTarget(exportsMap, exportName, bunTarget) {
  const exportEntry = exportsMap?.[exportName];
  if (!exportEntry || typeof exportEntry !== "object") return false;
  const bunEntry = exportEntry.bun;
  if (!bunEntry || typeof bunEntry !== "object") return false;

  const nextBunEntry = {
    ...bunEntry,
    ...bunTarget,
  };

  if (JSON.stringify(nextBunEntry) === JSON.stringify(bunEntry)) {
    return false;
  }

  exportEntry.bun = nextBunEntry;
  return true;
}

function patchPackagedPluginSqlBunExports() {
  const packageJsonPath = path.join(
    nodeModulesDir,
    "@elizaos",
    "plugin-sql",
    "package.json",
  );
  const packageJson = readJsonIfExists(packageJsonPath);
  if (!packageJson || typeof packageJson !== "object") return false;

  const pluginSqlDir = path.dirname(packageJsonPath);
  const brokenBunEntry = packageJson.exports?.["."]?.bun?.import;
  if (
    brokenBunEntry !== "./src/index.ts" ||
    fs.existsSync(path.join(pluginSqlDir, brokenBunEntry))
  ) {
    return false;
  }

  const changed = [
    patchBunExportTarget(packageJson.exports, ".", {
      types: "./src/dist/index.node.d.ts",
      import: "./src/dist/node/index.node.js",
      default: "./src/dist/node/index.node.js",
    }),
    patchBunExportTarget(packageJson.exports, "./drizzle", {
      types: "./src/dist/drizzle/index.d.ts",
      import: "./src/dist/drizzle/index.js",
      default: "./src/dist/drizzle/index.js",
    }),
    patchBunExportTarget(packageJson.exports, "./schema", {
      types: "./src/dist/schema/index.d.ts",
      import: "./src/dist/schema/index.js",
      default: "./src/dist/schema/index.js",
    }),
  ].some(Boolean);

  if (!changed) return false;
  writeJson(packageJsonPath, packageJson);
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
const forced = forcedStubPackages.filter((packageName) =>
  ensureStubPackage(packageName, { force: true }),
);
const patchedCoreSandboxPolicy = patchPackagedCoreSandboxPolicyExports();
const patchedAppCore = patchPackagedAppCoreDevUi();
const patchedSandboxPolicy = patchPackagedAppCoreSandboxPolicy();
const patchedPluginSql = patchPackagedPluginSqlBunExports();
if (created.length === 0) {
  console.log(`${LOG_PREFIX} optional app stubs already present or installed.`);
} else {
  console.log(`${LOG_PREFIX} created ${created.length} optional app stub(s).`);
}
if (forced.length > 0) {
  console.log(
    `${LOG_PREFIX} replaced ${forced.length} optional connector package(s) with stubs.`,
  );
}
if (patchedAppCore) {
  console.log(`${LOG_PREFIX} patched packaged @elizaos/app-core dev-ui.`);
}
if (patchedCoreSandboxPolicy) {
  console.log(
    `${LOG_PREFIX} patched packaged @elizaos/core sandbox-policy exports.`,
  );
}
if (patchedSandboxPolicy) {
  console.log(
    `${LOG_PREFIX} patched packaged @elizaos/app-core sandbox-policy compatibility.`,
  );
}
if (patchedPluginSql) {
  console.log(
    `${LOG_PREFIX} patched packaged @elizaos/plugin-sql bun exports.`,
  );
}
