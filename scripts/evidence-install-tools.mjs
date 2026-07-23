#!/usr/bin/env node
/**
 * Installs the baseline evidence toolchain on macOS, Linux, and Windows.
 * One side-effect-free planner (`resolveInstallPlan`) produces the step list
 * that both `--dry-run` display and real execution consume, so the printed
 * plan is the executed plan; when packaged media binaries can only resolve
 * after the workspace dependency step, the plan says so explicitly and
 * execution re-resolves through the same planner. Every step carries a
 * deadline so no package manager, download, or probe can block forever. The
 * exported requirement catalog also drives the doctor, while direct
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

const MINUTE_MS = 60_000;

/**
 * Default per-step deadlines. Package-manager operations download and unpack;
 * probes answer `--version`-style checks; the trailing strict doctor launches
 * Chromium and runs OCR. Scale all of them with `--timeout-scale=<factor>` or
 * ELIZA_EVIDENCE_INSTALL_TIMEOUT_SCALE on slow hosts.
 */
export const STEP_TIMEOUT_DEFAULTS_MS = Object.freeze({
  packageManager: 15 * MINUTE_MS,
  probe: 2 * MINUTE_MS,
  verification: 10 * MINUTE_MS,
});

/** Typed step failure so callers can distinguish timeout, start, and exit. */
export class InstallStepError extends Error {
  constructor(message, { step, code, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "InstallStepError";
    this.step = step?.label;
    this.code = code;
  }
}

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

/**
 * The deadline scale multiplies every per-step deadline; a factor is easier
 * to reason about on a slow host than editing absolute values per step.
 */
export function resolveStepTimeoutScale(env = process.env, flagValue) {
  const raw = flagValue ?? env.ELIZA_EVIDENCE_INSTALL_TIMEOUT_SCALE;
  if (raw === undefined || raw === "") return 1;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(
      `invalid step timeout scale ${JSON.stringify(raw)}; expected a positive number (via --timeout-scale=<factor> or ELIZA_EVIDENCE_INSTALL_TIMEOUT_SCALE)`,
    );
  }
  return scale;
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
 * Registry entries merge Machine before User, matching how Windows composes
 * the effective PATH for a new process.
 */
export function refreshWindowsPath(
  env,
  { run = spawnSync, timeoutMs = STEP_TIMEOUT_DEFAULTS_MS.probe } = {},
) {
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
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    },
  );
  if (result.error?.code === "ETIMEDOUT") {
    throw new InstallStepError(
      `Windows PATH refresh timed out after ${formatDeadline(timeoutMs)}`,
      { step: { label: "Windows PATH refresh" }, code: "step-timeout" },
    );
  }
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
  return mergeWindowsPath(seeded, [machinePath, userPath]);
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
          timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
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
            timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
          },
        ]
      : []),
    {
      label,
      bin: command,
      args: [...prefix, ...args],
      timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
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
      timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
    },
    {
      label: "ffprobe verification",
      bin: resolutions?.ffprobe?.available
        ? resolutions.ffprobe.bin
        : ffprobe.systemCommand,
      args: [...ffprobe.versionArgs],
      timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
    },
  ];
}

/**
 * Media steps always plan from an explicit `resolveMediaRequirements` result;
 * there is deliberately no system-presence shortcut here, so every caller
 * (dry-run and execution alike) plans from the same resolution machinery.
 */
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
  if (!resolutions?.ffmpeg || !resolutions?.ffprobe) {
    throw new Error(
      "mediaInstallSteps requires ffmpeg/ffprobe resolutions from resolveMediaRequirements",
    );
  }
  const healthy = resolutions.ffmpeg.available && resolutions.ffprobe.available;
  if (healthy) return mediaVerificationSteps(resolutions);

  if (platform === "darwin") {
    if (!has("brew")) {
      throw new Error(
        "ffmpeg/ffprobe are unavailable and Homebrew is missing. Install Homebrew from https://brew.sh, then rerun.",
      );
    }
    return [
      {
        label: "ffmpeg and ffprobe",
        bin: "brew",
        args: ["install", "ffmpeg"],
        timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
      },
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
        timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
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
    timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.probe,
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
      {
        label: "GitHub CLI",
        bin: "brew",
        args: ["install", "gh"],
        timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
      },
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
        timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
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
    timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
  };
}

function playwrightInstallStep(platform) {
  return platform === "linux"
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
        timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
      }
    : {
        label: "Playwright Chromium",
        bin: "bunx",
        args: [
          "playwright",
          "install",
          EVIDENCE_REQUIREMENTS.playwright.browserName,
        ],
        timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.packageManager,
      };
}

function doctorVerificationStep() {
  return {
    label: "evidence toolchain verification",
    bin: process.execPath,
    args: [path.join(REPO_ROOT, "scripts", "evidence-doctor.mjs"), "--strict"],
    timeoutMs: STEP_TIMEOUT_DEFAULTS_MS.verification,
  };
}

/**
 * The single planner both dry-run display and real execution consume. It is
 * side-effect-free: it resolves media through `resolveMediaRequirements` and
 * read-only command probes, and never runs an install step. When packaged
 * ffmpeg-static/ffprobe-static binaries cannot resolve before the workspace
 * dependency step has run, the plan records that assumption instead of
 * planning a premature system install; execution then re-resolves through
 * this same planner after the dependency step.
 */
export async function resolveInstallPlan(
  {
    platform = process.platform,
    includeGithub = false,
    skipDependencies = false,
    githubOptions,
    mediaOptions,
  } = {},
  { resolveMedia = resolveMediaRequirements } = {},
) {
  assertSupportedPlatform(platform);
  const resolutions = mediaOptions?.resolutions ?? (await resolveMedia());
  const mediaResolved = Boolean(
    resolutions.ffmpeg?.available && resolutions.ffprobe?.available,
  );
  const deferredMedia = !mediaResolved && !skipDependencies;
  const steps = [];
  const assumptions = [];
  if (!skipDependencies) {
    steps.push(workspaceDependencyStep());
  }
  if (deferredMedia) {
    assumptions.push(
      "ffmpeg/ffprobe did not resolve from the current host state; the packaged ffmpeg-static and ffprobe-static binaries can only resolve after the workspace dependency step, so execution re-resolves this plan after that step and falls back to the system package manager only if they still cannot run",
    );
  } else {
    steps.push(
      ...mediaInstallSteps(platform, { ...mediaOptions, resolutions }),
    );
  }
  steps.push(playwrightInstallStep(platform));
  if (includeGithub) {
    steps.push(...githubInstallSteps(platform, githubOptions));
  }
  steps.push(doctorVerificationStep());
  return { steps, assumptions, resolutions, deferredMedia };
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

function formatDeadline(timeoutMs) {
  return timeoutMs % MINUTE_MS === 0
    ? `${timeoutMs / MINUTE_MS}m`
    : `${Math.round(timeoutMs / 1000)}s`;
}

function runStep(step, { run, env, platform, timeoutScale }) {
  if (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0) {
    throw new InstallStepError(
      `${step.label} has no per-step deadline; every planned step must carry a positive timeoutMs`,
      { step, code: "step-plan" },
    );
  }
  const timeoutMs = Math.round(step.timeoutMs * timeoutScale);
  console.log(
    `\n[install] ${step.label} (deadline ${formatDeadline(timeoutMs)})\n  ${formatCommand(step, platform)}`,
  );
  const result = run(step.bin, step.args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new InstallStepError(
      `${step.label} timed out after ${formatDeadline(timeoutMs)}; rerun with --timeout-scale=<factor> or ELIZA_EVIDENCE_INSTALL_TIMEOUT_SCALE to extend deadlines on slow hosts`,
      { step, code: "step-timeout", cause: result.error },
    );
  }
  if (result.error) {
    throw new InstallStepError(
      `${step.label} could not start: ${result.error.message}`,
      { step, code: "step-start", cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new InstallStepError(
      step.failureMessage ??
        `${step.label} failed with exit code ${result.status ?? "unknown"}`,
      { step, code: "step-exit" },
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
    timeoutScale = 1,
  } = {},
) {
  assertSupportedPlatform(platform);
  let executionEnv =
    platform === "win32" ? withWindowsWingetLinksPath(env) : { ...env };
  for (const step of steps) {
    runStep(step, { run, env: executionEnv, platform, timeoutScale });
    if (platform === "win32" && step.refreshWindowsPath) {
      executionEnv = refreshPath(executionEnv, {
        run,
        timeoutMs: Math.round(STEP_TIMEOUT_DEFAULTS_MS.probe * timeoutScale),
      });
    }
  }
  return executionEnv;
}

function usage() {
  console.log(`Usage: bun run evidence:install-tools -- [options]

Options:
  --github              Also install and verify GitHub CLI. Authentication and
                        repository permissions are not changed or inferred.
  --skip-deps           Do not run bun install; useful when dependencies are
                        current.
  --dry-run             Print the resolved platform plan without running it.
                        Lines starting with "# assumes:" note where resolution
                        depends on the dependency step having run.
  --strict              With --dry-run: fail when the plan carries unresolved
                        pre-dependency assumptions.
  --timeout-scale=<n>   Multiply every per-step deadline by <n> (also
                        ELIZA_EVIDENCE_INSTALL_TIMEOUT_SCALE) for slow hosts.
  --help, -h            Show this help.`);
}

export function parseInstallerArgs(argv) {
  const flags = new Set([
    "--github",
    "--skip-deps",
    "--dry-run",
    "--strict",
    "--help",
    "-h",
  ]);
  let timeoutScale;
  const unknown = [];
  for (const arg of argv) {
    if (arg.startsWith("--timeout-scale=")) {
      timeoutScale = arg.slice("--timeout-scale=".length);
      continue;
    }
    if (!flags.has(arg)) unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  }
  const options = {
    includeGithub: argv.includes("--github"),
    skipDependencies: argv.includes("--skip-deps"),
    dryRun: argv.includes("--dry-run"),
    strict: argv.includes("--strict"),
    timeoutScale,
    help: argv.includes("--help") || argv.includes("-h"),
  };
  if (options.strict && !options.dryRun) {
    throw new Error(
      "--strict requires --dry-run; it asserts the displayed plan is fully resolved",
    );
  }
  return options;
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
  const timeoutScale = resolveStepTimeoutScale(
    process.env,
    options.timeoutScale,
  );

  // Seed the WinGet links path before planning so resolution probes and every
  // child process observe the same PATH the executed plan will use.
  let executionEnv =
    process.platform === "win32"
      ? withWindowsWingetLinksPath(process.env)
      : { ...process.env };
  Object.assign(process.env, executionEnv);

  let plan = await resolveInstallPlan(options);

  if (options.dryRun) {
    console.log(
      plan.steps
        .map((step) => formatCommand(step, process.platform))
        .join("\n"),
    );
    for (const assumption of plan.assumptions) {
      console.log(`# assumes: ${assumption}`);
    }
    if (options.strict && plan.assumptions.length > 0) {
      throw new Error(
        `--strict dry run: the plan could not be fully resolved from the current host state:\n${plan.assumptions
          .map((assumption) => `  - ${assumption}`)
          .join("\n")}`,
      );
    }
    return;
  }

  if (plan.deferredMedia) {
    // The plan's recorded assumption: packaged media binaries resolve only
    // after the dependency step. Run that step, then re-resolve the remainder
    // through the same planner so execution stays on the displayed contract.
    const [dependencyStep] = plan.steps;
    executionEnv = executeInstallPlan([dependencyStep], {
      platform: process.platform,
      env: executionEnv,
      timeoutScale,
    });
    Object.assign(process.env, executionEnv);
    plan = await resolveInstallPlan({ ...options, skipDependencies: true });
  }

  executeInstallPlan(plan.steps, {
    platform: process.platform,
    env: executionEnv,
    timeoutScale,
  });

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
