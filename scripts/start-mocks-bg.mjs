/**
 * start-mocks-bg.mjs
 *
 * Boots all mockoon environments declared in test/mocks/environments/ and
 * keeps the process alive until it receives SIGINT/SIGTERM. Writes:
 *
 *   .tmp/mocks-urls.json   { env: { name: baseUrl }, vars: { ENV_VAR: value } }
 *   .env.mocks             dotenv-style file with the same vars (KEY=value)
 *   .tmp/mocks.pid         this process's PID (for the legacy stop helpers)
 *   .tmp/mocks.env         sourceable shell file (legacy callers)
 *
 * Idempotent: if `.tmp/mocks-urls.json` already exists AND each URL inside
 * responds to a TCP probe, reuse them and exit fast (still writes
 * `.env.mocks` so freshly-spawned shells pick up the right values).
 *
 * Usage:
 *   node scripts/start-mocks-bg.mjs
 *   # then in another shell:
 *   source .env.mocks       # or use any dotenv loader
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const tmpDir = path.join(repoRoot, ".tmp");
const urlsFile = path.join(tmpDir, "mocks-urls.json");
const pidFile = path.join(tmpDir, "mocks.pid");
const envFile = path.join(tmpDir, "mocks.env");
const dotenvFile = path.join(repoRoot, ".env.mocks");

const ENV_LIST = [
  "google",
  "twilio",
  "whatsapp",
  "calendly",
  "x-twitter",
  "signal",
  "browser-workspace",
  "bluebubbles",
  "github",
  "cloud-managed",
  "lifeops-presence",
  "lifeops-samantha",
];

fs.mkdirSync(tmpDir, { recursive: true });

function probeUrl(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve(false);
      return;
    }

    const req = http.request(
      {
        method: "GET",
        host: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname || "/",
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        // Mock servers may return any status — connection success is enough.
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function reusableExistingMocks() {
  if (!fs.existsSync(urlsFile)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(urlsFile, "utf8"));
  } catch {
    return null;
  }
  const baseUrls = parsed?.env;
  if (!baseUrls || typeof baseUrls !== "object") return null;

  const probes = await Promise.all(
    Object.values(baseUrls).map((url) => probeUrl(String(url))),
  );
  if (probes.every(Boolean)) {
    return parsed;
  }
  return null;
}

function writeArtifacts({ baseUrls, envVars }) {
  fs.writeFileSync(
    urlsFile,
    `${JSON.stringify({ env: baseUrls, vars: envVars }, null, 2)}\n`,
    "utf8",
  );

  const dotenvLines = Object.entries(envVars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  fs.writeFileSync(dotenvFile, `${dotenvLines}\n`, "utf8");

  const sourceableLines = Object.entries(envVars)
    .map(([key, value]) => `export ${key}=${value}`)
    .join("\n");
  fs.writeFileSync(envFile, `${sourceableLines}\n`, "utf8");
}

const reuse = await reusableExistingMocks();
if (reuse) {
  console.log(
    "[start-mocks-bg] Reusing existing mock servers (probe ok). URLs:",
  );
  for (const [env, url] of Object.entries(reuse.env)) {
    console.log(`  ${env}: ${url}`);
  }
  // Refresh derived files so any new shells see the latest values.
  writeArtifacts({ baseUrls: reuse.env, vars: reuse.vars ?? {} });
  process.exit(0);
}

const startMocksJsPath = path.join(
  repoRoot,
  "test",
  "mocks",
  "scripts",
  "start-mocks.js",
);
const startMocksTsPath = path.join(
  repoRoot,
  "test",
  "mocks",
  "scripts",
  "start-mocks.ts",
);
const startMocksPath = fs.existsSync(startMocksJsPath)
  ? startMocksJsPath
  : startMocksTsPath;
const { startMocks } = await import(startMocksPath);

console.log("[start-mocks-bg] Starting mock servers...");

let mocks;
try {
  mocks = await startMocks({ envs: ENV_LIST });
} catch (err) {
  console.error(
    "[start-mocks-bg] ERROR Failed to start mocks:",
    err?.message ?? err,
  );
  process.exit(1);
}

writeArtifacts({ baseUrls: mocks.baseUrls, envVars: mocks.envVars });
fs.writeFileSync(pidFile, String(process.pid), "utf8");

console.log("[start-mocks-bg] Mock servers running:");
for (const [env, url] of Object.entries(mocks.baseUrls)) {
  console.log(`  ${env}: ${url}`);
}
console.log(`[start-mocks-bg] URLs file: ${urlsFile}`);
console.log(`[start-mocks-bg] Dotenv:    ${dotenvFile}`);
console.log(`[start-mocks-bg] PID file:  ${pidFile}`);
console.log("[start-mocks-bg] Run: source .tmp/mocks.env (or load .env.mocks)");
console.log("[start-mocks-bg] Waiting (Ctrl+C to stop)...");

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[start-mocks-bg] Stopping mock servers...");
  try {
    await mocks.stop();
  } finally {
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // ignore — file may already be gone
    }
    // Leave urlsFile + .env.mocks in place. Their TCP probe will fail when
    // the servers go down, so the next run still goes through the fresh
    // startup path; keeping the file lets shells that already loaded the
    // env see the same state until they re-source.
    console.log("[start-mocks-bg] Done.");
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await new Promise(() => {});
