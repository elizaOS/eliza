import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [, , cwd, ...playwrightArgs] = process.argv;

if (!cwd || playwrightArgs.length === 0) {
  console.error(
    "Usage: node scripts/run-playwright.mjs <cwd> <playwright args...>",
  );
  process.exit(1);
}

const env = { ...process.env };
delete env.NO_COLOR;
delete env.FORCE_COLOR;
delete env.CLICOLOR_FORCE;

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

  return process.platform === "win32" ? "bun.exe" : "bun";
}

const child = spawn(
  resolveBunCommand(),
  ["x", "playwright", ...playwrightArgs],
  {
    cwd,
    env,
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
