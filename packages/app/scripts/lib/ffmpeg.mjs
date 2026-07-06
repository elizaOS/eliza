#!/usr/bin/env node
// Required ffmpeg resolution for evidence capture scripts. Capture lanes must
// not go green without video simply because the host lacks ffmpeg, so this
// helper resolves an explicit binary, a PATH binary, an installed static npm
// binary, or installs the platform package before failing loudly.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const defaultRequire = createRequire(import.meta.url);

export function createFfmpegResolver({
  env = process.env,
  execFileSync: execFileSyncDep = execFileSync,
  existsSync: existsSyncDep = existsSync,
  getuid = process.getuid?.bind(process),
  platform = process.platform,
  require: requireDep = defaultRequire,
  spawnSync: spawnSyncDep = spawnSync,
} = {}) {
  function commandWorks(bin) {
    return spawnSyncDep(bin, ["-version"], { stdio: "ignore" }).status === 0;
  }

  function bundledFfmpeg() {
    try {
      const mod = requireDep("ffmpeg-static");
      return typeof mod === "string" && mod.length > 0 && existsSyncDep(mod)
        ? mod
        : null;
    } catch {
      // error-policy:J3 optional static package fallback; caller installs/fails.
      return null;
    }
  }

  function sudoPrefix() {
    if (typeof getuid === "function" && getuid() === 0) return [];
    const sudo = spawnSyncDep("sudo", ["-n", "true"], { stdio: "ignore" });
    return sudo.status === 0 ? ["sudo"] : null;
  }

  function installLinux(log) {
    if (
      spawnSyncDep("apt-get", ["--version"], { stdio: "ignore" }).status !== 0
    ) {
      throw new Error(
        "ffmpeg is required for evidence capture, apt-get is unavailable, and no bundled ffmpeg-static binary was found.",
      );
    }
    const sudo = sudoPrefix();
    if (sudo === null) {
      throw new Error(
        "ffmpeg is required for evidence capture, but apt-get needs sudo privileges. Install ffmpeg or rerun where sudo -n apt-get is allowed.",
      );
    }
    log("ffmpeg missing; installing via apt-get.");
    const command = sudo.length > 0 ? sudo[0] : "apt-get";
    const prefix = sudo.length > 0 ? ["apt-get"] : [];
    execFileSyncDep(command, [...prefix, "update"], { stdio: "inherit" });
    execFileSyncDep(command, [...prefix, "install", "-y", "ffmpeg"], {
      stdio: "inherit",
    });
  }

  function installDarwin(log) {
    if (spawnSyncDep("brew", ["--version"], { stdio: "ignore" }).status !== 0) {
      throw new Error(
        "ffmpeg is required for evidence capture, Homebrew is unavailable, and no bundled ffmpeg-static binary was found.",
      );
    }
    log("ffmpeg missing; installing via Homebrew.");
    execFileSyncDep("brew", ["install", "ffmpeg"], { stdio: "inherit" });
  }

  function installWindows(log) {
    if (
      spawnSyncDep("winget", ["--version"], { stdio: "ignore" }).status !== 0
    ) {
      throw new Error(
        "ffmpeg is required for evidence capture, winget is unavailable, and no bundled ffmpeg-static binary was found.",
      );
    }
    log("ffmpeg missing; installing via winget.");
    execFileSyncDep(
      "winget",
      [
        "install",
        "-e",
        "--id",
        "Gyan.FFmpeg",
        "--accept-source-agreements",
        "--accept-package-agreements",
      ],
      { stdio: "inherit" },
    );
  }

  function installForPlatform(log) {
    if (platform === "linux") return installLinux(log);
    if (platform === "darwin") return installDarwin(log);
    if (platform === "win32") return installWindows(log);
    throw new Error(
      `ffmpeg is required for evidence capture, but automatic installation is unsupported on ${platform}.`,
    );
  }

  return {
    resolveRequiredFfmpeg({ log = () => {} } = {}) {
      const explicit =
        env.ELIZA_FFMPEG_BIN?.trim() ||
        env.ELIZA_FFMPEG_PATH?.trim() ||
        env.FFMPEG_PATH?.trim();
      if (explicit) {
        if (commandWorks(explicit)) return explicit;
        throw new Error(`Configured ffmpeg is not invocable: ${explicit}`);
      }

      if (commandWorks("ffmpeg")) return "ffmpeg";

      const bundled = bundledFfmpeg();
      if (bundled && commandWorks(bundled)) return bundled;

      installForPlatform(log);
      if (commandWorks("ffmpeg")) return "ffmpeg";

      const installedBundled = bundledFfmpeg();
      if (installedBundled && commandWorks(installedBundled)) {
        return installedBundled;
      }

      throw new Error(
        "ffmpeg installation completed but ffmpeg is still not invocable.",
      );
    },
  };
}

const defaultResolver = createFfmpegResolver();

export function resolveRequiredFfmpeg(options) {
  return defaultResolver.resolveRequiredFfmpeg(options);
}
