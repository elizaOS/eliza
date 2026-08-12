/**
 * Playwright web-server launcher for homepage e2e tests.
 *
 * The script syncs shared public assets before starting Vite on the homepage
 * e2e port so route and visual tests exercise the same static assets as local
 * development. The port is resolved per runner (see e2e-port.mjs) because a
 * fixed one collided between concurrent jobs on a shared self-hosted host.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHomepageE2ePort } from "./e2e-port.mjs";

const homepageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(homepageDir, "..", "..");

const syncScript = path.join(
  repoRoot,
  "packages",
  "shared",
  "scripts",
  "sync-to-public.mjs",
);
const viteScript = path.join(
  repoRoot,
  "node_modules",
  "vite",
  "bin",
  "vite.js",
);

const sync = spawnSync(process.execPath, [syncScript, "./public"], {
  cwd: homepageDir,
  env: process.env,
  stdio: "inherit",
});

if (sync.error) {
  throw sync.error;
}

if ((sync.status ?? 1) !== 0) {
  process.exit(sync.status ?? 1);
}

const vite = spawn(
  process.execPath,
  [
    viteScript,
    "--host",
    "127.0.0.1",
    "--port",
    String(resolveHomepageE2ePort()),
  ],
  {
    cwd: homepageDir,
    env: {
      ...process.env,
      VITE_ELIZACLOUD_API_URL: "https://elizacloud.ai",
      // Deterministic fake bot id so Telegram onboarding specs run in every
      // lane, including fork-safe jobs that carry no repository variables.
      // Specs stub window.Telegram.Login and intercept the network; nothing
      // real is addressed by this fixture value.
      VITE_TELEGRAM_BOT_ID: process.env.VITE_TELEGRAM_BOT_ID || "123456789",
    },
    stdio: "inherit",
  },
);

let forwardingSignal = false;

function forwardSignal(signal) {
  forwardingSignal = true;
  if (!vite.killed) {
    vite.kill(signal);
  }
}

process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

vite.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

vite.on("exit", (code, signal) => {
  if (signal && !forwardingSignal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
