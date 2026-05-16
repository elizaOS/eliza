import { spawn } from "node:child_process";

const host = process.env.PLAYWRIGHT_HOST || "127.0.0.1";
const port = process.env.PLAYWRIGHT_PORT || "4173";
const baseUrl = process.env.PLAYWRIGHT_BASE_URL || `http://${host}:${port}`;
const args = process.argv.slice(2);
const env = {
  ...process.env,
  VITE_PLAYWRIGHT_TEST_AUTH: "true",
  VITE_ELIZA_RENDER_TELEMETRY: "true",
  CLOUD_FRONTEND_E2E_SERVER_STARTED: "1",
};
delete env.FORCE_COLOR;
delete env.NO_COLOR;

async function waitForServer(child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(baseUrl, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
}

const server = spawn(
  "bun",
  ["--bun", "vite", "--host", host, "--port", port],
  {
    stdio: "inherit",
    env,
  },
);

try {
  await waitForServer(server);
  const result = await new Promise((resolve, reject) => {
    const child = spawn("playwright", ["test", ...args], {
      stdio: "inherit",
      env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
  process.exitCode = result;
} finally {
  stop(server);
}
