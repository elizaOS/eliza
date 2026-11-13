#!/usr/bin/env -S node --import tsx
/**
 * Release gate for the packaged app artifact: asserts required dist files
 * exist, runs an `npm pack` dry-run (skippable via the pack-dry-run policy) to
 * check the file list against forbidden prefixes, validates the static asset
 * manifest, and audits Apple Store entitlements.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReviewedAppleStoreEntitlements } from "./lib/apple-entitlement-audit.ts";
import {
  findLocalPackHotspots,
  shouldSkipExactPackDryRun,
} from "./lib/release-check-pack-dry-run";
import { validateStaticAssetManifest } from "./lib/static-asset-manifest.ts";

type PackFile = { path: string };
type PackResult = { files?: PackFile[] };

const requiredPaths = [
  "dist/index.js",
  "dist/entry.js",
  "dist/build-info.json",
  "packages/app/scripts",
];
const forbiddenPrefixes = ["dist/Eliza.app/"];
const orchestratorBrokenLifecycleTarget = "./scripts/ensure-node-pty.mjs";
const orchestratorPluginPackageJsonPathCandidates = [
  resolve("plugins", "plugin-agent-orchestrator", "package.json"),
  resolve(
    "node_modules",
    "@elizaos",
    "plugin-agent-orchestrator",
    "package.json",
  ),
] as const;
const autonomousElizaPathCandidates = [
  "node_modules/@elizaos/agent/src/runtime/eliza.js",
  "packages/agent/src/runtime/eliza.ts",
] as const;
const cdnValidationScriptPathCandidates = [
  "packages/app/scripts/validate-cdn-assets.ts",
  "scripts/validate-cdn-assets.ts",
] as const;
const cloudAgentTemplatePackageJsonPathCandidates = [
  "packages/app/deploy/cloud-agent-template/package.json",
] as const;
const agentPackageJsonPathCandidates = ["packages/agent/package.json"] as const;

function resolveExistingPath(candidates: readonly string[]) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveOrchestratorPluginPackageJsonPath() {
  return resolveExistingPath(orchestratorPluginPackageJsonPathCandidates);
}
const requiredRootPackageScriptSnippets: Record<string, readonly string[]> = {
  "release:check": ["scripts/run-release-check.ts"],
};
type RootPackageJson = {
  bundleDependencies?: string[];
  bundledDependencies?: string[];
  dependencies?: Record<string, string>;
  files?: string[];
  overrides?: Record<string, unknown>;
  scripts?: Record<string, string>;
};
const cloudAgentTemplateReleaseDependencies = [
  "@elizaos/core",
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-sql",
] as const;

/**
 * Returns true if the version specifier is an exact pinned version
 * (no range operators, no tags, no URLs).
 *
 * Accepted: "0.3.14", "1.0.0", "2.0.0-alpha.87"
 * Rejected: "^0.3.14", "~1.0.0", ">=1.0.0", "next", "latest", "*",
 *           "workspace:*", "npm:foo@1.0.0", "https://...", "git+..."
 */
export function isExactVersion(specifier: string): boolean {
  if (!specifier || specifier.length === 0) return false;
  // Reject range operators, tags, URLs, workspace protocol
  if (/^[~^>=<*]/.test(specifier)) return false;
  if (/^(workspace|npm|file|git\+|https?):/.test(specifier)) return false;
  // Must look like a semver: starts with a digit, contains only digits/dots/hyphens/alphanumeric
  return /^\d+\.\d+\.\d+/.test(specifier);
}

export function isWorkspaceSpecifier(specifier: string | undefined): boolean {
  return typeof specifier === "string" && specifier.startsWith("workspace:");
}

type DependencyPackageJson = {
  scripts?: Record<string, string>;
};

export function parseBunPackDryRunOutput(raw: string): PackResult[] {
  const files = raw
    .split("\n")
    .map((line) => line.match(/^packed\s+\S+\s+(.+)$/)?.[1]?.trim())
    .filter((path): path is string => Boolean(path))
    .map((path) => ({ path }));

  return [{ files }];
}

export function isNpmOverrideConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const execError = error as Error & {
    stdout?: string;
    stderr?: string;
  };
  const combinedOutput = `${execError.stdout ?? ""}\n${execError.stderr ?? ""}`;
  return combinedOutput.includes("EOVERRIDE");
}

export function sanitizeNpmOverridesForPack(pkg: RootPackageJson): {
  overrides?: Record<string, unknown>;
  removed: string[];
} {
  const overrides =
    pkg.overrides && typeof pkg.overrides === "object" ? pkg.overrides : {};
  const dependencies = pkg.dependencies ?? {};
  const sanitizedOverrides: Record<string, unknown> = {};
  const removed: string[] = [];

  for (const [name, value] of Object.entries(overrides)) {
    const directDependencySpecifier = dependencies[name];
    const removeBecauseOverrideUsesWorkspaceProtocol =
      typeof value === "string" && value.startsWith("workspace:");
    const removeBecauseDirectDependencyUsesWorkspaceProtocol =
      typeof directDependencySpecifier === "string" &&
      directDependencySpecifier.startsWith("workspace:");

    if (
      removeBecauseOverrideUsesWorkspaceProtocol ||
      removeBecauseDirectDependencyUsesWorkspaceProtocol
    ) {
      removed.push(name);
      continue;
    }

    sanitizedOverrides[name] = value;
  }

  if (removed.length === 0) {
    return { overrides: pkg.overrides, removed };
  }

  if (Object.keys(sanitizedOverrides).length === 0) {
    return { overrides: undefined, removed };
  }

  return { overrides: sanitizedOverrides, removed };
}

/**
 * Strip pack-incompatible root `package.json` override entries for the duration
 * of a callback, then restore the file byte-for-byte. Returns the callback's
 * result.
 *
 * Why: `npm pack --dry-run` validates `overrides` using npm's resolution rules.
 * That trips on two Eliza patterns:
 * - override entries that still use Bun's `workspace:*` protocol
 * - override entries for direct dependencies that themselves remain
 *   `workspace:*` in the root package
 *
 * Once npm exits with `EOVERRIDE`, the old fallback — `bun pm pack --dry-run`
 * — can still hit Bun 1.3.11's lockfile parser bug in CI. Neutralizing the
 * incompatible override entries only while `npm pack` is running sidesteps both
 * issues without touching the committed `bun.lock` or the runtime `package.json`.
 */
function withSanitizedNpmOverrides<T>(fn: () => T): T {
  const pkgPath = resolve("package.json");
  if (!existsSync(pkgPath)) {
    return fn();
  }

  const originalRaw = readFileSync(pkgPath, "utf8");
  let pkg: RootPackageJson & Record<string, unknown>;
  try {
    pkg = JSON.parse(originalRaw) as RootPackageJson & Record<string, unknown>;
  } catch {
    return fn();
  }

  if (!pkg.overrides || typeof pkg.overrides !== "object") {
    return fn();
  }

  const { overrides, removed } = sanitizeNpmOverridesForPack(pkg);
  if (removed.length === 0) {
    return fn();
  }

  const sanitizedPkg = { ...pkg };
  if (overrides && Object.keys(overrides).length > 0) {
    sanitizedPkg.overrides = overrides;
  } else {
    delete sanitizedPkg.overrides;
  }
  const hasTrailingNewline = originalRaw.endsWith("\n");
  const sanitizedRaw =
    JSON.stringify(sanitizedPkg, null, 2) + (hasTrailingNewline ? "\n" : "");

  writeFileSync(pkgPath, sanitizedRaw);
  try {
    return fn();
  } finally {
    // Always restore byte-for-byte, even on error.
    writeFileSync(pkgPath, originalRaw);
  }
}

function runBunPackDry(): PackResult[] {
  try {
    const raw = execSync("bun pm pack --dry-run --ignore-scripts", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 100,
    });
    return parseBunPackDryRunOutput(raw);
  } catch (bunError) {
    const bunOutput = `${(bunError as { stdout?: string }).stdout ?? ""}\n${
      (bunError as { stderr?: string }).stderr ?? ""
    }`;
    if (
      bunOutput.includes("Duplicate package path") ||
      bunOutput.includes("InvalidPackageKey")
    ) {
      console.warn(
        "release-check: bun pm pack --dry-run failed with a known Bun 1.3.11 lockfile parser error; returning empty file list (CI contract suite will still validate workflow snippets).",
      );
      return [{ files: [] }];
    }
    throw bunError;
  }
}

function runPackDry(): PackResult[] {
  return withSanitizedNpmOverrides(() => {
    try {
      const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 100,
      });
      return JSON.parse(raw) as PackResult[];
    } catch (error) {
      if (!isNpmOverrideConflictError(error)) {
        console.warn(
          "release-check: npm pack --dry-run failed without an override conflict; retrying with bun pm pack --dry-run.",
        );
      }

      // Fallback when npm pack cannot materialize the publish snapshot.
      // In CI rewrite mode npm can fail without surfacing a diagnostic,
      // while `bun pm pack --dry-run` still returns the publish file list.
      return runBunPackDry();
    }
  });
}

export function isPackPathCoveredByFilesList(
  packPath: string,
  filesList: string[],
): boolean {
  const normalizedPath = packPath.replaceAll("\\", "/");
  return filesList.some((entry) => {
    const normalizedEntry = entry.replaceAll("\\", "/").replace(/\/$/, "");
    return (
      normalizedPath === normalizedEntry ||
      normalizedPath.startsWith(`${normalizedEntry}/`)
    );
  });
}

export function doesPackedOutputContainPath(
  requiredPath: string,
  packedPaths: string[],
): boolean {
  const normalizedRequiredPath = requiredPath.replaceAll("\\", "/");
  return packedPaths.some((entry) => {
    const normalizedEntry = entry.replaceAll("\\", "/").replace(/\/$/, "");
    return (
      normalizedEntry === normalizedRequiredPath ||
      normalizedEntry.startsWith(`${normalizedRequiredPath}/`)
    );
  });
}

export function bundlesDependency(
  pkg: RootPackageJson,
  dependencyName: string,
): boolean {
  const bundled = [
    ...(pkg.bundleDependencies ?? []),
    ...(pkg.bundledDependencies ?? []),
  ];
  return bundled.includes(dependencyName);
}

export function isExactVersionSpecifier(
  versionSpecifier: string | undefined,
): boolean {
  if (typeof versionSpecifier !== "string") {
    return false;
  }

  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
    versionSpecifier,
  );
}

export function hasLifecycleScriptReferencingMissingFile(
  pkg: DependencyPackageJson,
  packageDir: string,
  scriptName: string,
  relativeTarget: string,
  pathExists: (candidate: string) => boolean = existsSync,
): boolean {
  const lifecycleCommand = pkg.scripts?.[scriptName];
  if (
    typeof lifecycleCommand !== "string" ||
    !lifecycleCommand.includes(relativeTarget)
  ) {
    return false;
  }

  return !pathExists(resolve(packageDir, relativeTarget));
}

export function findFloatingDependencySpecs(
  pkg: RootPackageJson,
  dependencyNames: readonly string[],
): Array<{ name: string; specifier: string }> {
  const dependencies = pkg.dependencies ?? {};

  return dependencyNames.flatMap((name) => {
    const specifier = dependencies[name];
    if (!isExactVersionSpecifier(specifier)) {
      return [{ name, specifier: specifier ?? "<missing>" }];
    }

    return [];
  });
}

export function findNonWorkspaceDependencySpecs(
  pkg: RootPackageJson,
  dependencyNames: readonly string[],
): Array<{ name: string; specifier: string }> {
  const dependencies = pkg.dependencies ?? {};

  return dependencyNames.flatMap((name) => {
    const specifier = dependencies[name];
    if (specifier !== "workspace:*") {
      return [{ name, specifier: specifier ?? "<missing>" }];
    }

    return [];
  });
}

export function findMismatchedSharedAgentDependencySpecs(
  rootPkg: RootPackageJson,
  agentPkg: RootPackageJson,
): Array<{ name: string; rootSpecifier: string; agentSpecifier: string }> {
  const rootDependencies = rootPkg.dependencies ?? {};
  const agentDependencies = agentPkg.dependencies ?? {};

  return Object.entries(agentDependencies).flatMap(([name, agentSpecifier]) => {
    if (!name.startsWith("@elizaos/")) {
      return [];
    }

    const rootSpecifier = rootDependencies[name];
    if (
      typeof rootSpecifier !== "string" ||
      !isExactVersionSpecifier(rootSpecifier)
    ) {
      return [];
    }

    if (agentSpecifier === rootSpecifier) {
      return [];
    }

    return [{ name, rootSpecifier, agentSpecifier }];
  });
}

function readExistingReleaseCheckFile(
  label: string,
  candidates: readonly string[],
): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, "utf8");
    }
  }

  console.error(`release-check: could not find ${label}. Checked:`);
  for (const candidate of candidates) {
    console.error(`  - ${candidate}`);
  }
  process.exit(1);
}

function runFastLocalPackCheck(hotspots: string[]) {
  console.warn(
    "release-check: skipping exact npm pack --dry-run because build artifacts are present and package.json whitelists broad build directories:",
  );
  for (const hotspot of hotspots) {
    console.warn(`  - ${hotspot}`);
  }
  console.warn(
    "release-check: package.json files includes 'dist' and 'packages/app/web-dist', so a local pack dry-run has to walk those trees. Set ELIZA_FORCE_PACK_DRY_RUN=1 to run the exact pack check anyway.",
  );

  const rootPackage = JSON.parse(
    readFileSync("package.json", "utf8"),
  ) as RootPackageJson;
  const includedFiles = rootPackage.files ?? [];
  const missing = requiredPaths.filter((path) => !existsSync(path));
  const uncovered = requiredPaths.filter(
    (path) => !isPackPathCoveredByFilesList(path, includedFiles),
  );
  const forbidden = forbiddenPrefixes.filter((prefix) =>
    existsSync(prefix.replace(/\/$/, "")),
  );

  if (missing.length > 0 || uncovered.length > 0 || forbidden.length > 0) {
    if (missing.length > 0) {
      console.error("release-check: missing files in publish roots:");
      for (const path of missing) {
        console.error(`  - ${path}`);
      }
    }
    if (uncovered.length > 0) {
      console.error(
        "release-check: package.json files does not whitelist required publish files:",
      );
      for (const path of uncovered) {
        console.error(`  - ${path}`);
      }
    }
    if (forbidden.length > 0) {
      console.error("release-check: forbidden files present in publish roots:");
      for (const prefix of forbidden) {
        console.error(`  - ${prefix}`);
      }
    }
    process.exit(1);
  }

  console.log("release-check: local publish-root sanity check looks OK.");
}

function assertBundledAgentOrchestratorInstallFix() {
  const rootPackage = JSON.parse(
    readFileSync("package.json", "utf8"),
  ) as RootPackageJson;
  const orchestratorPluginPackageJsonPath =
    resolveOrchestratorPluginPackageJsonPath();
  if (!bundlesDependency(rootPackage, "@elizaos/plugin-agent-orchestrator")) {
    console.error(
      "release-check: package.json must bundle @elizaos/plugin-agent-orchestrator so packaged Eliza includes the standalone orchestrator implementation.",
    );
    process.exit(1);
  }

  if (!orchestratorPluginPackageJsonPath) {
    console.error(
      "release-check: @elizaos/plugin-agent-orchestrator/package.json is missing from all expected locations.",
    );
    for (const candidate of orchestratorPluginPackageJsonPathCandidates) {
      console.error(`  - ${candidate}`);
    }
    process.exit(1);
  }

  const orchestratorPackage = JSON.parse(
    readFileSync(orchestratorPluginPackageJsonPath, "utf8"),
  ) as DependencyPackageJson;
  if (!orchestratorPackage.dependencies?.["coding-agent-adapters"]) {
    console.error(
      "release-check: @elizaos/plugin-agent-orchestrator must list coding-agent-adapters.",
    );
    process.exit(1);
  }
  if (
    hasLifecycleScriptReferencingMissingFile(
      orchestratorPackage,
      dirname(orchestratorPluginPackageJsonPath),
      "postinstall",
      orchestratorBrokenLifecycleTarget,
    )
  ) {
    console.error(
      "release-check: @elizaos/plugin-agent-orchestrator references scripts/ensure-node-pty.mjs in postinstall, but that file is missing under packages/scripts/plugins/plugin-agent-orchestrator/.",
    );
    process.exit(1);
  }
}
function assertOrchestratorVersionPinned() {
  const appPackage = JSON.parse(
    readFileSync("packages/app/package.json", "utf8"),
  ) as RootPackageJson;
  const orchestratorPluginPackageJsonPath =
    resolveOrchestratorPluginPackageJsonPath();
  const version =
    appPackage.dependencies?.["@elizaos/plugin-agent-orchestrator"];
  if (!version) {
    console.error(
      "release-check: @elizaos/plugin-agent-orchestrator is not in app dependencies.",
    );
    process.exit(1);
  }
  if (isWorkspaceSpecifier(version)) {
    if (!orchestratorPluginPackageJsonPath) {
      console.error(
        "release-check: @elizaos/plugin-agent-orchestrator is configured as workspace:*, but no local package.json was found.",
      );
      for (const candidate of orchestratorPluginPackageJsonPathCandidates) {
        console.error(`  - ${candidate}`);
      }
      process.exit(1);
    }
    return;
  }
  if (!isExactVersion(version) && !["beta", "beta"].includes(version)) {
    console.error(
      `release-check: @elizaos/plugin-agent-orchestrator must either use workspace:* for the local checkout, use a release dist tag, or be pinned to an exact version, but found "${version}".`,
    );
    process.exit(1);
  }
}

function assertCloudAgentTemplateDependenciesUseWorkspace() {
  const cloudAgentPackage = JSON.parse(
    readExistingReleaseCheckFile(
      "cloud agent template package.json",
      cloudAgentTemplatePackageJsonPathCandidates,
    ),
  ) as RootPackageJson;
  const nonWorkspace = findNonWorkspaceDependencySpecs(
    cloudAgentPackage,
    cloudAgentTemplateReleaseDependencies,
  );

  if (nonWorkspace.length > 0) {
    console.error(
      "release-check: packages/app/deploy/cloud-agent-template/package.json must use workspace:* for repo-local elizaOS dependencies. Materialize exact npm versions only at the deploy/publish boundary.",
    );
    for (const dependency of nonWorkspace) {
      console.error(`  - ${dependency.name}: ${dependency.specifier}`);
    }
    process.exit(1);
  }
}

function assertAgentDependenciesAlignedWithRootPins() {
  const rootPackage = JSON.parse(
    readFileSync("package.json", "utf8"),
  ) as RootPackageJson;
  const agentPackage = JSON.parse(
    readExistingReleaseCheckFile(
      "agent package.json",
      agentPackageJsonPathCandidates,
    ),
  ) as RootPackageJson;
  const mismatches = findMismatchedSharedAgentDependencySpecs(
    rootPackage,
    agentPackage,
  );

  if (mismatches.length > 0) {
    console.error(
      "release-check: packages/agent must match the root's exact @elizaos/* pins to avoid alpha tag drift on clean installs.",
    );
    for (const mismatch of mismatches) {
      console.error(
        `  - ${mismatch.name}: packages/agent=${mismatch.agentSpecifier} root=${mismatch.rootSpecifier}`,
      );
    }
    process.exit(1);
  }
}

function assertRequiredRootPackageScripts() {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const scripts = packageJson.scripts ?? {};
  const missing: string[] = [];

  for (const [scriptName, requiredSnippets] of Object.entries(
    requiredRootPackageScriptSnippets,
  )) {
    const scriptBody = scripts[scriptName];
    if (typeof scriptBody !== "string") {
      missing.push(`${scriptName} (missing script)`);
      continue;
    }
    for (const snippet of requiredSnippets) {
      if (!scriptBody.includes(snippet)) {
        missing.push(`${scriptName}: ${snippet}`);
      }
    }
  }

  if (missing.length > 0) {
    console.error(
      "release-check: package.json is missing required release/audit script wiring:",
    );
    for (const entry of missing) {
      console.error(`  - ${entry}`);
    }
    process.exit(1);
  }
}

function assertStartApiServerCatchBlockSafety() {
  const elizaSource = readExistingReleaseCheckFile(
    "autonomous runtime source",
    autonomousElizaPathCandidates,
  );

  // The catch block around startApiServer must use console.error so errors
  // are visible in packaged builds.
  if (!elizaSource.includes("console.error(apiErrMsg)")) {
    console.error(
      "release-check: eliza.ts startApiServer catch block must use console.error(apiErrMsg) so errors are visible in packaged builds.",
    );
    process.exit(1);
  }

  // In server-only mode, a failed API server must be fatal.
  const catchIndex = elizaSource.indexOf("catch (apiErr)");
  if (catchIndex === -1) {
    console.error(
      "release-check: eliza.ts must have a catch (apiErr) block around startApiServer.",
    );
    process.exit(1);
  }
  const catchBlock = elizaSource.slice(
    catchIndex,
    elizaSource.indexOf("// ── Server-only mode", catchIndex),
  );
  if (
    !(
      catchBlock.includes("opts?.serverOnly") ||
      catchBlock.includes("options?.serverOnly")
    ) ||
    !catchBlock.includes(
      'throw new ElizaError("API server is required in server-only mode"',
    ) ||
    !catchBlock.includes('code: "AGENT_API_START_FAILED"') ||
    !catchBlock.includes('severity: "fatal"')
  ) {
    console.error(
      "release-check: eliza.ts startApiServer catch block must throw a fatal AGENT_API_START_FAILED ElizaError in server-only mode.",
    );
    process.exit(1);
  }
}

function maybeValidateCdnAssets() {
  if (process.env.ELIZA_VALIDATE_CDN !== "1") {
    return;
  }

  const cdnValidationScriptPath = resolveExistingPath(
    cdnValidationScriptPathCandidates,
  );
  if (!cdnValidationScriptPath) {
    console.error(
      `release-check: CDN validation script is missing. Checked: ${cdnValidationScriptPathCandidates.join(", ")}`,
    );
    process.exit(1);
  }

  execSync(`node ${JSON.stringify(cdnValidationScriptPath)}`, {
    stdio: "inherit",
    env: process.env,
  });
}

function assertStaticAssetManifestIsCurrent() {
  const result = validateStaticAssetManifest(process.cwd());
  if (result.ok) {
    return;
  }

  console.error(
    `release-check: static asset manifest is ${result.reason}. Run bun packages/app/scripts/generate-static-asset-manifest.ts.`,
  );
  console.error(`  - ${result.manifestPath}`);
  process.exit(1);
}

function assertAppleStoreEntitlementsReviewed() {
  try {
    assertReviewedAppleStoreEntitlements();
  } catch (error) {
    console.error(
      `release-check: Apple store entitlement audit failed:\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}

function main() {
  assertRequiredRootPackageScripts();
  assertAppleStoreEntitlementsReviewed();
  assertStartApiServerCatchBlockSafety();
  assertStaticAssetManifestIsCurrent();
  maybeValidateCdnAssets();
  assertBundledAgentOrchestratorInstallFix();
  assertOrchestratorVersionPinned();
  assertCloudAgentTemplateDependenciesUseWorkspace();
  assertAgentDependenciesAlignedWithRootPins();
  const localHotspots = findLocalPackHotspots();
  if (shouldSkipExactPackDryRun(localHotspots)) {
    runFastLocalPackCheck(localHotspots);
    return;
  }
  const results = runPackDry();
  const files = results.flatMap((entry) => entry.files ?? []);
  const packedPaths = files.map((file) => file.path);

  const missing = requiredPaths.filter(
    (path) => !doesPackedOutputContainPath(path, packedPaths),
  );
  const forbidden = packedPaths.filter((path) =>
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
  );

  if (missing.length > 0 || forbidden.length > 0) {
    if (missing.length > 0) {
      console.error("release-check: missing files in npm pack:");
      for (const path of missing) {
        console.error(`  - ${path}`);
      }
    }
    if (forbidden.length > 0) {
      console.error("release-check: forbidden files in npm pack:");
      for (const path of forbidden) {
        console.error(`  - ${path}`);
      }
    }
    process.exit(1);
  }

  console.log("release-check: npm pack contents look OK.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
