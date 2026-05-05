import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SYSTEM_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export type LiveBrowserExecutable = {
  executablePath: string | null;
  source: string;
};

function parseBrowserBuild(name: string, prefix: string): number {
  const suffix = name.slice(prefix.length);
  const build = Number.parseInt(suffix, 10);
  return Number.isFinite(build) ? build : -1;
}

function getBundledBrowserCandidates(): string[] {
  const playwrightCacheRoot = path.join(
    os.homedir(),
    "Library",
    "Caches",
    "ms-playwright",
  );
  if (!existsSync(playwrightCacheRoot)) {
    return [];
  }

  const chromiumDirs = readdirSync(playwrightCacheRoot, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const candidates: string[] = [];

  const chromiumBuilds = chromiumDirs
    .filter((name) => name.startsWith("chromium-"))
    .sort(
      (left, right) =>
        parseBrowserBuild(right, "chromium-") -
        parseBrowserBuild(left, "chromium-"),
    );
  for (const buildDir of chromiumBuilds) {
    for (const platformDir of ["chrome-mac-arm64", "chrome-mac"]) {
      candidates.push(
        path.join(
          playwrightCacheRoot,
          buildDir,
          platformDir,
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ),
      );
    }
  }

  const headlessShellBuilds = chromiumDirs
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort(
      (left, right) =>
        parseBrowserBuild(right, "chromium_headless_shell-") -
        parseBrowserBuild(left, "chromium_headless_shell-"),
    );
  for (const buildDir of headlessShellBuilds) {
    for (const platformDir of [
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell-mac",
    ]) {
      candidates.push(
        path.join(
          playwrightCacheRoot,
          buildDir,
          platformDir,
          "chrome-headless-shell",
        ),
      );
    }
  }

  return candidates;
}

export function resolveLiveBrowserExecutable(): LiveBrowserExecutable {
  const envPath = process.env.ELIZA_CHROME_PATH?.trim() ?? "";
  if (envPath) {
    return {
      executablePath: existsSync(envPath) ? envPath : null,
      source: "ELIZA_CHROME_PATH",
    };
  }

  for (const candidatePath of getBundledBrowserCandidates()) {
    if (existsSync(candidatePath)) {
      return {
        executablePath: candidatePath,
        source: "ms-playwright",
      };
    }
  }

  return {
    executablePath: existsSync(SYSTEM_CHROME_PATH) ? SYSTEM_CHROME_PATH : null,
    source: "system Google Chrome",
  };
}
