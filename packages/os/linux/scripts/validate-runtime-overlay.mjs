#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const distroRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const defaultStage = path.join(
  distroRoot,
  "tails/config/chroot_local-includes/usr/share/elizaos/elizaos-app",
);
const defaultOsOverlayRoot = path.join(
  distroRoot,
  "tails/config/chroot_local-includes",
);

function parseArgs(argv) {
  const parsed = {
    stage: process.env.ELIZAOS_APP_STAGE ?? defaultStage,
    osOverlayRoot: defaultOsOverlayRoot,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stage") {
      parsed.stage = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--stage=")) {
      parsed.stage = arg.slice("--stage=".length);
      continue;
    }
    if (arg === "--os-overlay-root") {
      parsed.osOverlayRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--os-overlay-root=")) {
      parsed.osOverlayRoot = arg.slice("--os-overlay-root=".length);
      continue;
    }
    if (!arg.startsWith("--")) {
      parsed.stage = arg;
    }
  }

  return {
    stage: path.resolve(parsed.stage),
    osOverlayRoot: path.resolve(parsed.osOverlayRoot),
  };
}

const { stage, osOverlayRoot } = parseArgs(args);
const manifestPath = path.join(
  stage,
  "Resources/app/elizaos-live-overlay-manifest.json",
);
const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${filePath}: cannot read JSON: ${error.message}`);
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`${filePath}: cannot read file: ${error.message}`);
    return "";
  }
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} missing: ${filePath}`);
    return false;
  }
  return true;
}

function assertExecutable(filePath, label) {
  if (!assertFile(filePath, label)) return;
  const mode = fs.statSync(filePath).mode;
  if ((mode & 0o111) === 0) {
    fail(`${label} is not executable: ${filePath}`);
  }
}

function assertContains(filePath, needle, label) {
  if (!assertFile(filePath, label)) return;
  const text = readText(filePath);
  if (!text.includes(needle)) {
    fail(`${label} does not contain ${JSON.stringify(needle)}: ${filePath}`);
  }
}

function walkFiles(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, visit);
    } else if (entry.isFile()) {
      visit(fullPath);
    }
  }
}

function packageDirectory(packageName) {
  return path.join(
    stage,
    "Resources/app/eliza-dist/node_modules",
    ...packageName.split("/"),
  );
}

function packageManifestPath(packageName) {
  return path.join(packageDirectory(packageName), "package.json");
}

function packageNameFromManifest(filePath, packageJson) {
  if (typeof packageJson?.name === "string" && packageJson.name) {
    return packageJson.name;
  }
  const relative = path.relative(
    path.join(stage, "Resources/app/eliza-dist/node_modules"),
    path.dirname(filePath),
  );
  const parts = relative.split(path.sep);
  if (parts[0]?.startsWith("@")) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? relative;
}

function relativeToStage(filePath) {
  return path.relative(stage, filePath).split(path.sep).join("/");
}

function validateEntrypoints(manifest) {
  for (const entry of manifest.entrypoints ?? []) {
    if (!entry.required) continue;
    const filePath = path.join(stage, entry.stagePath);
    if (entry.executable) {
      assertExecutable(filePath, entry.name);
    } else {
      assertFile(filePath, entry.name);
    }
  }

  for (const entry of manifest.osEntrypoints ?? []) {
    if (!entry.required) continue;
    const filePath = path.join(osOverlayRoot, entry.sourcePath);
    if (entry.executable) {
      assertExecutable(filePath, entry.name);
    } else {
      assertFile(filePath, entry.name);
    }
  }
}

function validateGeneratedStubs(manifest) {
  const explicitOptionalStubs = manifest.generated?.optionalPluginStubs ?? [];
  if (explicitOptionalStubs.length === 0) {
    fail("manifest does not explicitly enumerate optional plugin stubs");
  }

  for (const stub of explicitOptionalStubs) {
    const packagePath = path.join(stage, stub.packagePath);
    const indexPath = path.join(stage, stub.indexPath);
    if (!stub.generated) continue;
    const packageJson = readJson(packagePath);
    assertFile(indexPath, `${stub.packageName} stub entrypoint`);
    if (!packageJson) continue;
    if (packageJson.version !== "0.0.0-elizaos-live-stub") {
      fail(
        `${packagePath}: generated optional stub must use 0.0.0-elizaos-live-stub, got ${packageJson.version}`,
      );
    }
    if (packageJson.type !== "module") {
      fail(`${packagePath}: generated optional stub must be ESM`);
    }
    const index = readText(indexPath);
    if (!/\bexport\s+default\b/.test(index)) {
      fail(`${indexPath}: generated optional stub must have a default export`);
    }
  }

  const nodeModules = path.join(stage, "Resources/app/eliza-dist/node_modules");
  walkFiles(nodeModules, (filePath) => {
    if (path.basename(filePath) !== "package.json") return;
    const packageJson = readJson(filePath);
    if (packageJson?.version !== "0.0.0-elizaos-live-stub") return;
    const packageName = packageJson.name;
    const manifestEntry = explicitOptionalStubs.find(
      (stub) => stub.packageName === packageName,
    );
    const generatedEntry = (manifest.generated?.packages ?? []).find(
      (stub) => stub.packageName === packageName,
    );
    if (!manifestEntry && !generatedEntry) {
      fail(
        `${filePath}: live stub package is not declared in the runtime manifest`,
      );
    }
  });
}

function validatePackageInventory(manifest) {
  const nodeModules = path.join(stage, "Resources/app/eliza-dist/node_modules");
  let packageJsonCount = 0;
  const inventory = [];
  walkFiles(nodeModules, (filePath) => {
    if (path.basename(filePath) !== "package.json") return;
    packageJsonCount += 1;
    const packageJson = readJson(filePath);
    if (!packageJson) return;
    inventory.push({
      name: packageNameFromManifest(filePath, packageJson),
      version: packageJson.version ?? null,
      path: relativeToStage(filePath),
      private: packageJson.private === true,
      liveStub: packageJson.version === "0.0.0-elizaos-live-stub",
    });
  });
  inventory.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.path.localeCompare(right.path),
  );

  const manifestCount = manifest.packages?.packageJsonCount;
  if (typeof manifestCount !== "number") {
    fail("manifest packages.packageJsonCount is missing");
  } else if (manifestCount !== packageJsonCount) {
    fail(
      `manifest package count mismatch: manifest=${manifestCount}, actual=${packageJsonCount}`,
    );
  }

  const manifestInventory = manifest.packages?.inventory;
  if (!Array.isArray(manifestInventory)) {
    fail("manifest packages.inventory is missing");
    return;
  }
  const normalizedManifestInventory = manifestInventory
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version ?? null,
      path: pkg.path,
      private: pkg.private === true,
      liveStub: pkg.liveStub === true,
    }))
    .sort(
      (left, right) =>
        String(left.name).localeCompare(String(right.name)) ||
        String(left.path).localeCompare(String(right.path)),
    );
  if (
    JSON.stringify(normalizedManifestInventory) !== JSON.stringify(inventory)
  ) {
    fail("manifest package inventory does not match staged node_modules");
  }
}

function validateRepositoryResolution(manifest) {
  const forbidden = manifest.repositoryResolution
    ?.forbiddenHardCodedNeedles ?? [
    "github.com/elizaos/elizaos",
    'orgName:"elizaos"',
    'repoName:"eliza"',
    'docsUrl:"https://docs.elizaos.ai"',
    'appUrl:"https://app.elizaos.ai"',
  ];
  const scanRoots = [
    path.join(stage, "Resources/app/brand-config.json"),
    path.join(stage, "Resources/app/renderer/index.html"),
    path.join(stage, "Resources/app/renderer/site.webmanifest"),
    path.join(stage, "Resources/app/renderer/assets"),
  ];

  for (const scanRoot of scanRoots) {
    const scan = (filePath) => {
      const ext = path.extname(filePath);
      if (![".html", ".js", ".json", ".webmanifest"].includes(ext)) return;
      const text = readText(filePath);
      for (const needle of forbidden) {
        if (text.includes(needle)) {
          fail(
            `${filePath}: hard-coded elizaOS repo/app resolution remains: ${needle}`,
          );
        }
      }
    };

    if (!fs.existsSync(scanRoot)) continue;
    if (fs.statSync(scanRoot).isDirectory()) {
      walkFiles(scanRoot, scan);
    } else {
      scan(scanRoot);
    }
  }
}

function validatePorts(manifest) {
  const apiPort = manifest.expectedPorts?.api?.defaultPort;
  const rendererPort = manifest.expectedPorts?.renderer?.defaultPort;
  if (apiPort !== 31337) {
    fail(`manifest expected API port must be 31337, got ${apiPort}`);
  }
  if (rendererPort !== 5174) {
    fail(`manifest expected renderer port must be 5174, got ${rendererPort}`);
  }

  const liveLauncher = path.join(osOverlayRoot, "usr/local/bin/elizaos");
  const agentLauncher = path.join(
    osOverlayRoot,
    "usr/local/lib/elizaos/start-elizaos-agent-user",
  );
  const rendererLauncher = path.join(
    osOverlayRoot,
    "usr/local/lib/elizaos/start-elizaos-renderer-user",
  );
  const browserLauncher = path.join(
    osOverlayRoot,
    "usr/local/lib/elizaos/start-elizaos-browser-user",
  );
  const rendererServer = path.join(
    osOverlayRoot,
    "usr/local/lib/elizaos/renderer-server.mjs",
  );
  const webkitShell = path.join(
    osOverlayRoot,
    "usr/local/lib/elizaos/elizaos-webkit-shell",
  );

  for (const filePath of [
    liveLauncher,
    agentLauncher,
    rendererLauncher,
    browserLauncher,
  ]) {
    assertContains(filePath, `ELIZA_API_PORT:-${apiPort}`, "API port default");
  }
  for (const filePath of [rendererLauncher, browserLauncher]) {
    assertContains(
      filePath,
      `ELIZAOS_RENDERER_PORT:-${rendererPort}`,
      "renderer port default",
    );
  }
  assertContains(
    rendererServer,
    `|| "${rendererPort}"`,
    "renderer server port default",
  );
  assertContains(
    rendererServer,
    `|| "${apiPort}"`,
    "renderer server API default",
  );
  assertContains(
    webkitShell,
    `127.0.0.1:${rendererPort}`,
    "WebKit renderer URL",
  );
  assertContains(webkitShell, `127.0.0.1%3A${apiPort}`, "WebKit API URL");
}

function validateBranding() {
  const versionPath = path.join(stage, "Resources/version.json");
  const brandPath = path.join(stage, "Resources/app/brand-config.json");
  const version = readJson(versionPath);
  const brand = readJson(brandPath);

  if (version?.name !== "elizaOS") {
    fail(`${versionPath}: name must be elizaOS`);
  }
  if (version?.identifier !== "org.elizaos.app") {
    fail(`${versionPath}: identifier must be org.elizaos.app`);
  }
  for (const [key, expected] of Object.entries({
    appName: "elizaOS",
    appId: "org.elizaos.app",
    namespace: "eliza",
    urlScheme: "elizaos",
    configDirName: "elizaOS",
  })) {
    if (brand?.[key] !== expected) {
      fail(`${brandPath}: ${key} must be ${expected}`);
    }
  }
}

function validateRuntimeEntry() {
  const entryPath = path.join(stage, "Resources/app/eliza-dist/entry.js");
  const appCoreEntryPath = path.join(
    stage,
    "Resources/app/eliza-dist/node_modules/@elizaos/app-core/dist/entry.js",
  );
  assertFile(entryPath, "agent runtime entry");
  assertFile(appCoreEntryPath, "bundled app-core runtime entry");
  const entry = readText(entryPath);
  if (entry.includes("../packages/") || entry.includes("src/entry.ts")) {
    fail(
      `${entryPath}: live runtime entry must not point back to source checkout paths`,
    );
  }
  if (!entry.includes("./node_modules/@elizaos/app-core/dist/entry.js")) {
    fail(`${entryPath}: live runtime entry must import bundled app-core dist`);
  }
}

function validateAgentApiLazyWalletImport() {
  const filePath = path.join(
    stage,
    "Resources/app/eliza-dist/node_modules/@elizaos/agent/src/api/index.ts",
  );
  assertFile(filePath, "agent API barrel");
  const text = readText(filePath);
  if (!text.includes("export const handleWalletRoutes")) {
    fail(`${filePath}: agent API barrel must expose lazy handleWalletRoutes`);
  }
  if (!text.includes('await import("@elizaos/plugin-wallet")')) {
    fail(`${filePath}: wallet routes must be loaded lazily`);
  }
  if (text.includes("  handleWalletRoutes,\n  type WalletAddressesSnapshot")) {
    fail(`${filePath}: static plugin-wallet re-export must not return`);
  }
}

function validateSymlinks() {
  for (const [relativePath, target] of [
    ["node_modules", "Resources/app/eliza-dist/node_modules"],
    ["bin/node_modules", "../Resources/app/eliza-dist/node_modules"],
  ]) {
    const linkPath = path.join(stage, relativePath);
    if (!assertFile(linkPath, `${relativePath} dependency symlink`)) continue;
    let actual;
    try {
      actual = fs.readlinkSync(linkPath);
    } catch {
      fail(`${linkPath}: expected symlink to ${target}`);
      continue;
    }
    if (actual !== target) {
      fail(`${linkPath}: expected symlink to ${target}, got ${actual}`);
    }
  }
}

function validateRequiredRuntimePackages() {
  for (const packageName of [
    "agent-orchestrator",
    "@elizaos/plugin-agent-orchestrator",
    "@elizaos/plugin-app-control",
    "@elizaos/plugin-calendly",
    "@elizaos/plugin-health",
  ]) {
    assertFile(
      packageManifestPath(packageName),
      `${packageName} package manifest`,
    );
  }

  for (const [packageName, relativeFile] of [
    ["agent-orchestrator", "index.js"],
    ["@elizaos/plugin-agent-orchestrator", "index.js"],
    ["@elizaos/plugin-calendly", "dist/index.js"],
    ["@elizaos/plugin-health", "dist/index.js"],
  ]) {
    assertFile(
      path.join(packageDirectory(packageName), relativeFile),
      `${packageName} runtime file`,
    );
  }
}

if (!fs.existsSync(stage)) {
  fail(`runtime overlay stage does not exist: ${stage}`);
}
if (!fs.existsSync(manifestPath)) {
  fail(`runtime overlay manifest missing: ${manifestPath}`);
}

const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
if (manifest) {
  if (manifest.schemaVersion !== 1) {
    fail(`${manifestPath}: schemaVersion must be 1`);
  }
  if (!manifest.source?.gitCommit) {
    warn(`${manifestPath}: source git commit is not recorded`);
  }
  validateEntrypoints(manifest);
  validateGeneratedStubs(manifest);
  validatePackageInventory(manifest);
  validateRepositoryResolution(manifest);
  validatePorts(manifest);
  validateBranding();
  validateRuntimeEntry();
  validateAgentApiLazyWalletImport();
  validateSymlinks();
  validateRequiredRuntimePackages();
}

for (const message of warnings) {
  console.warn(`warning: ${message}`);
}

if (errors.length > 0) {
  for (const message of errors) {
    console.error(`error: ${message}`);
  }
  process.exit(1);
}

console.log(`Runtime overlay validated: ${stage}`);
