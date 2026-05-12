import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort } from "../test/utils/get-free-port.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appDir, "..", "..");
const playwrightArgs = process.argv.slice(2);

function resolvePlaywrightCommand() {
  const binaryName =
    process.platform === "win32" ? "playwright.cmd" : "playwright";
  for (const candidate of [
    path.join(appDir, "node_modules", ".bin", binaryName),
    path.join(repoRoot, "node_modules", ".bin", binaryName),
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return binaryName;
}

function resolveBunCommand() {
  const bunFromEnv = process.env.BUN?.trim();
  if (bunFromEnv && fs.existsSync(bunFromEnv)) {
    return bunFromEnv;
  }

  if (
    typeof process.versions.bun === "string" &&
    typeof process.execPath === "string" &&
    process.execPath.length > 0 &&
    fs.existsSync(process.execPath)
  ) {
    return process.execPath;
  }

  const bunInstallRoot = process.env.BUN_INSTALL?.trim();
  if (bunInstallRoot) {
    const bunFromInstall = path.join(
      bunInstallRoot,
      "bin",
      process.platform === "win32" ? "bun.exe" : "bun",
    );
    if (fs.existsSync(bunFromInstall)) {
      return bunFromInstall;
    }
  }

  const homeBun = path.join(
    os.homedir(),
    ".bun",
    "bin",
    process.platform === "win32" ? "bun.exe" : "bun",
  );
  if (fs.existsSync(homeBun)) {
    return homeBun;
  }

  return process.platform === "win32" ? "bun.exe" : "bun";
}

const env = { ...process.env };
delete env.NO_COLOR;
delete env.FORCE_COLOR;
delete env.CLICOLOR_FORCE;
env.BUN = env.BUN || resolveBunCommand();

const bunBinDir = path.dirname(env.BUN);
const pathDelimiter = process.platform === "win32" ? ";" : ":";
env.PATH = env.PATH ? `${bunBinDir}${pathDelimiter}${env.PATH}` : bunBinDir;

if (
  playwrightArgs.includes("--config") &&
  playwrightArgs.some((value) =>
    value.includes("playwright.ui-smoke.config.ts"),
  )
) {
  env.ELIZA_UI_SMOKE_FORCE_STUB = env.ELIZA_UI_SMOKE_FORCE_STUB || "1";

  if (!env.ELIZA_UI_SMOKE_API_PORT) {
    const apiPort = await getFreePort();
    env.ELIZA_UI_SMOKE_API_PORT = String(apiPort);
    env.ELIZA_API_PORT = env.ELIZA_API_PORT || String(apiPort);
  }

  if (!env.ELIZA_UI_SMOKE_PORT) {
    const uiPort = await getFreePort();
    env.ELIZA_UI_SMOKE_PORT = String(uiPort);
    env.ELIZA_PORT = env.ELIZA_PORT || String(uiPort);
  }
}

const child = spawn(resolvePlaywrightCommand(), ["test", ...playwrightArgs], {
  cwd: appDir,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
