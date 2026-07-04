#!/usr/bin/env node
/** Supports app-core build, packaging, or development orchestration for desktop build mjs. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectrobunDir, resolveMainAppDir } from "./lib/app-dir.mjs";
import { artifactStaleness, maxMtimeUnder } from "./lib/artifact-staleness.mjs";
import {
  buildWindowsRepairSteps,
  classifyElectrobunViewFailure,
  findElectrobunManifestPath,
  hasElectrobunViewExport,
  isSupportedBunVersion,
} from "./lib/desktop-preflight.mjs";
import { appIdentityEnv } from "./lib/read-app-identity.mjs";
import { assertRendererRebuiltSince } from "./lib/renderer-build-manifest.mjs";

const ROOT = process.cwd();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// --app=<name> selects which app to build (default: "app" → packages/app)
const appArgMatch = process.argv.find((a) => a.startsWith("--app="));
const appName = appArgMatch ? appArgMatch.split("=")[1] : "app";
const APP_DIR = resolveMainAppDir(ROOT, appName);
const LEGACY_ELECTROBUN_DIR = path.join(APP_DIR, "electrobun");
const ELECTROBUN_DIR = resolveElectrobunDir(ROOT);
const STAGE_MACOS_RELEASE_SCRIPT = path.join(
  ELECTROBUN_DIR,
  "scripts",
  "stage-macos-release-artifacts.sh",
);
const PROFILE_EXCLUDED_OPTIONAL_PACKS = {
  full: [],
  "no-streaming": ["streaming"],
};
const COMMAND_PREFIX = (process.env.ELIZA_DESKTOP_COMMAND_PREFIX ?? "")
  .trim()
  .split(/\s+/)
  .filter(Boolean);
const DESKTOP_BUILD_LOCK_DIR = path.join(ROOT, ".turbo", "desktop-build.lock");
const CLEANUP_HELPER_SCRIPT = path.join(
  ROOT,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);
const RUNTIME_COPY_SCRIPT = fs.existsSync(
  path.join(ROOT, "scripts", "copy-runtime-node-modules.ts"),
)
  ? path.join(ROOT, "scripts", "copy-runtime-node-modules.ts")
  : path.join(SCRIPT_DIR, "copy-runtime-node-modules.ts");
const WRITE_BUILD_INFO_SCRIPT = fs.existsSync(
  path.join(ROOT, "scripts", "write-build-info.ts"),
)
  ? path.join(ROOT, "scripts", "write-build-info.ts")
  : path.join(ROOT, "packages", "scripts", "write-build-info.ts");

function resolveWorkspacePackageDir(packageDirName) {
  const candidates = [
    path.join(ROOT, "packages", packageDirName),
    path.join(ROOT, "eliza", "packages", packageDirName),
  ];
  return (
    candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, "package.json")),
    ) ?? candidates[0]
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readDesktopBuildLockOwnerPid() {
  try {
    const rawOwner = fs.readFileSync(
      path.join(DESKTOP_BUILD_LOCK_DIR, "owner"),
      "utf8",
    );
    const pid = Number.parseInt(rawOwner.split(/\r?\n/, 1)[0] ?? "", 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function removePathRecursive(targetPath, label = "path cleanup") {
  const result = spawnSync("node", [CLEANUP_HELPER_SCRIPT, targetPath], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${label} failed with exit code ${result.status ?? 1}${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
}

function removeDesktopBuildLockDir() {
  removePathRecursive(DESKTOP_BUILD_LOCK_DIR, "desktop build lock cleanup");
}

function withDesktopBuildLock(run) {
  const lockParent = path.dirname(DESKTOP_BUILD_LOCK_DIR);
  const staleAfterMs = 30 * 60 * 1000;
  let announcedWait = false;

  fs.mkdirSync(lockParent, { recursive: true });

  for (;;) {
    try {
      fs.mkdirSync(DESKTOP_BUILD_LOCK_DIR);
      fs.writeFileSync(
        path.join(DESKTOP_BUILD_LOCK_DIR, "owner"),
        `${process.pid}\n${new Date().toISOString()}\n`,
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      let stat = null;
      try {
        stat = fs.statSync(DESKTOP_BUILD_LOCK_DIR);
      } catch {
        continue;
      }

      const ownerPid = readDesktopBuildLockOwnerPid();
      if (
        (ownerPid !== null && !isProcessAlive(ownerPid)) ||
        Date.now() - stat.mtimeMs > staleAfterMs
      ) {
        removeDesktopBuildLockDir();
        continue;
      }

      if (!announcedWait) {
        console.log(
          "[desktop-build] Waiting for another desktop build to finish...",
        );
        announcedWait = true;
      }
      sleepSync(250);
    }
  }

  try {
    run();
  } finally {
    removeDesktopBuildLockDir();
  }
}

function resolveWorkspacePluginDir(pluginDirName) {
  const candidates = [
    path.join(ROOT, "plugins", pluginDirName),
    path.join(ROOT, "eliza", "plugins", pluginDirName),
  ];
  return (
    candidates.find((candidate) =>
      fs.existsSync(path.join(candidate, "package.json")),
    ) ?? candidates[0]
  );
}

const APP_CORE_PACKAGE_DIR = resolveWorkspacePackageDir("app-core");
const AGENT_PACKAGE_DIR = resolveWorkspacePackageDir("agent");
const CLOUD_SDK_PACKAGE_DIR = resolveWorkspacePackageDir(
  path.join("cloud", "sdk"),
);
const CORE_PACKAGE_DIR = resolveWorkspacePackageDir("core");
const PLUGIN_AGENT_ORCHESTRATOR_PACKAGE_DIR = resolveWorkspacePluginDir(
  "plugin-agent-orchestrator",
);
const APP_MODEL_TESTER_PACKAGE_DIR =
  resolveWorkspacePluginDir("app-model-tester");
const PLUGIN_LOCAL_INFERENCE_PACKAGE_DIR = resolveWorkspacePluginDir(
  "plugin-local-inference",
);
const PLUGIN_REMOTE_MANIFEST_PACKAGE_DIR = resolveWorkspacePackageDir(
  "plugin-remote-manifest",
);
const PLUGIN_WORKER_RUNTIME_PACKAGE_DIR = resolveWorkspacePackageDir(
  "plugin-worker-runtime",
);
const SHARED_PACKAGE_DIR = resolveWorkspacePackageDir("shared");
const SECURITY_PACKAGE_DIR = resolveWorkspacePackageDir("security");
const UI_PACKAGE_DIR = resolveWorkspacePackageDir("ui");
const VAULT_PACKAGE_DIR = resolveWorkspacePackageDir("vault");
const DESKTOP_BUILD_TMP_DIR = path.join(ELECTROBUN_DIR, "tmp");
const DESKTOP_BUILD_BUN_CACHE_DIR = path.join(
  DESKTOP_BUILD_TMP_DIR,
  "bun-cache",
);

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "build";
const flagStart = command === "build" && argv[0]?.startsWith("--") ? 0 : 1;
const args = argv.slice(flagStart);

const buildProfile =
  getArgValue(args, "profile") ?? process.env.ELIZA_DESKTOP_PROFILE ?? "full";
const variant =
  getArgValue(args, "variant") ?? process.env.VITE_APP_VARIANT ?? "base";
const buildVariant = resolveBuildVariant(
  getArgValue(args, "build-variant") ?? process.env.ELIZA_BUILD_VARIANT,
);
const buildEnv = getArgValue(args, "env") ?? process.env.BUILD_ENV ?? "";
const stageMacosReleaseApp = getBooleanArg(args, "stage-macos-release-app");
// The macOS native-effects dylib build shells to `xcrun clang++` (Xcode CLT).
// "Explicitly requested" decides whether missing native tooling is a hard
// failure (CI passes --build-native-effects on a tooled runner) or a graceful
// skip (out-of-box dev build).
const nativeEffectsExplicitlyRequested =
  getBooleanArg(args, "build-native-effects") ||
  process.env.ELIZA_DESKTOP_BUILD_NATIVE_EFFECTS === "1";

function resolveBuildVariant(raw) {
  if (raw === "store" || raw === "direct") return raw;
  if (raw === undefined || raw === null || raw === "") return "direct";
  fail(`Unknown --build-variant value: ${raw}. Expected "store" or "direct".`);
}
const excludedOptionalPacks = [
  ...new Set([
    ...getProfileExcludedOptionalPacks(buildProfile),
    ...getRepeatedArgValues(args, "exclude-optional-pack"),
  ]),
];

function fail(message, code = 1) {
  console.error(`[desktop-build] ${message}`);
  process.exit(code);
}

function getProfileExcludedOptionalPacks(profile) {
  const packs = PROFILE_EXCLUDED_OPTIONAL_PACKS[profile];
  if (!packs) {
    fail(
      `Unknown desktop build profile: ${profile}. Available profiles: ${Object.keys(PROFILE_EXCLUDED_OPTIONAL_PACKS).join(", ")}`,
    );
  }
  return packs;
}

function which(commandName) {
  const pathEnv = process.env.PATH ?? "";
  if (!pathEnv) return null;

  const isWindows = process.platform === "win32";
  const exts = isWindows
    ? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [
        ".EXE",
        ".CMD",
        ".BAT",
        ".COM",
      ])
    : [""];

  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const suffix = isWindows && ext && !commandName.endsWith(ext) ? ext : "";
      const candidate = path.join(dir, `${commandName}${suffix}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function getArgValue(argvItems, name) {
  const exact = `--${name}`;
  const prefixed = `--${name}=`;
  const index = argvItems.indexOf(exact);
  if (index >= 0) {
    const value = argvItems[index + 1];
    return value && !value.startsWith("--") ? value : null;
  }

  const inline = argvItems.find((item) => item.startsWith(prefixed));
  return inline ? inline.slice(prefixed.length) : null;
}

function getBooleanArg(argvItems, name) {
  const value = getArgValue(argvItems, name);
  if (value !== null) {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return argvItems.includes(`--${name}`);
}

function getRepeatedArgValues(argvItems, name) {
  const values = [];
  const exact = `--${name}`;
  const prefixed = `--${name}=`;

  for (let i = 0; i < argvItems.length; i += 1) {
    const item = argvItems[i];
    if (item === exact) {
      const value = argvItems[i + 1];
      if (value && !value.startsWith("--")) {
        values.push(value);
        i += 1;
      }
      continue;
    }

    if (item.startsWith(prefixed)) {
      values.push(item.slice(prefixed.length));
    }
  }

  return values;
}

function buildInvocation(binary, binaryArgs = []) {
  if (COMMAND_PREFIX.length === 0) {
    return { command: binary, args: binaryArgs };
  }

  return {
    command: COMMAND_PREFIX[0],
    args: [...COMMAND_PREFIX.slice(1), binary, ...binaryArgs],
  };
}

function run(commandName, commandArgs, options = {}) {
  const {
    cwd = ROOT,
    env = process.env,
    label,
    allowFailure = false,
  } = options;
  const invocation = buildInvocation(commandName, commandArgs);
  const rendered = [invocation.command, ...invocation.args].join(" ");
  console.log(`[desktop-build] ${label ?? rendered}`);

  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    if (allowFailure) {
      console.warn(
        `[desktop-build] ${rendered} exited ${result.status ?? 1} (tolerated)`,
      );
      return;
    }
    fail(
      `${rendered} failed with exit code ${result.status ?? 1}`,
      result.status ?? 1,
    );
  }
}

function runStatus(commandName, commandArgs, options = {}) {
  const { cwd = ROOT, env = process.env, label } = options;
  const invocation = buildInvocation(commandName, commandArgs);
  const rendered = [invocation.command, ...invocation.args].join(" ");
  console.log(`[desktop-build] ${label ?? rendered}`);

  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    stdio: "inherit",
  });

  return {
    command: rendered,
    status: result.status ?? 1,
  };
}

function runCapture(commandName, commandArgs, options = {}) {
  const { cwd = ROOT, env = process.env } = options;
  const invocation = buildInvocation(commandName, commandArgs);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    command: invocation.command,
    args: invocation.args,
  };
}

function runBun(commandArgs, options = {}) {
  const bun = resolveBunBinary();
  if (!bun) {
    fail('Could not find "bun" in PATH.');
  }
  run(bun, commandArgs, options);
}

function runBunCapture(commandArgs, options = {}) {
  const bun = resolveBunBinary();
  if (!bun) {
    fail('Could not find "bun" in PATH.');
  }
  return runCapture(bun, commandArgs, options);
}

function runBunStatus(commandArgs, options = {}) {
  const bun = resolveBunBinary();
  if (!bun) {
    fail('Could not find "bun" in PATH.');
  }
  return runStatus(bun, commandArgs, options);
}

function desktopBuildTempEnv(extraEnv = {}) {
  fs.mkdirSync(DESKTOP_BUILD_TMP_DIR, { recursive: true });
  return {
    ...process.env,
    ...extraEnv,
    TMPDIR: DESKTOP_BUILD_TMP_DIR,
    TMP: DESKTOP_BUILD_TMP_DIR,
    TEMP: DESKTOP_BUILD_TMP_DIR,
    BUN_TMPDIR: DESKTOP_BUILD_TMP_DIR,
    BUN_INSTALL_CACHE_DIR: DESKTOP_BUILD_BUN_CACHE_DIR,
  };
}

function dependencyTreePresent(cwd) {
  return (
    fs.existsSync(path.join(cwd, "node_modules")) ||
    fs.existsSync(path.join(ROOT, "node_modules"))
  );
}

function runOptionalWorkspaceInstall(cwd, label) {
  if (dependencyTreePresent(cwd)) {
    console.log(`[desktop-build] ${label} (skipped; dependencies present)`);
    return;
  }
  runBun(
    ["install", "--ignore-scripts", "--cache-dir", DESKTOP_BUILD_BUN_CACHE_DIR],
    {
      cwd,
      env: desktopBuildTempEnv(),
      label,
      allowFailure: true,
    },
  );
}

function resolveBunBinary() {
  if (process.platform === "win32") {
    const whereResult = spawnSync("where", ["bun"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (whereResult.status === 0 && typeof whereResult.stdout === "string") {
      const lines = whereResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const exePath = lines.find((line) => /\.exe$/i.test(line));
      if (exePath && fs.existsSync(exePath)) {
        return exePath;
      }
    }
  }
  const bun = which("bun");
  if (!bun) return null;
  if (process.platform === "win32" && bun.toLowerCase().endsWith(".cmd")) {
    const bunInstallExe =
      process.env.BUN_INSTALL &&
      path.join(process.env.BUN_INSTALL, "bin", "bun.exe");
    if (bunInstallExe && fs.existsSync(bunInstallExe)) {
      return bunInstallExe;
    }
    const siblingExe = bun.slice(0, -4);
    if (fs.existsSync(siblingExe) && /\.exe$/i.test(siblingExe)) {
      return siblingExe;
    }
  }
  return bun;
}

function runPackageBinary(binary, binaryArgs, options = {}) {
  const bunx = which("bunx");
  if (bunx) {
    run(bunx, [binary, ...binaryArgs], options);
    return;
  }

  const npx = which("npx");
  if (npx) {
    run(npx, [binary, ...binaryArgs], options);
    return;
  }

  fail(`Could not find bunx or npx to run ${binary}.`);
}

function resolveLocalPackageBinary(binary, cwdCandidates = []) {
  const executableNames =
    process.platform === "win32"
      ? [`${binary}.cmd`, `${binary}.exe`, binary]
      : [binary];
  const candidates = [];

  for (const cwd of cwdCandidates) {
    for (const executableName of executableNames) {
      candidates.push(path.join(cwd, "node_modules", ".bin", executableName));
    }
  }

  for (const executableName of executableNames) {
    candidates.push(path.join(ROOT, "node_modules", ".bin", executableName));
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function runBunPackageBinary(binary, binaryArgs, options = {}) {
  const bunx = which("bunx");
  if (bunx) {
    run(bunx, ["--bun", binary, ...binaryArgs], options);
    return;
  }

  runPackageBinary(binary, binaryArgs, options);
}

function runElectrobun(commandArgs, options = {}) {
  const local = resolveLocalPackageBinary(
    "electrobun",
    [options.cwd, ELECTROBUN_DIR].filter(Boolean),
  );
  if (local) {
    run(local, commandArgs, options);
    return;
  }

  const direct = which("electrobun");
  if (direct) {
    run(direct, commandArgs, options);
    return;
  }

  runPackageBinary("electrobun", commandArgs, options);
}

function ensureAppDirs() {
  for (const dir of [APP_DIR, ELECTROBUN_DIR]) {
    if (!fs.existsSync(dir)) {
      fail(`Expected directory not found: ${dir}`);
    }
  }
}

function logPreflightDiagnostic(fields) {
  console.log(`[desktop-preflight] ${JSON.stringify(fields)}`);
}

function failPreflight(message, fields = {}, detailLines = []) {
  logPreflightDiagnostic({
    level: "error",
    ...fields,
  });
  console.error(`[desktop-preflight] ${message}`);
  for (const line of detailLines) {
    console.error(line);
  }
  fail("Desktop preflight failed. See diagnostics above.");
}

function runDesktopPreflight() {
  ensureAppDirs();
  const moduleName = "electrobun/view";
  const preflightCwd = ELECTROBUN_DIR;

  const bunVersionResult = runBunCapture(["--version"], { cwd: preflightCwd });
  const bunVersion = bunVersionResult.stdout.trim();
  if (bunVersionResult.status !== 0 || !bunVersion) {
    failPreflight(
      "Unable to read Bun version.",
      {
        step: "bun-version",
        cwd: preflightCwd,
        module: moduleName,
        errorCode: bunVersionResult.status,
      },
      [bunVersionResult.stderr.trim()].filter(Boolean),
    );
  }

  if (!isSupportedBunVersion(bunVersion)) {
    failPreflight("Unsupported Bun version for desktop builds.", {
      step: "bun-version",
      cwd: preflightCwd,
      module: moduleName,
      bunVersion,
      errorCode: "UNSUPPORTED_BUN_VERSION",
    });
  }

  const electrobunPkgPath = findElectrobunManifestPath(
    [ELECTROBUN_DIR, APP_DIR, ROOT],
    fs.existsSync,
  );
  if (!electrobunPkgPath) {
    logPreflightDiagnostic({
      level: "info",
      step: "electrobun-manifest",
      cwd: preflightCwd,
      module: moduleName,
      bunVersion,
      errorCode: "ELECTROBUN_MANIFEST_NOT_IN_WORKSPACE",
      detail:
        "Falling back to Bun import resolution because electrobun is not present in workspace node_modules.",
    });
  } else {
    let electrobunManifest = null;
    try {
      electrobunManifest = JSON.parse(
        fs.readFileSync(electrobunPkgPath, "utf8"),
      );
    } catch (err) {
      failPreflight(
        "Failed to parse electrobun package manifest.",
        {
          step: "electrobun-manifest",
          cwd: preflightCwd,
          module: moduleName,
          bunVersion,
          errorCode: "ELECTROBUN_MANIFEST_PARSE_ERROR",
        },
        [String(err)],
      );
    }

    if (!hasElectrobunViewExport(electrobunManifest)) {
      failPreflight("Electrobun package exports are missing ./view.", {
        step: "electrobun-manifest",
        cwd: preflightCwd,
        module: moduleName,
        bunVersion,
        errorCode: "ELECTROBUN_VIEW_EXPORT_MISSING",
      });
    }
  }

  const importProbe = runBunCapture(
    [
      "-e",
      'try{const resolved=import.meta.resolve("electrobun/view");console.log(resolved);}catch(err){console.error(String(err?.stack||err));process.exit(1);}',
    ],
    { cwd: preflightCwd },
  );
  if (importProbe.status !== 0) {
    const stderr = `${importProbe.stderr}\n${importProbe.stdout}`.trim();
    const classified = classifyElectrobunViewFailure(stderr);
    const detailLines = [stderr].filter(Boolean);
    if (
      classified.code === "EACCES_ELECTROBUN_VIEW" &&
      process.platform === "win32"
    ) {
      detailLines.push("");
      detailLines.push(...buildWindowsRepairSteps());
    }
    failPreflight(
      "Failed to resolve/import electrobun/view during desktop preflight.",
      {
        step: "import-probe",
        cwd: preflightCwd,
        module: moduleName,
        bunVersion,
        errorCode: classified.code,
      },
      detailLines,
    );
  }

  logPreflightDiagnostic({
    level: "info",
    step: "complete",
    cwd: preflightCwd,
    module: moduleName,
    bunVersion,
    errorCode: "OK",
  });

  preflightStoreVariantSigning();
}

/**
 * Store-variant signing preflight.
 *
 * When building the store flavor of a desktop variant outside CI (no
 * ELECTROBUN_SKIP_CODESIGN=1, no CI=true), fail loudly if the required
 * signing-identity env vars aren't set. Without this, the build runs all
 * the way through staging + packaging only to die in codesign-mas.mjs
 * or build-msix.ps1 — wasting minutes of clock per attempt.
 *
 * CI builds skip this preflight because the secrets are provisioned at
 * job-step level, after this script's preflight runs.
 */
function preflightStoreVariantSigning() {
  if (buildVariant !== "store") return;
  if (process.env.CI === "true" || process.env.ELECTROBUN_SKIP_CODESIGN === "1")
    return;

  const missing = [];
  if (process.platform === "darwin") {
    if (!process.env.ELIZA_MAS_SIGNING_IDENTITY?.trim()) {
      missing.push("ELIZA_MAS_SIGNING_IDENTITY");
    }
  } else if (process.platform === "win32") {
    if (!process.env.ELIZA_MSIX_STORE_CERT_PATH?.trim()) {
      missing.push("ELIZA_MSIX_STORE_CERT_PATH");
    }
  } else if (process.platform === "linux") {
    // Flatpak builds use `flatpak-builder`; no signing env vars are required
    // (Flathub signs the repo server-side).
  }

  if (missing.length === 0) return;

  failPreflight(
    "Store-variant build requires signing env vars (or set ELECTROBUN_SKIP_CODESIGN=1 for unsigned local builds).",
    {
      step: "store-signing",
      platform: process.platform,
      buildVariant,
      missing,
    },
    missing.map((name) => `  set ${name}=... before running`),
  );
}

function findLatestMacAppBundle() {
  const buildRoot = path.join(ELECTROBUN_DIR, "build");
  if (!fs.existsSync(buildRoot)) {
    fail(`Electrobun build output not found: ${buildRoot}`);
  }

  const candidates = [];
  for (const entry of fs.readdirSync(buildRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const platformDir = path.join(buildRoot, entry.name);
    for (const child of fs.readdirSync(platformDir, { withFileTypes: true })) {
      if (!child.isDirectory() || !child.name.endsWith(".app")) {
        continue;
      }

      const appBundlePath = path.join(platformDir, child.name);
      const stat = fs.statSync(appBundlePath);
      candidates.push({ appBundlePath, mtimeMs: stat.mtimeMs });
    }
  }

  if (candidates.length === 0) {
    fail(`No macOS .app bundle found under ${buildRoot}`);
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0].appBundlePath;
}

function hasRootTsdownEntry() {
  return (
    fs.existsSync(path.join(ROOT, "tsdown.config.ts")) ||
    fs.existsSync(path.join(ROOT, "tsdown.config.mts")) ||
    fs.existsSync(path.join(ROOT, "tsdown.config.js")) ||
    fs.existsSync(path.join(ROOT, "src", "index.ts"))
  );
}

function ensureRootRuntimeBundle() {
  if (hasRootTsdownEntry()) {
    runPackageBinary("tsdown", [], {
      cwd: ROOT,
      label: "Building core runtime bundle with tsdown",
    });
    return;
  }

  const distDir = path.join(ROOT, "dist");
  const entrySource = [
    "// auto-generated by desktop-build.mjs",
    "// Standalone elizaOS checkouts do not have a root tsdown entry.",
    "// Packaged desktop runtimes resolve the real CLI entry from the bundled node_modules tree.",
    'import "./node_modules/@elizaos/app-core/dist/entry.js";',
    "",
  ].join("\n");

  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "entry.js"), entrySource);
  fs.writeFileSync(path.join(distDir, "index.js"), entrySource);
  fs.writeFileSync(path.join(distDir, "package.json"), '{"type":"module"}\n');
}

// The desktop build compiles the @elizaos/* workspace packages from source, so
// it only works when those packages are present on disk (a workspace/local
// checkout). In packages mode they are resolved from node_modules instead and
// resolveWorkspacePackageDir() falls back to a non-existent ROOT/packages/* dir,
// which previously surfaced deep in the build as a cryptic
// "Expected @elizaos/core package not found". Detect this once, up front, with
// an actionable message instead.
function ensureWorkspaceCheckoutPresent() {
  if (fs.existsSync(path.join(CORE_PACKAGE_DIR, "package.json"))) {
    return;
  }
  fail(
    "Desktop build requires the @elizaos/* workspace packages on disk, but " +
      `none were found (looked for ${path.join(CORE_PACKAGE_DIR, "package.json")}).\n` +
      "  Run the desktop build from a workspace checkout where packages/* (or " +
      "eliza/packages/*) are present.",
  );
}

function ensureWorkspaceRuntimePackageBuilt(packageName, packageDir) {
  const packageJson = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJson)) {
    fail(`Expected ${packageName} package not found: ${packageDir}`);
  }

  if (
    process.env.ELIZA_DESKTOP_REBUILD_RUNTIME_PACKAGES !== "1" &&
    workspaceRuntimePackageLooksBuilt(packageName, packageDir)
  ) {
    console.log(
      `[desktop-build] Reusing existing ${packageName} runtime package`,
    );
    return;
  }

  runBun(["run", "build"], {
    cwd: packageDir,
    label: `Building ${packageName} runtime package`,
  });
}

function workspaceRuntimePackageMarkersPresent(packageName, distDir) {
  if (packageName === "@elizaos/core") {
    return (
      fs.existsSync(path.join(distDir, "node", "index.node.js")) &&
      fs.existsSync(path.join(distDir, "index.node.d.ts")) &&
      fs.existsSync(path.join(distDir, "testing", "live-provider.d.ts"))
    );
  }

  if (packageName === "@elizaos/ui") {
    return (
      fs.existsSync(path.join(distDir, "index.js")) &&
      fs.existsSync(path.join(distDir, "App.js")) &&
      fs.existsSync(path.join(distDir, "components", "pages", "LogsView.js"))
    );
  }

  return true;
}

function workspaceRuntimePackageLooksBuilt(packageName, packageDir) {
  const distDir = path.join(packageDir, "dist");
  if (!fs.existsSync(distDir)) return false;
  if (!workspaceRuntimePackageMarkersPresent(packageName, distDir))
    return false;

  // Presence of the marker files isn't enough — a dist built from older sources
  // would silently reuse stale runtime code (issue #9309). Reuse only when the
  // dist is at least as new as the package's src. ELIZA_DESKTOP_TRUST_RUNTIME_-
  // PACKAGE_DIST=1 bypasses the mtime check for environments where checkout
  // mtimes are unreliable.
  if (process.env.ELIZA_DESKTOP_TRUST_RUNTIME_PACKAGE_DIST === "1") return true;
  const srcDir = path.join(packageDir, "src");
  if (!fs.existsSync(srcDir)) return true;
  const srcMtime = maxMtimeUnder(srcDir);
  const distMtime = maxMtimeUnder(distDir);
  if (srcMtime > distMtime) {
    console.log(
      `[desktop-build] ${packageName} dist is stale (src newer than dist) — rebuilding`,
    );
    return false;
  }
  return true;
}

function ensureWorkspaceRuntimePackagesBuilt() {
  ensureWorkspaceRuntimePackageBuilt("@elizaos/core", CORE_PACKAGE_DIR);
  ensureWorkspaceRuntimePackageBuilt("@elizaos/shared", SHARED_PACKAGE_DIR);
  ensureWorkspaceRuntimePackageBuilt(
    "@elizaos/cloud-sdk",
    CLOUD_SDK_PACKAGE_DIR,
  );
  ensureWorkspaceRuntimePackageBuilt("@elizaos/security", SECURITY_PACKAGE_DIR);
  ensureWorkspaceRuntimePackageBuilt("@elizaos/vault", VAULT_PACKAGE_DIR);
  ensureWorkspaceRuntimePackageBuilt(
    "@elizaos/plugin-remote-manifest",
    PLUGIN_REMOTE_MANIFEST_PACKAGE_DIR,
  );
  ensureWorkspaceRuntimePackageBuilt(
    "@elizaos/plugin-agent-orchestrator",
    PLUGIN_AGENT_ORCHESTRATOR_PACKAGE_DIR,
  );
  ensureWorkspaceRuntimePackageBuilt(
    "@elizaos/app-model-tester",
    APP_MODEL_TESTER_PACKAGE_DIR,
  );
  ensureWorkspaceRuntimePackageBuilt("@elizaos/ui", UI_PACKAGE_DIR);
  ensureWorkspaceRuntimePackageBuilt(
    "@elizaos/plugin-local-inference",
    PLUGIN_LOCAL_INFERENCE_PACKAGE_DIR,
  );
  ensureWorkspaceRuntimePackageBuilt(
    "@elizaos/plugin-worker-runtime",
    PLUGIN_WORKER_RUNTIME_PACKAGE_DIR,
  );
  ensureWorkspaceRuntimePackageBuilt("@elizaos/agent", AGENT_PACKAGE_DIR);
  ensureWorkspaceRuntimePackageBuilt("@elizaos/app-core", APP_CORE_PACKAGE_DIR);
}

function desktopRendererBuildEnv() {
  const env = {
    ...process.env,
    VITE_APP_VARIANT: variant,
    ELIZA_BUILD_VARIANT: buildVariant,
  };
  if (env.ELIZA_SKIP_LOCAL_UPSTREAMS !== "1") {
    env.ELIZA_FORCE_LOCAL_UPSTREAMS = "1";
  }
  return env;
}

function runtimeCopyArgs() {
  return [
    RUNTIME_COPY_SCRIPT,
    "--scan-dir",
    "dist",
    "--target-dist",
    "dist",
    ...excludedOptionalPacks.flatMap((pack) => [
      "--exclude-optional-pack",
      pack,
    ]),
  ];
}

function runtimeCopyLabel() {
  return excludedOptionalPacks.length > 0
    ? `Bundling runtime node_modules into dist (profile=${buildProfile}, excluding: ${excludedOptionalPacks.join(", ")})`
    : `Bundling runtime node_modules into dist (profile=${buildProfile})`;
}

function formatGiB(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

function directorySizeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;

  let total = 0;
  const visit = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isDirectory()) {
        visit(entryPath);
        continue;
      }
      total += stat.size;
    }
  };

  visit(dir);
  return total;
}

function assertRuntimeCopyDiskHeadroom() {
  if (typeof fs.statfsSync !== "function") return;

  const stat = fs.statfsSync(ROOT);
  const availableBytes = Number(stat.bavail) * Number(stat.bsize);
  const minimumBytes = Number.parseInt(
    process.env.ELIZA_DESKTOP_MIN_FREE_BYTES ?? `${4 * 1024 * 1024 * 1024}`,
    10,
  );
  if (!Number.isFinite(minimumBytes) || minimumBytes <= 0) return;
  if (availableBytes >= minimumBytes) return;

  const existingRuntimeNodeModules = path.join(ROOT, "dist", "node_modules");
  const recyclableBytes = directorySizeBytes(existingRuntimeNodeModules);
  const effectiveAvailableBytes = availableBytes + recyclableBytes;
  if (effectiveAvailableBytes >= minimumBytes) {
    if (recyclableBytes > 0) {
      console.log(
        `[desktop-build] Runtime copy has ${formatGiB(availableBytes)} free plus ${formatGiB(recyclableBytes)} recyclable generated node_modules output.`,
      );
    }
    return;
  }

  fail(
    [
      `Desktop runtime bundling needs at least ${formatGiB(minimumBytes)} free before copying node_modules; only ${formatGiB(availableBytes)} is available (${formatGiB(effectiveAvailableBytes)} after replacing generated dist/node_modules).`,
      "Free disk space, remove stale build outputs such as dist/.turbo, or rerun with ELIZA_DESKTOP_MIN_FREE_BYTES=0 if you intentionally want to risk a partial copy.",
    ].join(" "),
  );
}

function copyRuntimeNodeModulesWithRetry() {
  assertRuntimeCopyDiskHeadroom();

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = runBunStatus(runtimeCopyArgs(), {
      cwd: ROOT,
      label:
        attempt === 1
          ? runtimeCopyLabel()
          : `${runtimeCopyLabel()} (retry ${attempt}/${maxAttempts})`,
    });
    if (result.status === 0) {
      return;
    }
    if (attempt < maxAttempts) {
      console.warn(
        `[desktop-build] ${result.command} exited ${result.status}; retrying runtime node_modules bundle`,
      );
      continue;
    }
    fail(
      `${result.command} failed with exit code ${result.status}`,
      result.status,
    );
  }
}

const FUSED_LIB_STAGE_SCRIPT = path.join(
  SCRIPT_DIR,
  "stage-desktop-fused-lib.mjs",
);
// "auto" → the stager picks the host's best backend (Metal on macOS, CUDA when
// nvcc is present, else CPU) with the CPU fallback always baked in, so a local
// `--build-fused-lib` produces "CPU + platform GPU" for the build host.
const FUSED_LIB_VARIANT =
  getArgValue(args, "fused-lib-variant") ??
  process.env.ELIZA_DESKTOP_FUSED_LIB_VARIANT ??
  "auto";
// Where the fused lib is staged so the Electrobun copy (dist -> eliza-dist)
// carries it; app-core's runtime probe (ensureBundledFusedLibDir) then finds
// `<eliza-dist>/local-inference/lib` with no env wiring.
const FUSED_LIB_OUT_DIR = path.join(ROOT, "dist", "local-inference", "lib");

function fusedLibFilenames() {
  if (process.platform === "darwin") return ["libelizainference.dylib"];
  if (process.platform === "win32")
    return ["elizainference.dll", "libelizainference.dll"];
  return ["libelizainference.so"];
}

function fusedLibAlreadyStaged() {
  return fusedLibFilenames().some((name) =>
    fs.existsSync(path.join(FUSED_LIB_OUT_DIR, name)),
  );
}

// Provenance for the staged fused lib so the reuse gate never silently reuses a
// lib built for a DIFFERENT variant/platform than this build targets (#9309).
const FUSED_LIB_SIDECAR = path.join(FUSED_LIB_OUT_DIR, "staged-fused-lib.json");

function readFusedLibSidecar() {
  try {
    return JSON.parse(fs.readFileSync(FUSED_LIB_SIDECAR, "utf8"));
  } catch {
    return null;
  }
}

function writeFusedLibSidecar() {
  fs.mkdirSync(FUSED_LIB_OUT_DIR, { recursive: true });
  fs.writeFileSync(
    FUSED_LIB_SIDECAR,
    `${JSON.stringify(
      {
        variant: FUSED_LIB_VARIANT,
        platform: process.platform,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * A staged lib whose provenance sidecar names a DIFFERENT variant/platform than
 * this build targets — a confirmed wrong-variant lib we must not ship.
 */
function fusedLibStagedVariantMismatch() {
  if (!fusedLibAlreadyStaged()) return false;
  const sidecar = readFusedLibSidecar();
  if (!sidecar) return false; // no provenance ≠ wrong provenance
  return (
    sidecar.variant !== FUSED_LIB_VARIANT ||
    sidecar.platform !== process.platform
  );
}

/**
 * Whether a staged lib can be reused. A lib with a matching sidecar is reused; a
 * sidecar-less lib (e.g. a prebuilt artifact a CI step dropped into
 * dist/local-inference/lib) is TRUSTED and reused — we can't confirm its variant
 * but it was deliberately staged. Only a sidecar that names a different
 * variant/platform forces a rebuild.
 */
function fusedLibStagedForCurrentVariant() {
  return fusedLibAlreadyStaged() && !fusedLibStagedVariantMismatch();
}

const FUSED_LIB_FORK_DIR = path.join(
  PLUGIN_LOCAL_INFERENCE_PACKAGE_DIR,
  "native",
  "llama.cpp",
);

/**
 * Ensure the native llama.cpp fork submodule is checked out (the fused build
 * needs its CMakeLists). Release CI checks out with `submodules: false`, so the
 * fork is absent; init just the one path on demand rather than requiring the
 * workflow to fetch every submodule. Returns true if the fork is present after.
 */
function ensureFusedLibSubmodule() {
  if (fs.existsSync(path.join(FUSED_LIB_FORK_DIR, "CMakeLists.txt")))
    return true;
  const rel = path.relative(ROOT, FUSED_LIB_FORK_DIR).split(path.sep).join("/");
  console.log(
    `[desktop-build] Native fork missing; initializing submodule ${rel}`,
  );
  // NB: no --depth/shallow here — a shallow submodule fetch fails with
  // "Server does not allow request for unadvertised object <sha>" when the
  // recorded gitlink commit isn't the remote tip, which is common. Reliability
  // over speed: this path must actually produce the fork.
  spawnSync(
    "git",
    ["-C", ROOT, "submodule", "update", "--init", "--recursive", rel],
    { stdio: "inherit" },
  );
  return fs.existsSync(path.join(FUSED_LIB_FORK_DIR, "CMakeLists.txt"));
}

/**
 * Whether the already-staged fused lib is OLDER than the native fork source it
 * was built from — the classic "dev→device stale native lib" trap: a rebuild
 * landed in the fork's build dir (or the fork submodule was updated) but the
 * copy staged into the app bundle was never refreshed, so the app ships a lib
 * that no longer matches the source. Mirrors the renderer freshness guard
 * (assertRendererRebuiltSince). Skipped when the fork isn't checked out (a
 * sidecar-less prebuilt drop-in is trusted, same as the variant gate).
 */
function fusedLibSourceStaleness() {
  if (!fusedLibAlreadyStaged())
    return { stale: false, reason: "no staged lib" };
  if (!fs.existsSync(path.join(FUSED_LIB_FORK_DIR, "CMakeLists.txt")))
    return { stale: false, reason: "fork not checked out (trust staged)" };
  const staged = fusedLibFilenames()
    .map((n) => path.join(FUSED_LIB_OUT_DIR, n))
    .find((p) => fs.existsSync(p));
  if (!staged) return { stale: false, reason: "no staged lib" };
  return artifactStaleness(staged, {
    sourceDirs: [
      path.join(FUSED_LIB_FORK_DIR, "tools", "kokoro"),
      path.join(FUSED_LIB_FORK_DIR, "tools", "omnivoice"),
      path.join(FUSED_LIB_FORK_DIR, "tools", "tts"),
      path.join(FUSED_LIB_FORK_DIR, "src"),
      path.join(FUSED_LIB_FORK_DIR, "ggml", "src"),
    ],
    sourceFiles: [path.join(FUSED_LIB_FORK_DIR, "CMakeLists.txt")],
  });
}

/**
 * Build + stage the fused `libelizainference` into the desktop bundle so a
 * COMPILED app ships with working local inference — no first-run download, no
 * manual `build:fused-desktop`. The "auto" variant bakes CPU in and layers the
 * host's best GPU backend (Metal on macOS; CUDA when nvcc is present; else CPU),
 * so it works on every host.
 *
 * Gating:
 *   - Reuses an already-staged lib (a prior build, or a prebuilt artifact a CI
 *     step dropped into dist/local-inference/lib).
 *   - Builds when explicitly asked (`--build-fused-lib` /
 *     ELIZA_DESKTOP_BUILD_FUSED_LIB=1) OR automatically on CI release builds
 *     (CI=true) — initializing the native submodule on demand. Off for plain
 *     local dev builds (keeps iteration fast).
 *   - An EXPLICIT request hard-fails if it can't produce the lib (unless
 *     ELIZA_DESKTOP_FUSED_LIB_OPTIONAL=1). A CI auto-build is BEST-EFFORT: a
 *     missing toolchain or a build failure warns and ships without the lib
 *     (cloud fallback) rather than breaking the release. Set
 *     ELIZA_DESKTOP_FUSED_LIB_REQUIRED=1 to make CI auto-builds hard-fail too.
 */
function stageDesktopFusedLib() {
  const explicitlyRequested =
    getBooleanArg(args, "build-fused-lib") ||
    process.env.ELIZA_DESKTOP_BUILD_FUSED_LIB === "1";
  const ciAutoBuild = process.env.CI === "true";
  const shouldBuild = explicitlyRequested || ciAutoBuild;
  const required =
    (explicitlyRequested ||
      process.env.ELIZA_DESKTOP_FUSED_LIB_REQUIRED === "1") &&
    process.env.ELIZA_DESKTOP_FUSED_LIB_OPTIONAL !== "1";

  // Never reuse a staged lib that is OLDER than the fork source it was built
  // from — that is the "stale native lib reaches the device" bug. Treated the
  // same as a wrong-variant lib: rebuilt when we can, dropped otherwise.
  const sourceStale = fusedLibSourceStaleness();

  if (
    fusedLibStagedForCurrentVariant() &&
    !sourceStale.stale &&
    process.env.ELIZA_DESKTOP_REBUILD_FUSED_LIB !== "1"
  ) {
    console.log(
      `[desktop-build] Reusing already-staged fused lib in ${FUSED_LIB_OUT_DIR} ` +
        `(variant=${FUSED_LIB_VARIANT}, ${process.platform})`,
    );
    return;
  }

  if (sourceStale.stale) {
    console.warn(
      `[desktop-build] Staged fused lib is STALE vs the native fork source ` +
        `(${sourceStale.reason}). It will be rebuilt/dropped so no stale native ` +
        `lib is shipped to a device.`,
    );
  }

  // A staged lib whose sidecar names a DIFFERENT variant/platform is a confirmed
  // wrong-variant lib — never silently reused. (A sidecar-less drop-in is trusted
  // and was already reused above.)
  const variantMismatch = fusedLibStagedVariantMismatch();
  if (variantMismatch) {
    const sidecar = readFusedLibSidecar();
    console.warn(
      `[desktop-build] Staged fused lib does not match this build ` +
        `(want variant=${FUSED_LIB_VARIANT}/${process.platform}, found ` +
        `${sidecar.variant}/${sidecar.platform}). ` +
        `It will be rebuilt to avoid shipping a wrong-variant native lib.`,
    );
  }

  if (!shouldBuild) {
    if (variantMismatch || sourceStale.stale) {
      // Can't rebuild here (no toolchain requested) and the staged lib is the
      // wrong variant OR stale vs source — drop it so the app cleanly falls back
      // to cloud inference instead of dlopen()-ing a mismatched/stale backend on
      // the device.
      for (const name of fusedLibFilenames()) {
        fs.rmSync(path.join(FUSED_LIB_OUT_DIR, name), { force: true });
      }
      fs.rmSync(FUSED_LIB_SIDECAR, { force: true });
      console.warn(
        `[desktop-build] Removed the ${sourceStale.stale ? "stale" : "mismatched"} fused lib; ` +
          "this build ships without local inference. Rebuild with --build-fused-lib " +
          "to stage a fresh, matching lib.",
      );
      return;
    }
    console.log(
      "[desktop-build] Skipping fused libelizainference build (local-inference will be " +
        "unavailable in this build). Enable with --build-fused-lib or " +
        "ELIZA_DESKTOP_BUILD_FUSED_LIB=1 (CI release builds enable it automatically).",
    );
    return;
  }

  // Surface a hard failure for an explicit request that can't proceed; otherwise
  // warn and ship without the lib so a release never breaks on the native build.
  const giveUp = (reason) => {
    if (required) {
      fail(
        `Cannot build the fused libelizainference for the desktop bundle: ${reason}. ` +
          "Install the toolchain / init submodules, or set " +
          "ELIZA_DESKTOP_FUSED_LIB_OPTIONAL=1 to ship without local inference.",
      );
    }
    console.warn(
      `[desktop-build] Skipping fused libelizainference build — ${reason}. ` +
        "The compiled app will fall back to cloud inference.",
    );
  };

  if (!which("cmake")) {
    giveUp("cmake not found on PATH");
    return;
  }
  if (!ensureFusedLibSubmodule()) {
    giveUp(`native fork not available at ${FUSED_LIB_FORK_DIR}`);
    return;
  }

  fs.mkdirSync(FUSED_LIB_OUT_DIR, { recursive: true });
  run(
    "node",
    [
      FUSED_LIB_STAGE_SCRIPT,
      "--variant",
      FUSED_LIB_VARIANT,
      "--out",
      FUSED_LIB_OUT_DIR,
    ],
    {
      cwd: ROOT,
      // A CI auto-build that fails must not abort the whole release; an explicit
      // request is allowed to hard-fail.
      allowFailure: !required,
      label: `Building + staging fused libelizainference (${FUSED_LIB_VARIANT}) into the desktop bundle`,
    },
  );

  if (!fusedLibAlreadyStaged()) {
    giveUp("the build produced no lib in the output dir");
    return;
  }
  // Record provenance so a later build with a different variant/platform won't
  // silently reuse this lib.
  writeFusedLibSidecar();
}

function stageDesktopBuild() {
  ensureWorkspaceCheckoutPresent();
  ensureAppDirs();

  ensureRootRuntimeBundle();
  ensureWorkspaceRuntimePackagesBuilt();

  // Build + bundle the fused local-inference native lib so the packaged app
  // serves local AI out of the box. Gated (see stageDesktopFusedLib) so plain
  // dev builds stay fast; auto-built best-effort on CI release builds.
  stageDesktopFusedLib();

  runBun([WRITE_BUILD_INFO_SCRIPT], {
    cwd: ROOT,
    label: "Writing build metadata",
  });

  copyRuntimeNodeModulesWithRetry();

  // `bun install` for these workspaces can emit benign EEXIST errors when
  // file: deps overlap with manually-linked @elizaos/* symlinks. The links
  // get created successfully; bun exits non-zero only because of the dup
  // attempt. Tolerate so the build can proceed.
  runOptionalWorkspaceInstall(
    APP_DIR,
    "Ensuring app workspace dependencies are installed",
  );

  runOptionalWorkspaceInstall(
    ELECTROBUN_DIR,
    "Ensuring Electrobun workspace dependencies are installed",
  );

  // Capture the moment the renderer build starts so we can prove afterward that
  // a FRESH bundle was produced — not a stale dist silently reused (issue #9309).
  const rendererBuildStartedAt = Date.now() - 1000;
  runBunPackageBinary("vite", ["build"], {
    cwd: APP_DIR,
    env: desktopRendererBuildEnv(),
    label: `Building renderer bundle (VITE_APP_VARIANT=${variant}, ELIZA_BUILD_VARIANT=${buildVariant})`,
  });
  // Fail loudly if the renderer manifest is missing or predates this build (a
  // cached/stale dist was reused) or was built for a different variant.
  assertRendererRebuiltSince(path.join(APP_DIR, "dist"), {
    notBefore: rendererBuildStartedAt,
    expectVariant: buildVariant,
    label: "desktop",
  });

  runDesktopPreflight();

  runBun(["run", "build:preload"], {
    cwd: ELECTROBUN_DIR,
    label: "Building Electrobun preload bridge",
  });

  if (process.platform === "darwin") {
    // build:native-effects shells to `xcrun clang++` (Xcode Command Line
    // Tools). On a dev machine without the CLT the compile would hard-fail
    // deep in the stage; skip gracefully unless the build was explicitly asked
    // for the native bits (CI passes --build-native-effects on a tooled runner).
    const clangAvailable =
      which("xcrun") && runCapture("xcrun", ["-f", "clang++"]).status === 0;
    if (!clangAvailable) {
      if (nativeEffectsExplicitlyRequested) {
        fail(
          "Native macOS effects build requires the Xcode Command Line Tools " +
            "(xcrun clang++), which are missing. Install them with " +
            "`xcode-select --install`, or omit --build-native-effects / " +
            "ELIZA_DESKTOP_BUILD_NATIVE_EFFECTS=1.",
        );
      }
      console.warn(
        "[desktop-build] Skipping native macOS effects dylib — Xcode Command " +
          "Line Tools (xcrun clang++) not found. Request the native build " +
          "explicitly with --build-native-effects to make this a hard error.",
      );
    } else {
      runBun(["run", "build:native-effects"], {
        cwd: ELECTROBUN_DIR,
        label: "Building native macOS effects dylib",
      });
    }
  }
}

function embedWindowsIcons() {
  const buildDir = path.join(ELECTROBUN_DIR, "build");
  const iconPath = path.join(ELECTROBUN_DIR, "assets", "appIcon.ico");
  if (!fs.existsSync(iconPath)) {
    console.log("[desktop-build] No appIcon.ico found, skipping icon embed");
    return;
  }
  // Find the build output directory (e.g. dev-win-x64/elizaOS-dev/bin)
  let binDir;
  for (const variant of fs.readdirSync(buildDir)) {
    const variantDir = path.join(buildDir, variant);
    if (!fs.statSync(variantDir).isDirectory()) continue;
    for (const app of fs.readdirSync(variantDir)) {
      const candidate = path.join(variantDir, app, "bin");
      if (fs.existsSync(path.join(candidate, "launcher.exe"))) {
        binDir = candidate;
        break;
      }
    }
    if (binDir) break;
  }
  if (!binDir) {
    console.log("[desktop-build] Could not find launcher.exe in build output");
    return;
  }
  // Find rcedit-x64.exe in node_modules (cross-platform, no shell deps).
  let rceditBin;
  for (const base of [ELECTROBUN_DIR, ROOT]) {
    const rceditDir = path.join(base, "node_modules", "rcedit", "bin");
    const candidate = path.join(rceditDir, "rcedit-x64.exe");
    if (fs.existsSync(candidate)) {
      rceditBin = candidate;
      break;
    }
    // Also check bun's flat cache layout
    try {
      for (const entry of fs.readdirSync(
        path.join(base, "node_modules", ".bun"),
      )) {
        if (!entry.startsWith("rcedit@")) continue;
        const nested = path.join(
          base,
          "node_modules",
          ".bun",
          entry,
          "node_modules",
          "rcedit",
          "bin",
          "rcedit-x64.exe",
        );
        if (fs.existsSync(nested)) {
          rceditBin = nested;
          break;
        }
      }
    } catch {}
    if (rceditBin) break;
  }
  if (!rceditBin) {
    console.log(
      "[desktop-build] rcedit-x64.exe not found — install rcedit as a devDep to embed Windows icons",
    );
    return;
  }
  // Embed into all executables — CEF helper processes create the visible
  // windows on Windows, so they need the icon too for it to show in the
  // title bar and taskbar.
  const exeFiles = fs.readdirSync(binDir).filter((f) => f.endsWith(".exe"));
  for (const exe of exeFiles) {
    const exePath = path.join(binDir, exe);
    if (!fs.existsSync(exePath)) continue;
    const result = spawnSync(rceditBin, [exePath, "--set-icon", iconPath], {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 15000,
    });
    if (result.status === 0) {
      console.log(`[desktop-build] Embedded icon into ${exe}`);
    } else {
      console.log(
        `[desktop-build] Warning: failed to embed icon into ${exe}: ${result.stderr || result.error}`,
      );
    }
  }
}

function mirrorTreePreservingSymlinks(src, dst) {
  const srcStat = fs.lstatSync(src);
  if (srcStat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(src);
    const dstLstat = fs.lstatSync(dst, { throwIfNoEntry: false });
    if (dstLstat) {
      try {
        if (dstLstat.isDirectory() && !dstLstat.isSymbolicLink()) {
          removePathRecursive(dst, "desktop mirror directory cleanup");
        } else {
          fs.unlinkSync(dst);
        }
      } catch {}
    }
    try {
      fs.symlinkSync(linkTarget, dst);
    } catch {
      try {
        fs.cpSync(src, dst, {
          recursive: true,
          force: true,
          dereference: true,
        });
      } catch {}
    }
    return;
  }
  if (srcStat.isDirectory()) {
    const dstLstat = fs.lstatSync(dst, { throwIfNoEntry: false });
    if (dstLstat?.isSymbolicLink()) {
      fs.unlinkSync(dst);
    }
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      mirrorTreePreservingSymlinks(
        path.join(src, entry),
        path.join(dst, entry),
      );
    }
    return;
  }
  const dstLstat = fs.lstatSync(dst, { throwIfNoEntry: false });
  if (dstLstat) {
    try {
      fs.unlinkSync(dst);
    } catch {}
  }
  try {
    fs.linkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

function mirrorCanonicalToLegacy(name) {
  if (LEGACY_ELECTROBUN_DIR === ELECTROBUN_DIR) return;
  const src = path.join(ELECTROBUN_DIR, name);
  const dst = path.join(LEGACY_ELECTROBUN_DIR, name);
  if (!fs.existsSync(src)) return;
  const dstLstat = fs.lstatSync(dst, { throwIfNoEntry: false });
  if (dstLstat?.isSymbolicLink()) {
    fs.unlinkSync(dst);
  }
  fs.mkdirSync(LEGACY_ELECTROBUN_DIR, { recursive: true });
  console.log(
    `[desktop-build] Mirroring electrobun ${name}/ from canonical to legacy compatibility path`,
  );
  mirrorTreePreservingSymlinks(src, dst);
}

function packageDesktopBuild() {
  ensureAppDirs();
  const packageArgs = ["build"];
  if (buildEnv) {
    packageArgs.push(`--env=${buildEnv}`);
  }

  if (process.platform === "darwin") {
    const macArch = process.arch === "arm64" ? "arm64" : "x64";
    // Electrobun's macOS builder removes this folder without force.
    fs.mkdirSync(
      path.join(
        ELECTROBUN_DIR,
        "build",
        `${buildEnv || "dev"}-macos-${macArch}`,
      ),
      { recursive: true },
    );
  }

  const packageEnv = {
    ...process.env,
    ELECTROBUN_SKIP_CODESIGN: process.env.ELECTROBUN_SKIP_CODESIGN ?? "1",
    ELIZA_ELECTROBUN_REPO_ROOT: process.env.ELIZA_ELECTROBUN_REPO_ROOT ?? ROOT,
    ELIZA_BUILD_VARIANT: buildVariant,
    PATH: `${path.join(ELECTROBUN_DIR, "scripts", "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    ...appIdentityEnv(APP_DIR),
    ...(stageMacosReleaseApp && process.platform === "darwin"
      ? { ELIZA_ELECTROBUN_NOTARIZE: "0" }
      : {}),
  };

  runElectrobun(packageArgs, {
    cwd: ELECTROBUN_DIR,
    env: packageEnv,
    label: buildEnv
      ? `Packaging Electrobun app (env=${buildEnv})`
      : "Packaging Electrobun app",
  });

  // The legacy compatibility path (APP_DIR/electrobun) is not read by any
  // production code — only docs and this mirror fn reference it (the inno
  // installer takes BuildDir as a param; copy-runtime-node-modules reads the
  // canonical platforms/electrobun path). Mirroring the entire ~2.3 GB /
  // ~110k-file build tree on every package build is pure waste, so make it
  // opt-in (default off). Set ELIZA_ELECTROBUN_MIRROR_LEGACY=1 to restore it.
  if (process.env.ELIZA_ELECTROBUN_MIRROR_LEGACY === "1") {
    mirrorCanonicalToLegacy("build");
    mirrorCanonicalToLegacy("artifacts");
  }

  // Re-embed the icon from a locally resolved rcedit as a post-build repair
  // step so every Windows helper executable gets the app icon.
  if (process.platform === "win32") {
    embedWindowsIcons();
  }

  if (
    process.platform === "darwin" &&
    packageEnv.ELECTROBUN_SKIP_CODESIGN === "1"
  ) {
    const appBundlePath = findLatestMacAppBundle();
    runBun(["scripts/local-adhoc-sign-macos.ts", appBundlePath], {
      cwd: ELECTROBUN_DIR,
      env: packageEnv,
      label: `Applying local ad-hoc Eliza signing (${path.basename(appBundlePath)})`,
    });
  }

  // Mac App Store post-package codesign: when building the store variant on
  // macOS with real signing enabled, walk the bundle and re-sign every nested
  // Mach-O with the narrowest applicable entitlements. Most helpers get
  // mas-child.entitlements, the Bun helper gets mas-bun.entitlements
  // (Bun-scoped allow-jit), and the parent .app gets mas.entitlements.
  // Required because Electrobun's config exposes only one entitlements field;
  // helpers must inherit explicitly.
  if (
    process.platform === "darwin" &&
    buildVariant === "store" &&
    packageEnv.ELECTROBUN_SKIP_CODESIGN !== "1"
  ) {
    const appBundlePath = findLatestMacAppBundle();
    const codesignArgs = [
      path.join(SCRIPT_DIR, "codesign-mas.mjs"),
      `--app=${appBundlePath}`,
    ];
    if (process.env.ELIZA_MAS_INSTALLER_IDENTITY) {
      codesignArgs.push(
        `--installer-identity=${process.env.ELIZA_MAS_INSTALLER_IDENTITY}`,
      );
    }
    run("node", codesignArgs, {
      cwd: ROOT,
      env: packageEnv,
      label: `MAS post-package codesign (${path.basename(appBundlePath)})`,
    });

    // Opt-in post-sign verification. Walks every Mach-O and asserts the
    // tightened entitlement set is what actually shipped — protects against
    // future regressions in the signer or in the entitlement plists. Skipped
    // by default because most builds don't want the extra walk; CI store
    // builds and developers debugging MAS signing should enable it.
    if (
      getBooleanArg(args, "verify-mas") ||
      process.env.ELIZA_VERIFY_MAS === "1"
    ) {
      run(
        "node",
        [path.join(SCRIPT_DIR, "mas-smoke.mjs"), `--app=${appBundlePath}`],
        {
          cwd: ROOT,
          env: packageEnv,
          label: `MAS entitlements verification (${path.basename(appBundlePath)})`,
        },
      );
    }
  }

  if (stageMacosReleaseApp && process.platform === "darwin") {
    run(
      "bash",
      [STAGE_MACOS_RELEASE_SCRIPT, path.join(ELECTROBUN_DIR, "artifacts")],
      {
        cwd: ROOT,
        env: {
          ...packageEnv,
          ELECTROBUN_SKIP_CODESIGN: process.env.ELECTROBUN_SKIP_CODESIGN ?? "1",
          ELIZA_STAGE_MACOS_SKIP_DMG:
            process.env.ELIZA_STAGE_MACOS_SKIP_DMG ?? "1",
        },
        label: "Staging direct macOS release app",
      },
    );
  }
}

function runDesktopBuild() {
  const electrobunArgs = ["run"];
  runElectrobun(electrobunArgs, {
    cwd: ELECTROBUN_DIR,
    label: "Launching packaged Electrobun app",
  });
}

function printUsage() {
  console.log(`Usage: node eliza/packages/app-core/scripts/desktop-build.mjs <command> [options]

Commands:
  preflight Run desktop preflight checks (Bun + electrobun/view resolution)
  stage    Build runtime/assets/preload inputs for desktop packaging
  package  Run electrobun build against the staged desktop inputs
  build    Run stage + package
  run      Run stage + package + electrobun run

Options:
  --profile <full|no-streaming>    Optional desktop packaging profile (default: full)
  --variant <base|companion|full>  Renderer build variant (default: base)
  --build-variant <store|direct>   Distribution variant (default: direct).
                                   "store" wires macOS App Sandbox entitlements
                                   and forces Cloud hosting at runtime; "direct"
                                   keeps current unsandboxed behavior.
  --env <channel>                  Electrobun build env (e.g. canary, stable)
  --stage-macos-release-app        Stage a direct macOS .app + DMG from the Electrobun build output
  --exclude-optional-pack <name>   Exclude a manifest-classified optional capability pack during staging
  --build-native-effects           Require the native macOS effects dylib build (hard-fail if Xcode CLT is missing)
  --verify-mas                     After MAS codesign, walk the bundle and verify the tightened
                                   entitlements via mas-smoke.mjs. Off by default; ELIZA_VERIFY_MAS=1
                                   also enables it.

Environment:
  ELIZA_DESKTOP_COMMAND_PREFIX    Prefix every spawned command, e.g. "arch -x86_64"
  ELIZA_VERIFY_MAS=1              Enable mas-smoke entitlement verification on store builds.
`);
}

function runCommand() {
  switch (command) {
    case "preflight":
      runDesktopPreflight();
      break;
    case "stage":
      stageDesktopBuild();
      break;
    case "package":
      packageDesktopBuild();
      break;
    case "build":
      stageDesktopBuild();
      packageDesktopBuild();
      break;
    case "run":
      stageDesktopBuild();
      packageDesktopBuild();
      runDesktopBuild();
      break;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      fail(`Unknown command: ${command}`);
  }
}

if (["preflight", "help", "--help", "-h"].includes(command)) {
  runCommand();
} else {
  withDesktopBuildLock(runCommand);
}
