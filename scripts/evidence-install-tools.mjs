#!/usr/bin/env node
/**
 * Installs the baseline evidence toolchain on macOS, Linux, and Windows.
 * The exported requirement catalog also drives the doctor, while direct
 * argument-vector execution and process-local PATH refresh keep reruns
 * deterministic without editing shell profiles or persisting credentials.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveFfmpegBinary,
  resolveFfprobeBinary,
} from "../packages/evidence/src/ffmpeg-binaries.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);

export const EVIDENCE_REQUIREMENTS = Object.freeze({
  ocr: Object.freeze({
    id: "ocr",
    requiredByDefault: true,
    packageName: "tesseract.js",
  }),
  ffmpeg: Object.freeze({
    id: "ffmpeg",
    requiredByDefault: true,
    packageName: "ffmpeg-static",
    systemCommand: "ffmpeg",
    versionArgs: Object.freeze(["-version"]),
  }),
  ffprobe: Object.freeze({
    id: "ffprobe",
    requiredByDefault: true,
    packageName: "ffprobe-static",
    systemCommand: "ffprobe",
    versionArgs: Object.freeze(["-version"]),
  }),
  playwright: Object.freeze({
    id: "playwright-browsers",
    requiredByDefault: true,
    packageName: "playwright",
    browserName: "chromium",
  }),
  githubCli: Object.freeze({
    id: "github-cli",
    requiredByDefault: false,
    systemCommand: "gh",
  }),
});

const LINUX_PACKAGE_MANAGERS = Object.freeze([
  Object.freeze({
    name: "apt-get",
    updateArgs: Object.freeze(["update"]),
    mediaArgs: Object.freeze(["install", "-y", "ffmpeg"]),
    githubArgs: Object.freeze(["install", "-y", "gh"]),
  }),
  Object.freeze({
    name: "dnf",
    mediaArgs: Object.freeze(["install", "-y", "ffmpeg"]),
    githubArgs: Object.freeze(["install", "-y", "gh"]),
  }),
  Object.freeze({
    name: "yum",
    mediaArgs: Object.freeze(["install", "-y", "ffmpeg"]),
    githubArgs: Object.freeze(["install", "-y", "gh"]),
  }),
  Object.freeze({
    name: "apk",
    mediaArgs: Object.freeze(["add", "--no-cache", "ffmpeg"]),
    githubArgs: Object.freeze(["add", "--no-cache", "github-cli"]),
  }),
  Object.freeze({
    name: "pacman",
    mediaArgs: Object.freeze(["-S", "--noconfirm", "ffmpeg"]),
    githubArgs: Object.freeze(["-S", "--noconfirm", "github-cli"]),
  }),
  Object.freeze({
    name: "zypper",
    mediaArgs: Object.freeze(["install", "-y", "ffmpeg"]),
    githubArgs: Object.freeze(["install", "-y", "gh"]),
  }),
]);

export function assertSupportedPlatform(platform) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(
      `unsupported operating system: ${platform}; supported platforms are macOS, Linux, and Windows`,
    );
  }
}

function pathKeyFor(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function mergeWindowsPath(env, additionalPaths) {
  const pathKey = pathKeyFor(env);
  const current = env[pathKey] ?? "";
  const entries = [...additionalPaths, ...current.split(";")]
    .map((entry) => entry.trim())
    .filter(Boolean);
  const seen = new Set();
  const unique = entries.filter((entry) => {
    const normalized = entry.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  return { ...env, [pathKey]: unique.join(";") };
}

/**
 * WinGet exposes portable package shims from this per-user directory. Adding
 * it only to child-process state makes new shims visible without modifying a
 * user's persistent PATH.
 */
export function withWindowsWingetLinksPath(env) {
  if (!env.LOCALAPPDATA) {
    throw new Error(
      "LOCALAPPDATA is unavailable; cannot resolve WinGet's tool links directory.",
    );
  }
  const links = path.win32.join(
    env.LOCALAPPDATA,
    "Microsoft",
    "WinGet",
    "Links",
  );
  return mergeWindowsPath(env, [links]);
}

/**
 * MSI-backed WinGet packages update registry PATH values, which a running
 * Node process does not inherit. Reading and merging those values after each
 * WinGet mutation makes verification in the same installer process reliable.
 */
export function refreshWindowsPath(env, { run = spawnSync } = {}) {
  const seeded = withWindowsWingetLinksPath(env);
  const script =
    "[Console]::Out.Write((@([Environment]::GetEnvironmentVariable('Path','Machine'),[Environment]::GetEnvironmentVariable('Path','User')) -join [Environment]::NewLine))";
  const result = run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: seeded,
      windowsHide: true,
    },
  );
  if (result.error) {
    throw new Error(`could not refresh Windows PATH: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      `could not refresh Windows PATH (PowerShell exited ${result.status ?? "without a status"})`,
    );
  }
  const [machinePath = "", userPath = ""] = String(result.stdout ?? "").split(
    /\r?\n/u,
    2,
  );
  return mergeWindowsPath(seeded, [userPath, machinePath]);
}

function commandExists(
  command,
  { platform = process.platform, run = spawnSync, env = process.env } = {},
) {
  const probe =
    platform === "win32"
      ? run("where", [command], { stdio: "ignore", env })
      : run("which", [command], { stdio: "ignore", env });
  return probe.status === 0;
}

function nonInteractiveSudoSteps(isRoot) {
  return isRoot
    ? []
    : [
        {
          label: "passwordless sudo preflight",
          bin: "sudo",
          args: ["-n", "true"],
          failureMessage:
            "Evidence tool installation requires passwordless sudo on this unattended runner. Install the tools manually or grant this runner noninteractive sudo, then rerun.",
        },
      ];
}

function linuxManager(has) {
  return LINUX_PACKAGE_MANAGERS.find(({ name }) => has(name));
}

function linuxInstallSteps(manager, args, isRoot, label) {
  const command = isRoot ? manager.name : "sudo";
  const prefix = isRoot ? [] : ["-n", manager.name];
  return [
    ...nonInteractiveSudoSteps(isRoot),
    ...(manager.updateArgs
      ? [
          {
            label: `${label} package index`,
            bin: command,
            args: [...prefix, ...manager.updateArgs],
          },
        ]
      : []),
    {
      label,
      bin: command,
      args: [...prefix, ...args],
    },
  ];
}

function mediaVerificationSteps(resolutions) {
  const ffmpeg = EVIDENCE_REQUIREMENTS.ffmpeg;
  const ffprobe = EVIDENCE_REQUIREMENTS.ffprobe;
  return [
    {
      label: "ffmpeg verification",
      bin: resolutions?.ffmpeg?.available
        ? resolutions.ffmpeg.bin
        : ffmpeg.systemCommand,
      args: [...ffmpeg.versionArgs],
    },
    {
      label: "ffprobe verification",
      bin: resolutions?.ffprobe?.available
        ? resolutions.ffprobe.bin
        : ffprobe.systemCommand,
      args: [...ffprobe.versionArgs],
    },
  ];
}

export function mediaInstallSteps(
  platform,
  {
    has = (command) => commandExists(command, { platform }),
    isRoot = typeof process.getuid === "function"
      ? process.getuid() === 0
      : false,
    resolutions,
  } = {},
) {
  assertSupportedPlatform(platform);
  const healthy =
    resolutions?.ffmpeg?.available && resolutions?.ffprobe?.available;
  if (healthy) return mediaVerificationSteps(resolutions);
  if (
    resolutions === undefined &&
    has(EVIDENCE_REQUIREMENTS.ffmpeg.systemCommand) &&
    has(EVIDENCE_REQUIREMENTS.ffprobe.systemCommand)
  ) {
    return mediaVerificationSteps();
  }

  if (platform === "darwin") {
    if (!has("brew")) {
      throw new Error(
        "ffmpeg/ffprobe are unavailable and Homebrew is missing. Install Homebrew from https://brew.sh, then rerun.",
      );
    }
    return [
      { label: "ffmpeg and ffprobe", bin: "brew", args: ["install", "ffmpeg"] },
      ...mediaVerificationSteps(),
    ];
  }
  if (platform === "win32") {
    if (!has("winget")) {
      throw new Error(
        "ffmpeg/ffprobe are unavailable and WinGet is missing. Install App Installer, then rerun.",
      );
    }
    return [
      {
        label: "ffmpeg and ffprobe",
        bin: "winget",
        args: [
          "install",
          "--id",
          "Gyan.FFmpeg",
          "--exact",
          "--accept-package-agreements",
          "--accept-source-agreements",
          "--silent",
          "--disable-interactivity",
        ],
        refreshWindowsPath: true,
      },
      ...mediaVerificationSteps(),
    ];
  }

  const manager = linuxManager(has);
  if (!manager) {
    throw new Error(
      "ffmpeg/ffprobe are unavailable and no supported Linux package manager was found (apt, dnf, yum, apk, pacman, zypper). Install ffmpeg, then rerun.",
    );
  }
  return [
    ...linuxInstallSteps(
      manager,
      manager.mediaArgs,
      isRoot,
      "ffmpeg and ffprobe",
    ),
    ...mediaVerificationSteps(),
  ];
}

export function githubInstallSteps(
  platform,
  {
    has = (command) => commandExists(command, { platform }),
    isRoot = typeof process.getuid === "function"
      ? process.getuid() === 0
      : false,
  } = {},
) {
  assertSupportedPlatform(platform);
  const verification = {
    label: "GitHub CLI verification",
    bin: EVIDENCE_REQUIREMENTS.githubCli.systemCommand,
    args: ["--version"],
  };
  if (has(EVIDENCE_REQUIREMENTS.githubCli.systemCommand)) {
    return [verification];
  }
  if (platform === "darwin") {
    if (!has("brew")) {
      throw new Error(
        "GitHub CLI is missing and Homebrew is unavailable. Install Homebrew from https://brew.sh, then rerun with --github.",
      );
    }
    return [
      { label: "GitHub CLI", bin: "brew", args: ["install", "gh"] },
      verification,
    ];
  }
  if (platform === "win32") {
    if (!has("winget")) {
      throw new Error(
        "GitHub CLI is missing and WinGet is unavailable. Install App Installer, then rerun with --github.",
      );
    }
    return [
      {
        label: "GitHub CLI",
        bin: "winget",
        args: [
          "install",
          "--id",
          "GitHub.cli",
          "--exact",
          "--accept-package-agreements",
          "--accept-source-agreements",
          "--silent",
          "--disable-interactivity",
        ],
        refreshWindowsPath: true,
      },
      verification,
    ];
  }

  const manager = linuxManager(has);
  if (!manager) {
    throw new Error(
      "GitHub CLI is missing and no supported Linux package manager was found (apt, dnf, yum, apk, pacman, zypper). Install `gh`, then rerun the doctor.",
    );
  }
  return [
    ...linuxInstallSteps(manager, manager.githubArgs, isRoot, "GitHub CLI"),
    verification,
  ];
}

export async function resolveMediaRequirements({
  resolveFfmpeg = resolveFfmpegBinary,
  resolveFfprobe = resolveFfprobeBinary,
} = {}) {
  const [ffmpeg, ffprobe] = await Promise.all([
    resolveFfmpeg(),
    resolveFfprobe(),
  ]);
  return { ffmpeg, ffprobe };
}

function workspaceDependencyStep() {
  return {
    label: "workspace evidence dependencies",
    bin: "bun",
    args: ["install", "--frozen-lockfile", "--ignore-scripts"],
  };
}

export function buildInstallPlan({
  platform = process.platform,
  includeGithub = false,
  skipDependencies = false,
  githubOptions,
  mediaOptions,
} = {}) {
  assertSupportedPlatform(platform);
  const steps = [];
  if (!skipDependencies) {
    steps.push(workspaceDependencyStep());
  }
  steps.push(...mediaInstallSteps(platform, mediaOptions));
  steps.push(
    platform === "linux"
      ? {
          label: "Playwright Chromium and available Linux OS dependencies",
          bin: "bash",
          args: [
            path.join(
              REPO_ROOT,
              ".github",
              "scripts",
              "install-playwright-browsers.sh",
            ),
            EVIDENCE_REQUIREMENTS.playwright.browserName,
          ],
        }
      : {
          label: "Playwright Chromium",
          bin: "bunx",
          args: [
            "playwright",
            "install",
            EVIDENCE_REQUIREMENTS.playwright.browserName,
          ],
        },
  );
  if (includeGithub) {
    steps.push(...githubInstallSteps(platform, githubOptions));
  }
  return steps;
}

export function formatCommand(step, platform = process.platform) {
  const safeToken = /^[A-Za-z0-9_./:@%+=,-]+$/u;
  const quote = (part) => {
    if (safeToken.test(part)) return part;
    return platform === "win32"
      ? `'${part.replaceAll("'", "''")}'`
      : `'${part.replaceAll("'", `'"'"'`)}'`;
  };
  return [step.bin, ...step.args].map(quote).join(" ");
}

function runStep(step, { run, env, platform }) {
  console.log(`\n[install] ${step.label}\n  ${formatCommand(step, platform)}`);
  const result = run(step.bin, step.args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env,
  });
  if (result.error) {
    throw new Error(`${step.label} could not start: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(
      step.failureMessage ??
        `${step.label} failed with exit code ${result.status ?? "unknown"}`,
    );
  }
}

export function executeInstallPlan(
  steps,
  {
    platform = process.platform,
    env = process.env,
    run = spawnSync,
    refreshPath = refreshWindowsPath,
  } = {},
) {
  assertSupportedPlatform(platform);
  let executionEnv =
    platform === "win32" ? withWindowsWingetLinksPath(env) : { ...env };
  for (const step of steps) {
    runStep(step, { run, env: executionEnv, platform });
    if (platform === "win32" && step.refreshWindowsPath) {
      executionEnv = refreshPath(executionEnv, { run });
    }
  }
  return executionEnv;
}

function usage() {
  console.log(`Usage: bun run evidence:install-tools -- [options]

Options:
  --github       Also install and verify GitHub CLI. Authentication and
                 repository permissions are not changed or inferred.
  --skip-deps    Do not run bun install; useful when dependencies are current.
  --dry-run      Print argument-safe platform commands without running them.
  --help, -h     Show this help.`);
}

export function parseInstallerArgs(argv) {
  const known = new Set([
    "--github",
    "--skip-deps",
    "--dry-run",
    "--help",
    "-h",
  ]);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  }
  return {
    includeGithub: argv.includes("--github"),
    skipDependencies: argv.includes("--skip-deps"),
    dryRun: argv.includes("--dry-run"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

async function main() {
  const options = parseInstallerArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!fs.existsSync(path.join(REPO_ROOT, "package.json"))) {
    throw new Error(`repository root not found at ${REPO_ROOT}`);
  }
  assertSupportedPlatform(process.platform);

  if (options.dryRun) {
    const plan = buildInstallPlan(options);
    console.log(
      plan.map((step) => formatCommand(step, process.platform)).join("\n"),
    );
    return;
  }

  let executionEnv =
    process.platform === "win32"
      ? withWindowsWingetLinksPath(process.env)
      : { ...process.env };
  Object.assign(process.env, executionEnv);
  if (!options.skipDependencies) {
    executionEnv = executeInstallPlan([workspaceDependencyStep()], {
      platform: process.platform,
      env: executionEnv,
    });
    Object.assign(process.env, executionEnv);
  }

  const resolutions = await resolveMediaRequirements();
  const plan = buildInstallPlan({
    ...options,
    skipDependencies: true,
    mediaOptions: { resolutions },
  });
  executionEnv = executeInstallPlan(plan, {
    platform: process.platform,
    env: executionEnv,
  });

  const doctorArgs = [
    path.join(REPO_ROOT, "scripts", "evidence-doctor.mjs"),
    "--strict",
  ];
  executeInstallPlan(
    [
      {
        label: "evidence toolchain verification",
        bin: process.execPath,
        args: doctorArgs,
      },
    ],
    { platform: process.platform, env: executionEnv },
  );
  if (options.includeGithub) {
    console.log(
      "\nGitHub CLI installation verified; authentication and repository permissions were left unchanged.",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    // error-policy:J1 CLI failures are translated once into a non-zero exit.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`evidence-install-tools: ${message}`);
    process.exitCode = 1;
  });
}
