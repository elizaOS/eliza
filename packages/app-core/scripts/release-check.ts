#!/usr/bin/env -S node --import tsx

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findLocalPackHotspots,
  shouldSkipExactPackDryRun,
} from "./lib/release-check-pack-dry-run";
import { validateStaticAssetManifest } from "./lib/static-asset-manifest.mjs";

type PackFile = { path: string };
type PackResult = { files?: PackFile[] };

const requiredPaths = [
  "dist/index.js",
  "dist/entry.js",
  "dist/build-info.json",
  "eliza/packages/app-core/scripts",
  "scripts/setup-upstreams.mjs",
  "scripts/init-submodules.mjs",
];
const forbiddenPrefixes = ["dist/Eliza.app/"];
const orchestratorBrokenLifecycleTarget = "./scripts/ensure-node-pty.mjs";
const orchestratorPluginPackageJsonPathCandidates = [
  resolve("eliza", "plugins", "plugin-agent-orchestrator", "package.json"),
  resolve(
    ".eliza.ci-disabled",
    "plugins",
    "plugin-agent-orchestrator",
    "package.json",
  ),
  resolve(
    "node_modules",
    "@elizaos",
    "plugin-agent-orchestrator",
    "package.json",
  ),
] as const;
const autonomousServerPathCandidates = [
  "node_modules/@elizaos/agent/src/api/server.js",
  "eliza/packages/agent/src/api/server.ts",
] as const;
const autonomousElizaPathCandidates = [
  "node_modules/@elizaos/agent/src/runtime/eliza.js",
  "eliza/packages/agent/src/runtime/eliza.ts",
] as const;
const homepageReleaseDataPathCandidates = [
  "apps/homepage/src/generated/release-data.ts",
] as const;

function resolveExistingPath(candidates: readonly string[]) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveOrchestratorPluginPackageJsonPath() {
  return resolveExistingPath(orchestratorPluginPackageJsonPathCandidates);
}
const requiredWorkflowSnippets = [
  'BUN_VERSION: "1.3.13"',
  "workflow_call:",
  "name: Validate Release Inputs",
  "Manual branch dispatches must provide inputs.tag; refusing to derive a release tag from package.json.",
  "bun-version: $" + "{{ env.BUN_VERSION }}",
  "name: Regression matrix contract",
  "run: bun run test:regression-matrix:release",
  "name: Run heavy E2E regression suite",
  "run: bun run test:e2e:heavy",
  "name: Run optional cloud live regression suite",
  'if bun run test:live:cloud 2>&1 | tee "$log_file"; then',
  "name: Restore build metadata after test rebuilds",
  "name: Release readiness checks",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression
  "ELIZA_RELEASE_TAG: ${{ needs.prepare.outputs.tag }}",
  'ELIZA_VALIDATE_CDN: "1"',
  "run: bun run release:check",
  "build-browser-companions:",
  "name: Build Agent Browser Bridge companions",
  "if bun run browser-bridge:package:release; then",
  'echo "packaged=true" >> "$GITHUB_OUTPUT"',
  "Agent Browser Bridge packaging failed; desktop release will continue without browser companion bundles.",
  "name: Upload Agent Browser Bridge release artifacts",
  "name: browser-bridge-store-bundles",
  "publish-browser-companions:",
  "name: Publish Agent Browser Bridge companions",
  "name: Attach Agent Browser Bridge assets to GitHub release",
  "GH_REPO: ${{ github.repository }}",
  "gh release upload",
  '--repo "$GH_REPO"',
  "for attempt in 1 2 3; do",
  `bun install failed on attempt \${attempt}; retrying in 15 seconds`,
  "name: Ensure avatar assets",
  "node eliza/packages/app-core/scripts/ensure-avatars.mjs",
  "name: Prepare Whisper model artifact",
  "bash eliza/packages/app-core/platforms/electrobun/scripts/ensure-whisper-model.sh base.en",
  "name: Upload Whisper model artifact",
  "name: whisper-model-base-en",
  "Install quiet macOS packaging wrappers",
  "packages/app-core/platforms/electrobun/scripts/hdiutil-wrapper.sh",
  "packages/app-core/platforms/electrobun/scripts/xcrun-wrapper.sh",
  "packages/app-core/platforms/electrobun/scripts/zip-wrapper.sh",
  "ELECTROBUN_REAL_HDIUTIL: /usr/bin/hdiutil",
  "ELECTROBUN_REAL_XCRUN: /usr/bin/xcrun",
  "ELECTROBUN_REAL_ZIP: /usr/bin/zip",
  "name: Download Whisper model artifact",
  "name: Seed Whisper model cache",
  "Stage desktop bundle inputs",
  "node eliza/packages/app-core/scripts/desktop-build.mjs stage --variant=base --build-whisper",
  "Inject version.json into bundle (Windows)",
  "Inject version.json into bundle (macOS / Linux)",
  '"identifier":"ai.elizaos.Eliza"',
  "Stage standard macOS release app",
  "packages/app-core/platforms/electrobun/scripts/stage-macos-release-artifacts.sh",
  "retry_stapler_validate()",
  "Smoke test packaged macOS app",
  "SMOKE_DIAGNOSTICS_DIR:",
  "SKIP_BUILD=1",
  "bun run test:desktop:packaged",
  "Upload macOS smoke diagnostics",
  "wrapper-diagnostics.json",
  "Install Inno Setup 6.7.1",
  "Downloading Inno Setup 6.7.1...",
  "https://github.com/jrsoftware/issrc/releases/download/is-6_7_1/innosetup-6.7.1.exe",
  "Start-Process -FilePath $installer",
  "Extract Windows app bundle for Inno Setup",
  '$extractDir = "C:\\e"',
  "eliza-dist/entry.js found",
  "Build Inno Setup installer",
  "packaging/inno/build-inno.ps1",
  '-BuildDir "C:\\e"',
  "Verify Windows public installer looks complete",
  'Get-ChildItem -Path "eliza/packages/app-core/platforms/electrobun/artifacts" -File -Filter "ElizaOSApp-Setup-*.exe"',
  "$minimumBytes = 50MB",
  "packages/app-core/platforms/electrobun/artifacts/*.exe",
  "name: Prepare public canary Windows installer artifact",
  "needs.prepare.outputs.env == 'canary'",
  '$publicCanaryDir = Join-Path $artifactsDir "public-canary-installer"',
  '$canonicalInstallers = Get-ChildItem -Path $artifactsDir -File -Filter "ElizaOSApp-Setup-*.exe"',
  "Copy-Item $canonicalInstaller.FullName -Destination $publicCanaryDir -Force",
  '$canonicalInstallerZips = Get-ChildItem -Path $artifactsDir -File -Filter "ElizaOSApp-Setup-*.exe.zip"',
  "No canonical Windows installer (or zip fallback) found for canary artifact publishing.",
  "Expand-Archive -Path $canonicalInstallerZip.FullName -DestinationPath $publicCanaryDir -Force",
  "Prepared public canary installer artifact:",
  "name: Upload public canary installer artifact",
  "name: electrobun-$" + "{{ matrix.platform.artifact-name }}-public-installer",
  "path: eliza/packages/app-core/platforms/electrobun/artifacts/public-canary-installer/ElizaOSApp-Setup-*.exe",
  "name: Collect public release files",
  '-name "ElizaOSApp-Setup-*.exe" -o \\',
  '-name "ElizaOSApp-Setup-*.exe.zip" -o \\',
  '-name "*Setup*.tar.gz" -o \\',
  "name: Collect update channel files",
  "pattern: browser-bridge-*",
  '-name "*.tar.zst" -o \\',
  '-name "*-update.json" \\',
  "DMG attach attempt $attempt/5 failed",
  "name: Resolve electrobun package dir",
  "id: resolve-electrobun",
  'const workspacePackageJson = path.resolve("eliza/packages/app-core/platforms/electrobun/package.json");',
  'const entryPath = req.resolve("electrobun");',
  "Could not find electrobun package.json starting from",
  "Resolved unexpected package at",
  'echo "package-dir=$package_dir"',
  'echo "cache-dir=$package_dir/.cache"',
  "$" + "{{ steps.resolve-electrobun.outputs.cache-dir }}",
  "name: Build patched Electrobun CLI",
  'node eliza/packages/app-core/scripts/build-patched-electrobun-cli.mjs "$' +
    '{{ steps.resolve-electrobun.outputs.package-dir }}"',
  '"${{ matrix.platform.artifact-name }}"',
  "node eliza/packages/app-core/scripts/desktop-build.mjs package --env=$" +
    "{{ needs.prepare.outputs.env }}",
  "ELIZA_ELECTROBUN_NOTARIZE: 0",
  'ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1"',
  'ELIZA_WINDOWS_SMOKE_REQUIRE_INSTALLER: "1"',
  "ELIZA_TEST_WINDOWS_INSTALL_DIR: $" + "{{ runner.temp }}\\el",
  "name: Run Windows clean installer proof",
  "verify-windows-installer-proof.ps1",
  "ELIZA_TEST_WINDOWS_PROOF_INSTALL_DIR: $" + "{{ runner.temp }}\\el-proof",
  "name: Upload Windows installer proof artifact",
  "path: eliza/packages/app-core/platforms/electrobun/artifacts/windows-installer-proof/**",
  "if: always() && matrix.platform.os == 'windows'",
  "ANTHROPIC_API_KEY: $" + "{{ secrets.ANTHROPIC_API_KEY }}",
  "ELIZAOS_CLOUD_API_KEY: $" +
    "{{ secrets.ELIZAOS_CLOUD_API_KEY != '' && secrets.ELIZAOS_CLOUD_API_KEY || secrets.ELIZACLOUD_API_KEY }}",
  "ELIZAOS_CLOUD_BASE_URL: $" + "{{ secrets.ELIZAOS_CLOUD_BASE_URL }}",
  "bun run test:desktop:packaged:windows",
  'Write-Error "Packaged Windows smoke test exited with code $LASTEXITCODE."',
  "bun run test:desktop:playwright",
];
const _requiredPatchedElectrobunCliSnippets = [
  "https://github.com/blackboardsh/electrobun.git",
  '"sparse-checkout", "set", "package"',
  'writeGitHubEnv("ELECTROBUN_RCEDIT_PACKAGE_JSON", resolvedRceditPackageJson);',
  'const overridePackageJson = process.env["ELECTROBUN_RCEDIT_PACKAGE_JSON"];',
  'const overrideEntry = overrideRequire.resolve("rcedit");',
  "function resolveBuildTarget(value) {",
  "--target=${buildTarget.bunTarget}",
  "[electrobun-build] Bun entry:",
  "targetPaths.BUN_BINARY",
  "Bun CLI fallback succeeded",
  "const installedBinPath = path.join(",
  "const installedCachePath = path.join(",
];

export function findMissingPatchedElectrobunCliSnippets(
  source: string,
): string[] {
  return _requiredPatchedElectrobunCliSnippets.filter(
    (snippet) => !source.includes(snippet),
  );
}

export function findMissingRequiredSnippets(
  content: string,
  snippets: readonly string[],
): string[] {
  return snippets.filter((snippet) => !content.includes(snippet));
}

const forbiddenWorkflowSnippets = [
  ' -name "*.exe" -o \\',
  'bun install -g "rcedit@4.0.1"',
  "name: Cache Bun install",
  "path: ~/.bun/install/cache",
  "restore-keys: bun-electrobun-validate-",
  "restore-keys: bun-electrobun-$" +
    "{{ matrix.platform.artifact-name }}" +
    "-",
  "key: bun-electrobun-validate-$" + "{{ hashFiles('bun.lock') }}",
  "key: bun-electrobun-$" +
    "{{ matrix.platform.artifact-name }}" +
    "-$" +
    "{{ hashFiles('bun.lock') }}",
  `TAG="v$(node -p "require('./package.json').version")"`,
  "name: Ensure Windows rcedit binary is available for Electrobun",
  "name: Pre-extract electrobun native CLI on Windows",
  "https://api.github.com/repos/blackboardsh/electrobun/releases/tags/v$version",
  "electrobun CLI checksum mismatch",
  '$extractionBases = @("D:\\a\\electrobun\\electrobun\\package")',
];
const requiredElectrobunPrWorkflowSnippets = [
  "name: Validate Electrobun Release Workflow",
  "pull_request:",
  "branches: [main, develop]",
  "workflow_dispatch:",
  "permissions:",
  "contents: read",
  'BUN_VERSION: "1.3.13"',
  "name: Release Workflow Contract",
  "bun install --ignore-scripts",
  "bun run postinstall",
  "bun run test:regression-matrix:release-contract",
  "bun run test:release:contract",
];
const forbiddenElectrobunPrWorkflowSnippets = [
  "uses: ./.github/workflows/release-electrobun.yml",
  "publish_release: false",
  "publish_docker: false",
  "draft: false",
  "secrets: inherit",
  "packages: write",
];
const requiredElectrobunConfigSnippets = [
  'postBuild: "scripts/postwrap-sign-runtime-macos.ts"',
  'postWrap: "scripts/postwrap-diagnostics.ts"',
  "process.env.ELIZA_ELECTROBUN_NOTARIZE !==",
  "[repoPluginsJsonPath]: `${runtimeDistDir}/plugins.json`",
  "[repoPackageJsonPath]: `${runtimeDistDir}/package.json`",
];
const electrobunDirCandidates = [
  resolve("packages", "app-core", "platforms", "electrobun"),
  resolve("eliza", "packages", "app-core", "platforms", "electrobun"),
  resolve("apps", "app", "electrobun"),
];

function resolveElectrobunPath(...segments: string[]) {
  for (const candidate of electrobunDirCandidates) {
    const targetPath = resolve(candidate, ...segments);
    if (existsSync(targetPath)) {
      return targetPath;
    }
  }

  return resolve(electrobunDirCandidates[0]!, ...segments);
}

function readElectrobunFile(...segments: string[]) {
  return readFileSync(resolveElectrobunPath(...segments), "utf8");
}

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
    "release-check: package.json files includes 'dist' and 'packages/app/dist', so a local pack dry-run has to walk those trees. Set ELIZA_FORCE_PACK_DRY_RUN=1 to run the exact pack check anyway.",
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
      "release-check: @elizaos/plugin-agent-orchestrator references scripts/ensure-node-pty.mjs in postinstall, but that file is missing under eliza/plugins/plugin-agent-orchestrator/scripts/.",
    );
    process.exit(1);
  }
}
function assertOrchestratorVersionPinned() {
  const rootPackage = JSON.parse(
    readFileSync("package.json", "utf8"),
  ) as RootPackageJson;
  const orchestratorPluginPackageJsonPath =
    resolveOrchestratorPluginPackageJsonPath();
  const version =
    rootPackage.dependencies?.["@elizaos/plugin-agent-orchestrator"];
  if (!version) {
    console.error(
      "release-check: @elizaos/plugin-agent-orchestrator is not in dependencies.",
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
  if (!isExactVersion(version)) {
    console.error(
      `release-check: @elizaos/plugin-agent-orchestrator must either use workspace:* for the local checkout or be pinned to an exact version, but found "${version}".`,
    );
    process.exit(1);
  }
}

function assertCloudAgentTemplateDependenciesUseWorkspace() {
  const cloudAgentPackage = JSON.parse(
    readFileSync(
      "eliza/packages/app-core/deploy/cloud-agent-template/package.json",
      "utf8",
    ),
  ) as RootPackageJson;
  const nonWorkspace = findNonWorkspaceDependencySpecs(
    cloudAgentPackage,
    cloudAgentTemplateReleaseDependencies,
  );

  if (nonWorkspace.length > 0) {
    console.error(
      "release-check: eliza/packages/app-core/deploy/cloud-agent-template/package.json must use workspace:* for repo-local elizaOS dependencies. Materialize exact npm versions only at the deploy/publish boundary.",
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
    readFileSync("eliza/packages/agent/package.json", "utf8"),
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

function assertReleaseWorkflowHasNotaryWrapper() {
  const workflow = readFileSync(
    ".github/workflows/release-electrobun.yml",
    "utf8",
  );
  const missing = findMissingRequiredSnippets(
    workflow,
    requiredWorkflowSnippets,
  );

  if (missing.length > 0) {
    console.error(
      "release-check: release workflow is missing notary wrapper wiring:",
    );
    for (const snippet of missing) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }

  const patchedCliHelper = readFileSync(
    "eliza/packages/app-core/scripts/build-patched-electrobun-cli.mjs",
    "utf8",
  );
  const missingPatchedCli =
    findMissingPatchedElectrobunCliSnippets(patchedCliHelper);

  if (missingPatchedCli.length > 0) {
    console.error(
      "release-check: patched Electrobun helper is missing expected build wiring:",
    );
    for (const snippet of missingPatchedCli) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }

  const forbidden = forbiddenWorkflowSnippets.filter((snippet) =>
    workflow.includes(snippet),
  );

  if (forbidden.length > 0) {
    console.error(
      "release-check: release workflow still exposes raw bootstrap artifacts on the public GitHub release:",
    );
    for (const snippet of forbidden) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }
}

function assertElectrobunPrWorkflowExists() {
  const workflow = readFileSync(
    ".github/workflows/test-electrobun-release.yml",
    "utf8",
  );
  const missing = requiredElectrobunPrWorkflowSnippets.filter(
    (snippet) => !workflow.includes(snippet),
  );

  if (missing.length > 0) {
    console.error(
      "release-check: Electrobun PR workflow is missing lightweight release-contract validation:",
    );
    for (const snippet of missing) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }

  const forbidden = forbiddenElectrobunPrWorkflowSnippets.filter((snippet) =>
    workflow.includes(snippet),
  );

  if (forbidden.length > 0) {
    console.error(
      "release-check: Electrobun PR workflow still invokes the full reusable release pipeline:",
    );
    for (const snippet of forbidden) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }
}

function assertElectrobunConfigHasPostWrapSigner() {
  const config = readElectrobunFile("electrobun.config.ts");
  const missing = requiredElectrobunConfigSnippets.filter(
    (snippet) => !config.includes(snippet),
  );

  if (missing.length > 0) {
    console.error(
      "release-check: electrobun config is missing postBuild signer wiring:",
    );
    for (const snippet of missing) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }
}

function assertMacArtifactStagerLooksCorrect() {
  const script = readElectrobunFile(
    "scripts",
    "stage-macos-release-artifacts.sh",
  );
  const requiredSnippets = [
    'for tarball_pattern in "*-macos-*.app.tar.zst" "*-macos-*.app.tar.gz" "*-macos-*.tar.gz"; do',
    'tar --zstd -xf "$TARBALL_PATH" -C "$EXTRACT_DIR"',
    'tar -xzf "$TARBALL_PATH" -C "$EXTRACT_DIR"',
    'TARBALL_BASENAME="$(basename "$TARBALL_PATH")"',
    "no macOS updater tarball found",
    'DIRECT_LAUNCHER_SOURCE="$SCRIPT_DIR/macos-direct-launcher.c"',
    'codesign -d --entitlements :- "$STAGED_APP_PATH"',
    "/usr/bin/clang \\",
    'install -m 0755 "$TMP_LAUNCHER_PATH" "$LAUNCHER_PATH"',
    "retry_codesign() {",
    "retry_notarytool_submit() {",
    "retry_notarytool_wait() {",
    "retry_notarytool_log() {",
    '"$macos_code_dir/libasar.dylib"',
    "sign_nested_macos_runtime_targets() {",
    'runtime_resources_dir="$STAGED_APP_PATH/Contents/Resources/app/eliza-dist"',
    'file "$candidate_path"',
    "*Mach-O*)",
    'find "$runtime_resources_dir" -type f -print0',
    "sign_nested_macos_runtime_targets",
    'sign_macos_runtime_target "$LAUNCHER_PATH"',
    'retry_codesign "${app_sign_args[@]}" "$STAGED_APP_PATH"',
    'codesign --verify --deep --strict --verbose=2 "$STAGED_APP_PATH"',
    "hdiutil create \\",
    'NOTARY_SUBMIT_ATTEMPTS="${ELECTROBUN_NOTARY_SUBMIT_ATTEMPTS:-3}"',
    'NOTARY_SUBMIT_RETRY_DELAY_SECONDS="${ELECTROBUN_NOTARY_SUBMIT_RETRY_DELAY_SECONDS:-30}"',
    'if ! retry_notarytool_submit "$NOTARY_SUBMIT_OUTPUT_PATH" "$NOTARY_SUBMIT_ATTEMPTS" "$NOTARY_SUBMIT_RETRY_DELAY_SECONDS"; then',
    '"$REAL_XCRUN" notarytool submit \\',
    'NOTARY_WAIT_ATTEMPTS="${ELECTROBUN_NOTARY_WAIT_ATTEMPTS:-3}"',
    'NOTARY_WAIT_RETRY_DELAY_SECONDS="${ELECTROBUN_NOTARY_WAIT_RETRY_DELAY_SECONDS:-60}"',
    'if ! retry_notarytool_wait "$NOTARY_WAIT_OUTPUT_PATH" "$NOTARY_WAIT_ATTEMPTS" "$NOTARY_WAIT_RETRY_DELAY_SECONDS"; then',
    "retry_notarytool_log >&2 || true",
    'STAPLER_ATTEMPTS="${ELECTROBUN_STAPLER_ATTEMPTS:-12}"',
    'STAPLER_DELAY_SECONDS="${ELECTROBUN_STAPLER_DELAY_SECONDS:-30}"',
    'if ! retry_command "$STAPLER_ATTEMPTS" "$STAPLER_DELAY_SECONDS" xcrun stapler staple "$TEMP_DMG_PATH"; then',
    '  if [[ "${ELECTROBUN_REQUIRE_STAPLED_DMG:-0}" == "1" ]]; then',
    "    exit 1",
    "  fi",
    '  echo "stage-macos-release-artifacts: notarization accepted but stapler ticket was not available; continuing without stapled DMG" >&2',
    "fi",
    'mv "$TEMP_DMG_PATH" "$FINAL_DMG_PATH"',
  ];
  const missing = requiredSnippets.filter(
    (snippet) => !script.includes(snippet),
  );

  if (missing.length > 0) {
    console.error(
      "release-check: macOS artifact stager is missing required release wiring:",
    );
    for (const snippet of missing) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }

  const forbiddenSnippets = [
    'codesign --force --deep --timestamp --sign "$ELECTROBUN_DEVELOPER_ID" "$STAGED_APP_PATH"',
    "exit_code=$?",
  ];
  const forbidden = forbiddenSnippets.filter((snippet) =>
    script.includes(snippet),
  );

  if (forbidden.length > 0) {
    console.error(
      "release-check: macOS artifact stager still contains known-bad signing/retry logic:",
    );
    for (const snippet of forbidden) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }
}

function assertWindowsSmokeScriptHasLeadingParamBlock() {
  const script = readElectrobunFile("scripts", "smoke-test-windows.ps1");
  const firstRelevantLine = script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));

  if (firstRelevantLine !== "param(") {
    console.error(
      "release-check: smoke-test-windows.ps1 must start with a param() block before executable statements.",
    );
    console.error(`  - first relevant line: ${firstRelevantLine ?? "<none>"}`);
    process.exit(1);
  }

  const requiredSnippets = [
    "Find-Launcher $resolvedBuildDir",
    'Get-ChildItem -Path $resolvedArtifactsDir -File -Filter "*.tar.zst"',
    'Join-Path $env:APPDATA "Eliza\\\\eliza-startup.log"',
    '$requireInstaller = $env:ELIZA_WINDOWS_SMOKE_REQUIRE_INSTALLER -eq "1"',
    "Installing via Inno Setup:",
    "/VERYSILENT",
    "installed Inno package",
    "$persistLauncherPathFile = $env:ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE",
    "Installer-required runs skip build/tarball reuse and validate the installed package directly.",
    "Using $launcherSource launcher:",
    "Using packaged tarball:",
    "Find-Launcher $selfExtractionRoot",
    "Started extracted launcher:",
    '$startupSessionId = "eliza-windows-smoke-"',
    "$tempRoot = if ($env:RUNNER_TEMP)",
    "$startupStateFile = Join-Path $tempRoot",
    '$startupBootstrapFile = Join-Path $startupBundleRoot "startup-session.json"',
    "Write-StartupBootstrap",
    "$stopProtectedProcessIds = [System.Collections.Generic.HashSet[int]]::new()",
    'Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid"',
    "-not $stopProtectedProcessIds.Contains([int]$_.Id)",
    "[int]::TryParse([string]$state.port, [ref]$observedPort)",
    "if ($state.session_id -ne $startupSessionId)",
    "$handler.UseProxy = $false",
    '--noproxy "127.0.0.1"',
    "function Test-BackendProbeStatus",
    "Cleared stale startup log:",
    "Startup trace entered fatal phase:",
    "Latest startup trace state:",
    "-SkipHttpErrorCheck",
    "Dump-PortDiagnostics",
    "Dump-ProcessDiagnostics",
    "Dump-FailureDiagnostics",
    "periodic diagnostics at",
    "FAILURE DIAGNOSTICS",
  ];
  const missingSnippets = requiredSnippets.filter(
    (snippet) => !script.includes(snippet),
  );

  if (missingSnippets.length > 0) {
    console.error(
      "release-check: smoke-test-windows.ps1 is missing the packaged-launcher/dynamic-port smoke logic.",
    );
    for (const snippet of missingSnippets) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }
}

function assertWindowsInstallerProofScript() {
  const script = readElectrobunFile(
    "scripts",
    "verify-windows-installer-proof.ps1",
  );

  const requiredSnippets = [
    "Eliza-Setup-*.exe",
    "smoke-test-windows.ps1",
    "ELIZA_WINDOWS_SMOKE_REQUIRE_INSTALLER",
    "Start Menu",
    "unins*.exe",
    "proof-summary.json",
  ];
  const missingSnippets = requiredSnippets.filter(
    (snippet) => !script.includes(snippet),
  );

  if (missingSnippets.length > 0) {
    console.error(
      "release-check: verify-windows-installer-proof.ps1 is missing required clean-install proof logic.",
    );
    for (const snippet of missingSnippets) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }
}

function assertInnoBuildScriptHasTimeoutAndHeartbeat() {
  const script = readFileSync(
    "eliza/packages/app-core/packaging/inno/build-inno.ps1",
    "utf8",
  );
  const requiredSnippets = [
    "$isccTimeout = [TimeSpan]::FromMinutes(25)",
    "$isccHeartbeatInterval = [TimeSpan]::FromSeconds(30)",
    "Write-Host \"Starting ISCC.exe: $isccPath $($isccArgumentDisplay -join ' ')\"",
    "Start-Process -FilePath $isccPath",
    'Write-Host "ISCC.exe still running after $([math]::Round($elapsed.TotalMinutes, 1)) minutes..."',
    "Stop-Process -Id $isccProcess.Id -Force",
    'throw "ISCC.exe timed out after $([int]$isccTimeout.TotalMinutes) minutes while building the Windows installer."',
  ];
  const missingSnippets = requiredSnippets.filter(
    (snippet) => !script.includes(snippet),
  );

  if (missingSnippets.length > 0) {
    console.error(
      "release-check: build-inno.ps1 must supervise ISCC.exe with heartbeat logging and a hard timeout.",
    );
    for (const snippet of missingSnippets) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }
}

function assertInnoTemplateTargetsBundledLauncher() {
  const template = readFileSync(
    "eliza/packages/app-core/packaging/inno/ElizaOSApp.iss",
    "utf8",
  );
  const requiredSnippets = [
    '#define MyAppExeName "bin\\launcher.exe"',
    '#define MyAppIconFile "ElizaOSApp.ico"',
    'Source: "{#MySetupIconFile}"; DestDir: "{app}"; DestName: "{#MyAppIconFile}"; Flags: ignoreversion',
    "UninstallDisplayIcon={app}\\{#MyAppIconFile}",
    'Name: "{autoprograms}\\{#MyDefaultGroupName}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"; IconFilename: "{app}\\{#MyAppIconFile}"',
    'Name: "{autodesktop}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"; Tasks: desktopicon; IconFilename: "{app}\\{#MyAppIconFile}"',
  ];
  const missingSnippets = requiredSnippets.filter(
    (snippet) => !template.includes(snippet),
  );

  if (missingSnippets.length > 0) {
    console.error(
      "release-check: Eliza.iss must point Windows shortcuts at bin\\launcher.exe and use Eliza.ico for uninstall and shortcut icons.",
    );
    for (const snippet of missingSnippets) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }

  if (template.includes('#define MyAppExeName "launcher.exe"')) {
    console.error(
      "release-check: Eliza.iss must not point Windows shortcuts at {app}\\launcher.exe; the bundled launcher lives under bin\\.",
    );
    process.exit(1);
  }
}

function assertMacSmokeScriptLaunchesPackagedLauncherDirectly() {
  const script = readElectrobunFile("scripts", "smoke-test.sh");

  if (
    !script.includes(
      'LAUNCHER_PATH="$LAUNCH_APP_BUNDLE/Contents/MacOS/launcher"',
    )
  ) {
    console.error(
      "release-check: smoke-test.sh must launch the packaged Contents/MacOS/launcher directly.",
    );
    process.exit(1);
  }

  const requiredSnippets = [
    "dump_failure_diagnostics()",
    "write_bundle_diagnostics()",
    "collect_recent_crash_reports()",
    "build_launcher_command()",
    "probe_macos_bundle_exec_support()",
    "launch_packaged_app_with_open()",
    'OPEN_LAUNCH_ATTEMPTED="1"',
    'STARTUP_BOOTSTRAP_FILE="$LAUNCH_APP_BUNDLE/Contents/Resources/startup-session.json"',
    "while IFS= read -r startup_state_line; do",
    "const [filePath, expectedSession] = process.argv.slice(1);",
    'TERM="$' + "{TERM:-dumb}" + '"',
    "attach_dmg_with_retry()",
    'MOUNT_POINT="$(attach_dmg_with_retry "$DMG_PATH")"',
    'DIRECT_WGPU_DYLIB="$APP_BUNDLE/Contents/MacOS/libwebgpu_dawn.dylib"',
    'echo "WGPU : direct app bundle -> $DIRECT_WGPU_DYLIB"',
    "assert_packaged_archive_asset()",
    'echo "Packaged renderer asset check PASSED (wrapper archive)."',
    'echo "Launcher: $' + "{LAUNCHER_PATH:-<unset>}" + '"',
    'local launcher_stdout="$' + "{LAUNCHER_STDOUT:-}" + '"',
    "backend_health_probe_satisfied()",
    '[[ "$status" == "200" || "$status" == "401" ]]',
    "Launcher exited before the first health probe; continuing to wait for packaged app handoff...",
    'dump_failure_diagnostics "open(1) failed to launch packaged app"',
    'FAILURE_REASON="open(1) launch produced no startup trace"',
    'FAILURE_REASON="macOS direct app-bundle exec probe returned SIGKILL (137) before startup trace began"',
  ];
  const missing = requiredSnippets.filter(
    (snippet) => !script.includes(snippet),
  );
  if (missing.length > 0) {
    console.error(
      "release-check: smoke-test.sh is missing failure-time diagnostics hooks.",
    );
    for (const snippet of missing) {
      console.error(`  - ${snippet}`);
    }
    process.exit(1);
  }

  if (script.includes("mapfile -t startup_state_parts")) {
    console.error(
      "release-check: smoke-test.sh must stay compatible with macOS Bash 3.2 and cannot use mapfile.",
    );
    process.exit(1);
  }
}

function assertServerDynamicHyperscapeImport() {
  const serverSource = readExistingReleaseCheckFile(
    "autonomous API server source",
    autonomousServerPathCandidates,
  );

  // @hyperscape/plugin-hyperscape must never be a static top-level import. The
  // API server has to remain bootable when the optional app package is not
  // installed (for example in Windows smoke and release validation runs).
  const lines = serverSource.split("\n");
  const staticImports = lines.filter(
    (line) =>
      /^\s*import\s/.test(line) &&
      line.includes("@hyperscape/plugin-hyperscape"),
  );
  if (staticImports.length > 0) {
    console.error(
      "release-check: server.ts must NOT have a static import of @hyperscape/plugin-hyperscape/routes. Use a dynamic import inside a try-catch.",
    );
    for (const line of staticImports) {
      console.error(`  - ${line.trim()}`);
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
  // are visible in packaged builds (Electrobun agent.ts reads stderr).
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
    !catchBlock.includes("opts?.serverOnly") ||
    !catchBlock.includes("process.exit(1)")
  ) {
    console.error(
      "release-check: eliza.ts startApiServer catch block must call process.exit(1) when opts?.serverOnly is true.",
    );
    process.exit(1);
  }
}

function maybeValidateCdnAssets() {
  if (process.env.ELIZA_VALIDATE_CDN !== "1") {
    return;
  }

  execSync("node scripts/validate-cdn-assets.mjs", {
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
    `release-check: static asset manifest is ${result.reason}. Run node scripts/generate-static-asset-manifest.mjs.`,
  );
  console.error(`  - ${result.manifestPath}`);
  process.exit(1);
}

function assertHomepageReleaseDataUsesCurrentAssetRoot() {
  const releaseDataSource = readExistingReleaseCheckFile(
    "generated homepage release data",
    homepageReleaseDataPathCandidates,
  );

  if (!releaseDataSource.includes("homepageAssetBaseUrl:")) {
    console.error(
      "release-check: generated homepage release data is missing homepageAssetBaseUrl.",
    );
    process.exit(1);
  }

  if (!releaseDataSource.includes("/apps/homepage/public/")) {
    console.error(
      "release-check: generated homepage release data must point homepageAssetBaseUrl at /apps/homepage/public/.",
    );
    process.exit(1);
  }

  if (releaseDataSource.includes("/apps/web/public/")) {
    console.error(
      "release-check: generated homepage release data still points at legacy /apps/web/public/. Regenerate it with node scripts/write-homepage-release-data.mjs.",
    );
    process.exit(1);
  }
}

function main() {
  assertReleaseWorkflowHasNotaryWrapper();
  assertElectrobunPrWorkflowExists();
  assertElectrobunConfigHasPostWrapSigner();
  assertMacArtifactStagerLooksCorrect();
  assertWindowsSmokeScriptHasLeadingParamBlock();
  assertWindowsInstallerProofScript();
  assertInnoBuildScriptHasTimeoutAndHeartbeat();
  assertInnoTemplateTargetsBundledLauncher();
  assertMacSmokeScriptLaunchesPackagedLauncherDirectly();
  assertServerDynamicHyperscapeImport();
  assertStartApiServerCatchBlockSafety();
  assertStaticAssetManifestIsCurrent();
  assertHomepageReleaseDataUsesCurrentAssetRoot();
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
