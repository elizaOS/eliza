#!/usr/bin/env node
/**
 * Mockoon bootstrap for the lifeops benchmark.
 *
 * One job: when `bun run lifeops:full` (or any sub-agent that imports this
 * module) starts, every Mockoon environment under
 * `eliza/test/mocks/mockoon/` is spawned, TCP-probed until each port is
 * listening, `LIFEOPS_USE_MOCKOON=1` is exported, and a cleanup hook is
 * registered so the children get SIGTERM'd on parent exit / SIGINT.
 *
 * Two usage modes:
 *
 *   (a) From another `.mjs` script:
 *
 *         import { ensureMockoonRunning } from "./lifeops-mockoon-bootstrap.mjs";
 *         const handle = await ensureMockoonRunning();
 *         // handle.connectors === [{ name, port, pid }, ...]
 *         // handle.stop() — idempotent; auto-runs on `exit` / SIGINT / SIGTERM.
 *
 *   (b) From the shell, as a standalone health-check:
 *
 *         node scripts/lifeops-mockoon-bootstrap.mjs --start   # spawn + wait, then exit 0 leaving children alive (uses unref'd detach)
 *         node scripts/lifeops-mockoon-bootstrap.mjs --stop    # kill every pid recorded under .mockoon-pids/
 *         node scripts/lifeops-mockoon-bootstrap.mjs --status  # report which ports are listening
 *
 * Children are detached via `start-all.mjs` (which already `unref`s them), so
 * a `--start` invocation can exit and leave the mock fleet running. The
 * in-process API in (a) instead tracks pids itself and kills them when the
 * caller exits.
 *
 * Why not just exec `start-all.mjs`? Because callers that embed this
 * (e.g. `lifeops-full-run.mjs`, `lifeops-mockoon-smoke.mjs`) need:
 *   - structured `connectors[]` return so they can log what's actually up;
 *   - explicit `LIFEOPS_USE_MOCKOON=1` exported in the parent's `process.env`
 *     before any child process or imported plugin reads it;
 *   - guaranteed cleanup on parent exit (orphaned mockoons hold ports across
 *     subsequent runs, which is the kind of bug the task brief calls out).
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const MOCKOON_DIR = join(REPO_ROOT, "test", "mocks", "mockoon");
const LOG_DIR = join(MOCKOON_DIR, ".mockoon-logs");
const PID_DIR = join(MOCKOON_DIR, ".mockoon-pids");

const MOCKOON_NPX_CACHE_BIN =
  "/Users/shawwalters/.npm/_npx/dcd5374e2bba9184/node_modules/.bin/mockoon-cli";

function resolveMockoonBin() {
  if (process.env.MOCKOON_BIN && existsSync(process.env.MOCKOON_BIN)) {
    return { kind: "bin", cmd: process.env.MOCKOON_BIN };
  }
  // Try $PATH.
  const which = spawnSync("which", ["mockoon-cli"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim() && existsSync(which.stdout.trim())) {
    return { kind: "bin", cmd: which.stdout.trim() };
  }
  // Repo-local npm cache from `npx @mockoon/cli@latest`.
  if (existsSync(MOCKOON_NPX_CACHE_BIN)) {
    return { kind: "bin", cmd: MOCKOON_NPX_CACHE_BIN };
  }
  // Codex desktop shells may not include Homebrew's bin directory even when
  // Node/npm are installed there.
  const homebrewNpx = "/opt/homebrew/bin/npx";
  if (existsSync(homebrewNpx)) {
    return { kind: "npx", cmd: homebrewNpx };
  }
  const localBunx = join(REPO_ROOT, "node_modules", ".bin", "bunx");
  if (existsSync(localBunx)) {
    return { kind: "bunx", cmd: localBunx };
  }
  // Last resort: npx itself. Slow cold start (~30s per env) but correct.
  return { kind: "npx", cmd: "npx" };
}

function listEnvs() {
  return readdirSync(MOCKOON_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => join(MOCKOON_DIR, f));
}

function readEnvDescriptor(envPath) {
  const data = JSON.parse(readFileSync(envPath, "utf8"));
  if (typeof data.port !== "number") {
    throw new Error(`${envPath} missing top-level numeric port`);
  }
  return {
    envPath,
    port: data.port,
    name: data.name ?? basename(envPath, ".json"),
    fileBase: basename(envPath, ".json"),
  };
}

async function isPortListening(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = connect({ port, host });
    const timer = setTimeout(() => {
      s.destroy();
      resolve(false);
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      s.end();
      resolve(true);
    });
    s.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitForPort(port, deadlineAt) {
  while (Date.now() < deadlineAt) {
    if (await isPortListening(port)) return true;
    await delay(150);
  }
  return false;
}

function spawnMockoonProcess(bin, envPath, port) {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = join(LOG_DIR, `${basename(envPath, ".json")}.log`);
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");
  const baseArgs = [
    "start",
    "--data",
    envPath,
    "--port",
    String(port),
    "--disable-log-to-file",
  ];
  let cmd;
  let args;
  if (bin.kind === "npx") {
    cmd = bin.cmd;
    args = ["--yes", "@mockoon/cli@latest", ...baseArgs];
  } else if (bin.kind === "bunx") {
    cmd = bin.cmd;
    args = ["--bun", "@mockoon/cli@latest", ...baseArgs];
  } else {
    cmd = bin.cmd;
    args = baseArgs;
  }
  const child = spawn(cmd, args, {
    stdio: ["ignore", out, err],
    detached: true,
  });
  child.unref();
  return child;
}

function writePidFile(fileBase, pid) {
  mkdirSync(PID_DIR, { recursive: true });
  writeFileSync(join(PID_DIR, `${fileBase}.pid`), String(pid));
}

function readPidFiles() {
  if (!existsSync(PID_DIR)) return [];
  return readdirSync(PID_DIR)
    .filter((f) => f.endsWith(".pid"))
    .map((f) => {
      const path = join(PID_DIR, f);
      const pid = Number(readFileSync(path, "utf8").trim());
      return { fileBase: f.replace(/\.pid$/, ""), path, pid };
    })
    .filter((r) => Number.isInteger(r.pid) && r.pid > 0);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killPids(pids, label = "mockoon-bootstrap") {
  for (const { pid, fileBase } of pids) {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`[${label}] SIGTERM ${fileBase} pid=${pid}`);
      } catch (e) {
        console.warn(
          `[${label}] could not SIGTERM ${pid}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  // Give them ~2s to exit cleanly, then SIGKILL stragglers.
  await delay(2_000);
  for (const { pid, fileBase, path } of pids) {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
        console.log(`[${label}] SIGKILL ${fileBase} pid=${pid}`);
      } catch (e) {
        console.warn(
          `[${label}] could not SIGKILL ${pid}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}

/**
 * Spawn every Mockoon environment, wait for ports, export
 * `LIFEOPS_USE_MOCKOON=1`, register exit cleanup.
 *
 * Idempotent: if every port is already listening, no new processes are
 * spawned and `connectors[].pid` for those entries is `null`.
 *
 * Options:
 *   - `timeoutMs`: per-port wait (default 60_000 — npx cold start is slow).
 *   - `label`: log prefix (default "mockoon-bootstrap").
 *   - `keepAlive`: if true, do NOT register exit cleanup. Caller owns lifecycle.
 */
export async function ensureMockoonRunning(options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const label = options.label ?? "mockoon-bootstrap";
  const keepAlive = options.keepAlive === true;

  const descriptors = listEnvs().map(readEnvDescriptor);
  if (descriptors.length === 0) {
    throw new Error(`no Mockoon envs found under ${MOCKOON_DIR}`);
  }

  const bin = resolveMockoonBin();
  console.log(
    `[${label}] using mockoon launcher kind=${bin.kind} cmd=${bin.cmd}`,
  );

  const ownedPids = [];
  const connectors = [];
  for (const d of descriptors) {
    if (await isPortListening(d.port)) {
      console.log(
        `[${label}] ${d.name} already listening on ${d.port}, skipping spawn`,
      );
      connectors.push({ name: d.name, connector: d.fileBase, port: d.port, pid: null, ownedHere: false });
      continue;
    }
    const child = spawnMockoonProcess(bin, d.envPath, d.port);
    writePidFile(d.fileBase, child.pid);
    ownedPids.push({ fileBase: d.fileBase, path: join(PID_DIR, `${d.fileBase}.pid`), pid: child.pid });
    connectors.push({ name: d.name, connector: d.fileBase, port: d.port, pid: child.pid, ownedHere: true });
    console.log(`[${label}] started ${d.name} pid=${child.pid} port=${d.port}`);
  }

  const deadlineAt = Date.now() + timeoutMs;
  const failures = [];
  for (const c of connectors) {
    const ok = await waitForPort(c.port, deadlineAt);
    if (!ok) {
      failures.push(c);
      console.error(
        `[${label}] FAIL ${c.name} did not bind port ${c.port} within ${timeoutMs}ms — see ${LOG_DIR}/${c.name}.log`,
      );
    } else {
      console.log(
        `[${label}] ready ${c.name} on http://127.0.0.1:${c.port}`,
      );
    }
  }

  if (failures.length > 0) {
    // Tear down anything WE spawned so we don't leak children on failure.
    if (ownedPids.length > 0) {
      await killPids(ownedPids, label);
    }
    throw new Error(
      `${failures.length} Mockoon env(s) failed to bind: ${failures.map((f) => f.name).join(", ")}`,
    );
  }

  // Export the runtime toggle now that every base URL is reachable.
  process.env.LIFEOPS_USE_MOCKOON = "1";

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (ownedPids.length === 0) return;
    await killPids(ownedPids, label);
  }

  if (!keepAlive && ownedPids.length > 0) {
    const onExit = () => {
      // Best-effort sync kill on exit (async stop() can't run in 'exit' handler).
      for (const { pid } of ownedPids) {
        if (pidAlive(pid)) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // ignore
          }
        }
      }
    };
    const onSignal = async (sig) => {
      console.log(`[${label}] caught ${sig} — stopping Mockoon fleet`);
      await stop();
      process.exit(0);
    };
    process.once("exit", onExit);
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  }

  return {
    connectors,
    stop,
    mockoonDir: MOCKOON_DIR,
    logDir: LOG_DIR,
    pidDir: PID_DIR,
  };
}

/**
 * Standalone CLI surface.
 */
async function cliMain() {
  const args = process.argv.slice(2);
  if (args.includes("--status")) {
    const descriptors = listEnvs().map(readEnvDescriptor);
    let down = 0;
    for (const d of descriptors) {
      const up = await isPortListening(d.port);
      console.log(`${up ? "UP  " : "DOWN"}  ${d.name.padEnd(20)} port=${d.port}`);
      if (!up) down += 1;
    }
    process.exit(down === 0 ? 0 : 1);
  }
  if (args.includes("--stop")) {
    const pids = readPidFiles();
    if (pids.length === 0) {
      console.log("[mockoon-bootstrap] no pid files; nothing to stop");
      return;
    }
    await killPids(pids);
    return;
  }
  if (args.includes("--start") || args.length === 0) {
    // Detach: spawn and exit. start-all.mjs already `unref`s children, and we
    // don't register cleanup when keepAlive=true, so child mockoons survive.
    const handle = await ensureMockoonRunning({ keepAlive: true });
    console.log(
      `[mockoon-bootstrap] started ${handle.connectors.length} env(s); ${handle.connectors.filter((c) => c.ownedHere).length} spawned, ${handle.connectors.filter((c) => !c.ownedHere).length} already up`,
    );
    return;
  }
  console.error("usage: lifeops-mockoon-bootstrap.mjs [--start|--stop|--status]");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
