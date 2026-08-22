#!/usr/bin/env bun
/**
 * Read-only Linux development capability doctor. It verifies the repository
 * toolchain pins, native desktop libraries, media/device plumbing, SSH, and the
 * generated Electrobun artifact without reading or printing credential values.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REQUIRED_BUN = "1.3.14";
const REQUIRED_NODE = "v24.15.0";
const MIN_FREE_BYTES = 8 * 1024 ** 3;

function firstLine(value) {
  return (value ?? "").split(/\r?\n/u)[0]?.trim() ?? "";
}

function defaultRun(command, args = []) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15_000,
    env: process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function finding(id, required, ok, detail, fix) {
  return { id, required, ok, detail, ...(fix ? { fix } : {}) };
}

function commandProbe(run, id, command, args, required, fix) {
  const result = run(command, args);
  return finding(
    id,
    required,
    result.ok,
    result.ok
      ? firstLine(result.output) || `${command} available`
      : `${command} unavailable`,
    result.ok ? undefined : fix,
  );
}

function pkgConfigProbe(run, module, aptPackage, required = true) {
  const result = run("pkg-config", ["--modversion", module]);
  return finding(
    `pkg:${module}`,
    required,
    result.ok,
    result.ok
      ? `${module} ${firstLine(result.output)}`
      : `${module} not found by pkg-config`,
    result.ok ? undefined : `sudo apt install ${aptPackage}`,
  );
}

function serviceProbe(run, id, unit, user = false) {
  const result = run(
    "systemctl",
    [user ? "--user" : "", "is-active", unit].filter(Boolean),
  );
  return finding(
    id,
    false,
    result.ok && firstLine(result.output) === "active",
    result.ok ? `${unit} active` : `${unit} inactive or unavailable`,
    `systemctl ${user ? "--user " : ""}status ${unit}`,
  );
}

function listVideoDevices(readDir = readdirSync) {
  try {
    return readDir("/dev").filter((entry) => /^video\d+$/u.test(entry));
  } catch {
    return [];
  }
}

export function parseLinuxDoctorArgs(argv) {
  const parsed = { json: false, strict: false };
  for (const arg of argv) {
    if (arg === "--json") parsed.json = true;
    else if (arg === "--strict") parsed.strict = true;
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

export function collectLinuxDevReport(deps = {}) {
  const run = deps.run ?? defaultRun;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const env = deps.env ?? process.env;
  const fileExists = deps.exists ?? existsSync;
  const statfs = deps.statfs ?? statfsSync;
  const readText = deps.readText ?? ((target) => readFileSync(target, "utf8"));
  const readDir = deps.readDir ?? readdirSync;
  const findings = [];

  findings.push(
    finding(
      "platform",
      true,
      platform === "linux",
      `${platform}/${arch}`,
      "Use a Linux x64 or arm64 host",
    ),
  );
  findings.push(
    finding(
      "architecture",
      true,
      ["x64", "arm64"].includes(arch),
      arch,
      "Use a supported x64 or arm64 Linux host",
    ),
  );

  let distro = "unknown Linux distribution";
  try {
    const osRelease = readText("/etc/os-release");
    distro =
      osRelease
        .match(/^PRETTY_NAME=(?:"([^"]+)"|([^\n]+))/mu)
        ?.slice(1)
        .find(Boolean) ?? distro;
  } catch {
    // error-policy:J4 an unreadable distro marker is reported, not thrown.
  }
  findings.push(
    finding(
      "distribution",
      false,
      distro !== "unknown Linux distribution",
      distro,
    ),
  );

  const bun = run("bun", ["--version"]);
  findings.push(
    finding(
      "bun",
      true,
      bun.ok && firstLine(bun.output) === REQUIRED_BUN,
      bun.ok
        ? `Bun ${firstLine(bun.output)} (required ${REQUIRED_BUN})`
        : "Bun unavailable",
      "bash scripts/bootstrap-linux-dev.sh --skip-install",
    ),
  );
  const node = run("node", ["--version"]);
  findings.push(
    finding(
      "node",
      true,
      node.ok && firstLine(node.output) === REQUIRED_NODE,
      node.ok
        ? `Node ${firstLine(node.output)} (required ${REQUIRED_NODE})`
        : "Node unavailable",
      "bash scripts/bootstrap-linux-dev.sh --skip-install",
    ),
  );

  for (const probe of [
    ["git", "git", ["--version"], true, "sudo apt install git"],
    [
      "gh",
      "gh",
      ["--version"],
      true,
      "Install GitHub CLI: https://cli.github.com",
    ],
    [
      "compiler",
      "c++",
      ["--version"],
      true,
      "sudo apt install build-essential",
    ],
    ["cmake", "cmake", ["--version"], true, "sudo apt install cmake"],
    [
      "pkg-config",
      "pkg-config",
      ["--version"],
      true,
      "sudo apt install pkg-config",
    ],
    ["python", "python3", ["--version"], true, "sudo apt install python3"],
    ["rust", "rustc", ["--version"], true, "Install Rust: https://rustup.rs"],
    ["cargo", "cargo", ["--version"], true, "Install Rust: https://rustup.rs"],
    ["ssh-client", "ssh", ["-V"], true, "sudo apt install openssh-client"],
    ["ffmpeg", "ffmpeg", ["-version"], true, "sudo apt install ffmpeg"],
    ["xvfb", "Xvfb", ["-help"], true, "sudo apt install xvfb xauth"],
  ]) {
    findings.push(commandProbe(run, ...probe));
  }

  findings.push(pkgConfigProbe(run, "gtk+-3.0", "libgtk-3-dev"));
  findings.push(pkgConfigProbe(run, "webkit2gtk-4.1", "libwebkit2gtk-4.1-dev"));
  findings.push(pkgConfigProbe(run, "alsa", "libasound2-dev"));
  findings.push(pkgConfigProbe(run, "openssl", "libssl-dev"));
  findings.push(pkgConfigProbe(run, "libsecret-1", "libsecret-1-dev", false));
  findings.push(
    pkgConfigProbe(run, "libpipewire-0.3", "libpipewire-0.3-dev", false),
  );

  const browserCandidates = [
    ["google-chrome", ["--version"]],
    ["chromium", ["--version"]],
    ["chromium-browser", ["--version"]],
    ["firefox", ["--version"]],
  ];
  const browser = browserCandidates
    .map(([command, args]) => ({ command, result: run(command, args) }))
    .find(({ result }) => result.ok);
  findings.push(
    finding(
      "browser",
      true,
      Boolean(browser),
      browser
        ? firstLine(browser.result.output)
        : "No supported browser executable found",
      "sudo apt install firefox-esr",
    ),
  );

  const gitName = run("git", ["config", "user.name"]);
  const gitEmail = run("git", ["config", "user.email"]);
  findings.push(
    finding(
      "git-author",
      true,
      gitName.ok &&
        Boolean(firstLine(gitName.output)) &&
        gitEmail.ok &&
        Boolean(firstLine(gitEmail.output)),
      gitName.ok && gitEmail.ok
        ? `${firstLine(gitName.output)} <${firstLine(gitEmail.output)}>`
        : "Git author identity is incomplete",
      "git config --global user.name NAME && git config --global user.email EMAIL",
    ),
  );

  try {
    const disk = statfs(REPO_ROOT);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    findings.push(
      finding(
        "disk",
        true,
        freeBytes >= MIN_FREE_BYTES,
        `${(freeBytes / 1024 ** 3).toFixed(1)} GiB free (minimum 8.0 GiB for a desktop package build)`,
        "Free generated build/cache space before packaging Electrobun",
      ),
    );
  } catch {
    findings.push(
      finding("disk", true, false, "Unable to measure workspace filesystem"),
    );
  }

  findings.push(serviceProbe(run, "pipewire", "pipewire", true));
  findings.push(serviceProbe(run, "wireplumber", "wireplumber", true));
  findings.push(serviceProbe(run, "ssh-server", "ssh"));
  findings.push(serviceProbe(run, "docker", "docker"));

  findings.push(
    finding(
      "audio-device",
      false,
      fileExists("/dev/snd"),
      fileExists("/dev/snd") ? "/dev/snd present" : "No ALSA device directory",
      "Check audio permissions and PipeWire/ALSA device exposure",
    ),
  );
  const videoDevices = listVideoDevices(readDir);
  findings.push(
    finding(
      "camera-device",
      false,
      videoDevices.length > 0,
      videoDevices.length > 0
        ? videoDevices.map((name) => `/dev/${name}`).join(", ")
        : "No V4L2 video devices",
      "Check camera privacy controls and V4L2 device exposure",
    ),
  );
  findings.push(
    finding(
      "display-session",
      false,
      Boolean(env.WAYLAND_DISPLAY || env.DISPLAY),
      env.WAYLAND_DISPLAY
        ? `Wayland ${env.WAYLAND_DISPLAY}`
        : env.DISPLAY
          ? `X11 ${env.DISPLAY}`
          : "No interactive display; packaged tests can use Xvfb",
    ),
  );

  const launcher = path.join(
    REPO_ROOT,
    "packages/app-core/platforms/electrobun/build",
    `dev-linux-${arch}`,
    "Eliza-dev/bin/launcher",
  );
  findings.push(
    finding(
      "electrobun-artifact",
      false,
      fileExists(launcher),
      fileExists(launcher)
        ? launcher
        : "Linux desktop artifact has not been built",
      "bun run --cwd packages/app-core/platforms/electrobun build",
    ),
  );

  return {
    generatedAt: new Date().toISOString(),
    repository: REPO_ROOT,
    host: os.hostname(),
    findings,
    summary: {
      passed: findings.filter((item) => item.ok).length,
      warnings: findings.filter((item) => !item.ok && !item.required).length,
      failed: findings.filter((item) => !item.ok && item.required).length,
    },
  };
}

export function renderLinuxDevReport(report) {
  const lines = [
    "Linux development doctor",
    `Repository: ${report.repository}`,
    "",
  ];
  for (const item of report.findings) {
    const state = item.ok ? "PASS" : item.required ? "FAIL" : "WARN";
    lines.push(`[${state}] ${item.id}: ${item.detail}`);
    if (!item.ok && item.fix) lines.push(`       Fix: ${item.fix}`);
  }
  lines.push(
    "",
    `Summary: ${report.summary.passed} pass, ${report.summary.warnings} warn, ${report.summary.failed} fail`,
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  let args;
  try {
    args = parseLinuxDoctorArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `linux-dev-doctor: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log("Usage: bun scripts/linux-dev-doctor.mjs [--json] [--strict]");
    return;
  }
  const report = collectLinuxDevReport();
  console.log(
    args.json
      ? JSON.stringify(report, null, 2)
      : renderLinuxDevReport(report).trimEnd(),
  );
  if (args.strict && report.summary.failed > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
