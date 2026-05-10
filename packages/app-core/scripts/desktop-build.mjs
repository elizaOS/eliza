#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectrobunDir, resolveMainAppDir } from "./lib/app-dir.mjs";
import {
  buildWindowsRepairSteps,
  classifyElectrobunViewFailure,
  findElectrobunManifestPath,
  hasElectrobunViewExport,
  isSupportedBunVersion,
} from "./lib/desktop-preflight.mjs";
import { appIdentityEnv } from "./lib/read-app-identity.mjs";

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
const RUNTIME_COPY_SCRIPT = fs.existsSync(
  path.join(ROOT, "scripts", "copy-runtime-node-modules.ts"),
)
  ? path.join(ROOT, "scripts", "copy-runtime-node-modules.ts")
  : path.join(SCRIPT_DIR, "copy-runtime-node-modules.ts");

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "build";
const flagStart = command === "build" && argv[0]?.startsWith("--") ? 0 : 1;
const args = argv.slice(flagStart);

const buildProfile =
  getArgValue(args, "profile") ?? process.env.ELIZA_DESKTOP_PROFILE ?? "full";
const variant =
  getArgValue(args, "variant") ?? process.env.VITE_APP_VARIANT ?? "base";
const buildEnv = getArgValue(args, "env") ?? process.env.BUILD_ENV ?? "";
const buildWhisper = getBooleanArg(args, "build-whisper");
const stageMacosReleaseApp = getBooleanArg(args, "stage-macos-release-app");
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
  const { cwd = ROOT, env = process.env, label } = options;
  const invocation = buildInvocation(commandName, commandArgs);
  const rendered = [invocation.command, ...invocation.args].join(" ");
  console.log(`[desktop-build] ${label ?? rendered}`);

  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    fail(
      `${rendered} failed with exit code ${result.status ?? 1}`,
      result.status ?? 1,
    );
  }
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

function runNode(commandArgs, options = {}) {
  const node = which("node") ?? process.execPath;
  run(node, commandArgs, options);
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

function runElectrobun(commandArgs, options = {}) {
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

function stageDesktopBuild() {
  ensureAppDirs();

  runPackageBinary("tsdown", [], {
    cwd: ROOT,
    label: "Building core runtime bundle with tsdown",
  });

  runNode(["--import", "tsx", "scripts/write-build-info.ts"], {
    cwd: ROOT,
    label: "Writing build metadata",
  });

  runNode(
    [
      "--import",
      "tsx",
      RUNTIME_COPY_SCRIPT,
      "--scan-dir",
      "dist",
      "--target-dist",
      "dist",
      ...excludedOptionalPacks.flatMap((pack) => [
        "--exclude-optional-pack",
        pack,
      ]),
    ],
    {
      cwd: ROOT,
      label:
        excludedOptionalPacks.length > 0
          ? `Bundling runtime node_modules into dist (profile=${buildProfile}, excluding: ${excludedOptionalPacks.join(", ")})`
          : `Bundling runtime node_modules into dist (profile=${buildProfile})`,
    },
  );

  runBun(["install", "--ignore-scripts"], {
    cwd: APP_DIR,
    label: "Ensuring app workspace dependencies are installed",
  });

  runBun(["install", "--ignore-scripts"], {
    cwd: ELECTROBUN_DIR,
    label: "Ensuring Electrobun workspace dependencies are installed",
  });

  runPackageBinary("vite", ["build"], {
    cwd: APP_DIR,
    env: { ...process.env, VITE_APP_VARIANT: variant },
    label: `Building renderer bundle (VITE_APP_VARIANT=${variant})`,
  });

  runDesktopPreflight();

  runBun(["run", "build:preload"], {
    cwd: ELECTROBUN_DIR,
    label: "Building Electrobun preload bridge",
  });

  if (process.platform === "darwin") {
    runBun(["run", "build:native-effects"], {
      cwd: ELECTROBUN_DIR,
      label: "Building native macOS effects dylib",
    });
  }

  if (
    buildWhisper &&
    (process.platform === "darwin" || process.platform === "linux")
  ) {
    runBun(["run", "build:whisper"], {
      cwd: ELECTROBUN_DIR,
      label: "Building whisper.cpp native binary",
    });
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
          fs.rmSync(dst, { force: true, recursive: true });
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
  const packageArgs = ["run", "build"];
  if (buildEnv) {
    packageArgs.push("--", `--env=${buildEnv}`);
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
    ELIZA_ELECTROBUN_REPO_ROOT: process.env.ELIZA_ELECTROBUN_REPO_ROOT ?? ROOT,
    ...appIdentityEnv(APP_DIR),
    ...(stageMacosReleaseApp && process.platform === "darwin"
      ? { ELIZA_ELECTROBUN_NOTARIZE: "0" }
      : {}),
  };

  runBun(packageArgs, {
    cwd: ELECTROBUN_DIR,
    env: packageEnv,
    label: buildEnv
      ? `Packaging Electrobun app (env=${buildEnv})`
      : "Packaging Electrobun app",
  });

  mirrorCanonicalToLegacy("build");
  mirrorCanonicalToLegacy("artifacts");

  // Electrobun's built-in rcedit call references a CI-local D:\ path that
  // doesn't exist on developer machines. Re-embed the icon from a locally
  // resolved rcedit as a post-build repair step.
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
  --env <channel>                  Electrobun build env (e.g. canary, stable)
  --build-whisper                  Build whisper.cpp on macOS/Linux during stage
  --stage-macos-release-app        Stage a direct macOS .app + DMG from the Electrobun build output
  --exclude-optional-pack <name>   Exclude a manifest-classified optional capability pack during staging

Environment:
  ELIZA_DESKTOP_COMMAND_PREFIX    Prefix every spawned command, e.g. "arch -x86_64"
`);
}

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
