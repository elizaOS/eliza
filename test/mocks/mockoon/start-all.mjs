#!/usr/bin/env node
/**
 * Spawn every Mockoon environment in this directory in parallel.
 *
 * Usage:
 *   node eliza/test/mocks/mockoon/start-all.mjs
 *   # or, in tests, set LIFEOPS_USE_MOCKOON=1 and import
 *   # `applyMockoonEnvOverrides()` from the redirect helper before
 *   # constructing the runtime.
 *
 * Writes each child's stdout/stderr to .mockoon-logs/<connector>.log so a
 * test runner can grep for failures without flooding the test output.
 *
 * Writes pids to .mockoon-pids/<connector>.pid; `stop-all.mjs` reads them.
 *
 * Exits non-zero if any child fails to bind its port within 10 seconds.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(HERE, ".mockoon-logs");
const PID_DIR = join(HERE, ".mockoon-pids");
const MOCKOON_BIN = process.env.MOCKOON_BIN ?? "mockoon-cli";
const MOCKOON_NPX_PACKAGE =
  process.env.MOCKOON_NPX_PACKAGE ?? "@mockoon/cli@latest";

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(PID_DIR, { recursive: true });

function listEnvs() {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => join(HERE, f));
}

function readPort(envPath) {
  // Each generated env declares "port" at the top level; parse without
  // booting Mockoon so we know which TCP port to wait on.
  const data = JSON.parse(readFileSync(envPath, "utf8"));
  if (typeof data.port !== "number") {
    throw new Error(`${envPath} missing top-level numeric port`);
  }
  return { port: data.port, name: data.name ?? basename(envPath, ".json") };
}

async function waitForPort(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = connect({ port, host: "127.0.0.1" }, () => {
        s.end();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (ok) return true;
    await delay(150);
  }
  return false;
}

function spawnMockoon(envPath, port) {
  const logFile = join(LOG_DIR, `${basename(envPath, ".json")}.log`);
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");

  // Prefer the direct mockoon-cli binary so we skip npm's slow `npm exec`
  // resolution path; if `MOCKOON_BIN` is set explicitly we use that. Last
  // resort: `npx --yes @mockoon/cli@latest`, which is correct but each
  // invocation can take 30+ seconds before the server actually binds.
  const useNpx = process.env.MOCKOON_USE_NPX === "1";
  const cmd = useNpx ? "npx" : MOCKOON_BIN;
  const args = useNpx
    ? ["--yes", MOCKOON_NPX_PACKAGE, "start", "--data", envPath, "--port", String(port), "--disable-log-to-file"]
    : ["start", "--data", envPath, "--port", String(port), "--disable-log-to-file"];
  const child = spawn(cmd, args, {
    stdio: ["ignore", out, err],
    detached: true,
  });
  child.unref();
  return child;
}

async function main() {
  const envs = listEnvs();
  if (envs.length === 0) {
    console.error("no Mockoon env files found");
    process.exit(1);
  }
  const started = [];
  for (const envPath of envs) {
    const { port, name } = readPort(envPath);
    const child = spawnMockoon(envPath, port);
    writeFileSync(join(PID_DIR, `${basename(envPath, ".json")}.pid`), String(child.pid));
    started.push({ envPath, port, name, pid: child.pid });
    console.log(`started ${name} pid=${child.pid} port=${port}`);
  }

  let failed = 0;
  for (const s of started) {
    const ok = await waitForPort(s.port, 10_000);
    if (!ok) {
      failed += 1;
      console.error(`FAIL: ${s.name} did not bind port ${s.port} within 10s — see ${LOG_DIR}/${basename(s.envPath, ".json")}.log`);
    } else {
      console.log(`ready ${s.name} on http://localhost:${s.port}`);
    }
  }

  if (failed > 0) {
    console.error(`${failed} environment(s) failed to start`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
