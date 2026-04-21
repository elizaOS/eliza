import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free port."));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

const env = { ...process.env };
delete env.NO_COLOR;
delete env.FORCE_COLOR;
delete env.CLICOLOR_FORCE;

if (
  playwrightArgs.includes("--config") &&
  playwrightArgs.some((value) =>
    value.includes("playwright.ui-smoke.config.ts"),
  )
) {
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
