#!/usr/bin/env node
/**
 * Run `bun run dev` for a fixed window and assess whether the local agent stack
 * started cleanly.
 *
 * Default checks:
 * - UI responds on http://127.0.0.1:2138/
 * - API health responds on http://127.0.0.1:31337/api/health with ready/ok
 * - Logs do not contain fatal/error/timeout signatures
 * - The dev process does not exit before the observation window completes
 *
 * Usage:
 *   node scripts/dev-health-check.mjs
 *   node scripts/dev-health-check.mjs --seconds=120
 *   node scripts/dev-health-check.mjs --ui-port=2138 --api-port=31337
 */
import { execFile, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_SECONDS = 90;
const DEFAULT_UI_PORT = 2138;
const DEFAULT_API_PORT = 31337;
const DEFAULT_INITIAL_PROBE_DELAY_MS = 8000;
const POLL_INTERVAL_MS = 1000;
const FETCH_TIMEOUT_MS = 3000;
const FINAL_PROBE_RETRIES = 3;
const FINAL_PROBE_RETRY_DELAY_MS = 1000;

function parseArgs(argv) {
  const options = {
    seconds: DEFAULT_SECONDS,
    uiPort: Number(process.env.ELIZA_UI_PORT || process.env.ELIZA_PORT) || DEFAULT_UI_PORT,
    apiPort: Number(process.env.ELIZA_API_PORT) || DEFAULT_API_PORT,
    initialProbeDelayMs: DEFAULT_INITIAL_PROBE_DELAY_MS,
    logDir: path.join(process.cwd(), "logs"),
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const [key, value] = arg.split("=", 2);
    if (!value) {
      throw new Error(`Expected --key=value, got ${arg}`);
    }
    if (key === "--seconds") {
      options.seconds = parsePositiveNumber(value, "--seconds");
    } else if (key === "--duration-ms") {
      options.seconds = parsePositiveNumber(value, "--duration-ms") / 1000;
    } else if (key === "--ui-port") {
      options.uiPort = parsePositiveInteger(value, "--ui-port");
    } else if (key === "--api-port") {
      options.apiPort = parsePositiveInteger(value, "--api-port");
    } else if (key === "--initial-probe-delay-ms") {
      options.initialProbeDelayMs = parsePositiveNumber(
        value,
        "--initial-probe-delay-ms",
      );
    } else if (key === "--log-dir") {
      options.logDir = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${key}`);
    }
  }

  return options;
}

function prependPath(env, entries) {
  const existing = env.PATH || "";
  const nextEntries = entries.filter(Boolean);
  return {
    ...env,
    PATH: [...nextEntries, existing].filter(Boolean).join(path.delimiter),
  };
}

function executableExists(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commonBunDirs() {
  const dirs = [];
  const home = process.env.HOME;
  if (home) {
    dirs.push(path.join(home, ".bun", "bin"));
  }
  dirs.push(path.join(process.cwd(), "node_modules", ".bin"));
  dirs.push("/opt/homebrew/bin");
  dirs.push("/usr/local/bin");
  return [...new Set(dirs)].filter((dir) => existsSync(dir));
}

function resolveExecutable(command, env) {
  const pathEnv = env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    if (executableExists(candidate)) {
      return candidate;
    }
  }
  return command;
}

function printHelp() {
  console.log(`Usage: node scripts/dev-health-check.mjs [options]

Options:
  --seconds=N       Observation window in seconds, default ${DEFAULT_SECONDS}
  --duration-ms=N   Observation window in milliseconds
  --ui-port=N       UI port to probe, default ${DEFAULT_UI_PORT}
  --api-port=N      API port to probe, default ${DEFAULT_API_PORT}
  --initial-probe-delay-ms=N
                    Startup delay before probing, default ${DEFAULT_INITIAL_PROBE_DELAY_MS}
  --log-dir=PATH    Directory for captured logs, default ./logs`);
}

function parsePositiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== String(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function timestamp() {
  return new Date().toISOString();
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function createLogPath(logDir) {
  const safeStamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `dev-health-check-${safeStamp}.log`);
}

function createRunState(logPath) {
  const runId = path.basename(logPath, ".log").replace(/^dev-health-check-/, "");
  const runDir = path.join(process.cwd(), "tmp", "dev-health-check", runId);
  const stateDir = path.join(runDir, "state");
  const pgliteDataDir = path.join(runDir, ".elizadb");
  mkdirSync(stateDir, { recursive: true });
  return {
    runId,
    runDir,
    stateDir,
    pgliteDataDir,
  };
}

function formatLogChunk(source, at, text) {
  const prefix = `[${new Date(at).toISOString()}] [${source}] `;
  return text
    .split(/\r?\n/)
    .map((line) => (line ? `${prefix}${line}` : ""))
    .join("\n");
}

function appendLog(logChunks, logStream, source, chunk) {
  const text = chunk.toString();
  const clean = stripAnsi(text);
  const at = Date.now();
  logChunks.push({
    source,
    at,
    text: clean,
  });
  logStream.write(formatLogChunk(source, at, clean));
}

function allLogText(logChunks) {
  return logChunks
    .map((entry) => formatLogChunk(entry.source, entry.at, entry.text))
    .join("");
}

function splitLines(logText) {
  return logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isIgnorableLine(line) {
  return [
    /Local access: no password required/i,
    /ErrorBoundary/i,
    /error handler/i,
    /without UI/i,
    /Security settings:/i,
    /\bfailed=0\b/i,
    /\b0 failed\b/i,
    /\bvalidation failed\b/i,
    /\btimeout:\s*\d+ms\b/i,
    /\b(requestTimeout|headersTimeout|keepAliveTimeout)=\d+ms\b/i,
    /script "dev" was terminated by signal SIGTERM/i,
    /Polite quit request/i,
  ].some((pattern) => pattern.test(line));
}

function analyzeLogs(logText) {
  const lines = splitLines(logText);
  const readinessPatterns = [
    /\bAPI port open\b/i,
    /\bAgent ready\b/i,
    /http:\/\/localhost:\d+\//i,
    /\bready in\b/i,
  ];

  const suspectLines = [];
  const readinessLines = [];

  for (const line of lines) {
    if (readinessPatterns.some((pattern) => pattern.test(line))) {
      readinessLines.push(line);
    }
    if (!isIgnorableLine(line) && isSuspiciousLogLine(line)) {
      suspectLines.push(line);
    }
  }

  return {
    lineCount: lines.length,
    suspectLines,
    readinessLines,
  };
}

function isSuspiciousLogLine(line) {
  if (/\b(Fatal|Unhandled|Uncaught|SyntaxError|TypeError|ReferenceError|RangeError)\b/i.test(line)) {
    return true;
  }
  if (/\b(EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_[A-Z0-9_]+)\b/.test(line)) {
    return true;
  }
  if (/\bPort \d+ is already in use\b/i.test(line)) {
    return true;
  }
  if (/\bRetrying with dynamic port\b/i.test(line)) {
    return true;
  }
  if (/\b(timed out|timeout)\b/i.test(line)) {
    return true;
  }
  if (/\]\s+\[(?:stdout|stderr)\]\s+Error\b/i.test(line)) {
    return true;
  }
  if (/\b(Runtime bootstrap failed|Migration failed|Task execution failed|failed to load model|proxy error|crashed during init)\b/i.test(line)) {
    return true;
  }
  if (/\bUsage: eliza\b/i.test(line)) {
    return true;
  }
  return false;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileResult(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      timeout: options.timeout ?? FETCH_TIMEOUT_MS + 1000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        error,
        stdout,
        stderr,
      });
    });
  });
}

async function probeTcpPort(port) {
  const result = await execFileResult("nc", [
    "-z",
    "-w",
    String(Math.ceil(FETCH_TIMEOUT_MS / 1000)),
    "127.0.0.1",
    String(port),
  ]);
  if (result.ok) {
    return { ok: true };
  }
  const message = result.stderr?.trim() || result.error?.message || "not listening";
  return {
    ok: false,
    error: /timed out|timeout/i.test(message) ? "timeout" : message,
  };
}

async function probeHttp(url, { parseJson = false } = {}) {
  const marker = "__ELIZA_DEV_HEALTH_HTTP_STATUS__:";
  const result = await execFileResult("curl", [
    "--silent",
    "--show-error",
    "--max-time",
    String(Math.ceil(FETCH_TIMEOUT_MS / 1000)),
    "--write-out",
    `\n${marker}%{http_code}`,
    url,
  ]);

  if (!result.ok) {
    const message = result.stderr?.trim() || result.error?.message || "fetch failed";
    return {
      ok: false,
      error:
        result.error?.killed || /timed out|timeout/i.test(message)
          ? "timeout"
          : message,
    };
  }

  const markerIndex = result.stdout.lastIndexOf(`\n${marker}`);
  const bodyText =
    markerIndex >= 0 ? result.stdout.slice(0, markerIndex) : result.stdout;
  const statusText =
    markerIndex >= 0 ? result.stdout.slice(markerIndex + marker.length + 1) : "";
  const status = Number.parseInt(statusText.trim(), 10) || 0;
  const response = {
    ok: status >= 200 && status < 400,
    status,
    bodyPreview: bodyText.slice(0, 500),
  };

  if (parseJson) {
    try {
      response.body = JSON.parse(bodyText);
    } catch (error) {
      response.ok = false;
      response.error = `invalid JSON: ${error.message}`;
    }
  }

  return response;
}

function apiHealthReady(result) {
  if (!result.ok || !result.body || typeof result.body !== "object") {
    return false;
  }
  return result.body.ready === true || result.body.ok === true;
}

function apiHealthProblem(result) {
  if (!result.body || typeof result.body !== "object") {
    return null;
  }

  const body = result.body;
  if (body.agentState === "error") {
    return body.startup?.lastError
      ? `agentState=error: ${body.startup.lastError}`
      : "agentState=error";
  }
  if (body.startup?.phase && /error|failed|timeout/i.test(body.startup.phase)) {
    return body.startup?.lastError
      ? `startup phase=${body.startup.phase}: ${body.startup.lastError}`
      : `startup phase=${body.startup.phase}`;
  }
  if (typeof body.runtime === "string" && /error|failed/i.test(body.runtime)) {
    return `runtime=${body.runtime}`;
  }
  if (typeof body.database === "string" && /error|failed/i.test(body.database)) {
    return `database=${body.database}`;
  }
  if (
    body.plugins &&
    typeof body.plugins === "object" &&
    Number(body.plugins.failed) > 0
  ) {
    return `plugins.failed=${body.plugins.failed}`;
  }
  return null;
}

async function probeStack(uiPort, apiPort) {
  const [uiTcp, apiTcp, uiHttp, apiHealth] = await Promise.all([
    probeTcpPort(uiPort),
    probeTcpPort(apiPort),
    probeHttp(`http://127.0.0.1:${uiPort}/`),
    probeHttp(`http://127.0.0.1:${apiPort}/api/health`, { parseJson: true }),
  ]);

  return {
    at: Date.now(),
    uiTcp,
    apiTcp,
    uiHttp,
    apiHealth,
    uiReady: uiTcp.ok && uiHttp.ok,
    apiReady: apiTcp.ok && apiHealthReady(apiHealth),
    apiProblem: apiHealthProblem(apiHealth),
  };
}

function summarizeProbe(probe) {
  const uiHttp = probe.uiHttp.ok
    ? `HTTP ${probe.uiHttp.status}`
    : probe.uiHttp.error || `HTTP ${probe.uiHttp.status || "not ready"}`;
  const apiHealth = probe.apiHealth.ok
    ? `HTTP ${probe.apiHealth.status}`
    : probe.apiHealth.error || `HTTP ${probe.apiHealth.status || "not ready"}`;
  return `ui=${probe.uiReady ? "ready" : "not-ready"} (${uiHttp}), api=${probe.apiReady ? "ready" : "not-ready"} (${apiHealth})`;
}

async function terminateProcessTree(child) {
  if (!child.pid) return;

  const signalTarget =
    process.platform === "win32" || !child.spawnargs ? child.pid : -child.pid;

  try {
    process.kill(signalTarget, "SIGTERM");
  } catch {
    return;
  }

  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    wait(5000).then(() => false),
  ]);
  if (exited) return;

  try {
    process.kill(signalTarget, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const durationMs = Math.round(options.seconds * 1000);
  const logPath = createLogPath(options.logDir);
  const runState = createRunState(logPath);
  const logStream = createWriteStream(logPath, { flags: "a" });
  const logChunks = [];
  const probes = [];

  console.log(
    `[dev-health-check] ${timestamp()} starting: bun run dev (${formatDuration(durationMs)})`,
  );
  console.log(
    `[dev-health-check] probing UI :${options.uiPort} and API :${options.apiPort}; log: ${logPath}`,
  );

  const executionEnv = prependPath(
    {
      ...process.env,
      FORCE_COLOR: "0",
      ELIZA_DEV_NO_WATCH: process.env.ELIZA_DEV_NO_WATCH || "1",
      ELIZA_DEV_PLUGIN_BUILD: process.env.ELIZA_DEV_PLUGIN_BUILD || "0",
      ELIZA_SKIP_PLUGIN_BUILD: process.env.ELIZA_SKIP_PLUGIN_BUILD || "1",
      ELIZA_DISABLE_PROACTIVE_AGENT:
        process.env.ELIZA_DISABLE_PROACTIVE_AGENT || "1",
      ELIZA_DISABLE_TRAINING_CRONS:
        process.env.ELIZA_DISABLE_TRAINING_CRONS || "1",
      ELIZAOS_CLOUD_API_KEY:
        process.env.ELIZA_DEV_HEALTH_USE_CLOUD === "1"
          ? process.env.ELIZAOS_CLOUD_API_KEY || ""
          : "",
      ELIZAOS_CLOUD_ENABLED:
        process.env.ELIZA_DEV_HEALTH_USE_CLOUD === "1"
          ? process.env.ELIZAOS_CLOUD_ENABLED || ""
          : "",
      EVM_PRIVATE_KEY: process.env.ELIZA_DEV_HEALTH_USE_WALLET === "1"
        ? process.env.EVM_PRIVATE_KEY || ""
        : "",
      ELIZA_STATE_DIR: runState.stateDir,
      PGLITE_DATA_DIR: runState.pgliteDataDir,
    },
    commonBunDirs(),
  );
  const bunCommand = resolveExecutable("bun", executionEnv);

  const child = spawn(bunCommand, ["run", "dev"], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: executionEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let childExit = null;
  child.stdout.on("data", (chunk) =>
    appendLog(logChunks, logStream, "stdout", chunk),
  );
  child.stderr.on("data", (chunk) =>
    appendLog(logChunks, logStream, "stderr", chunk),
  );
  child.on("error", (error) => {
    childExit = { code: null, signal: null, error: error.message, at: Date.now() };
  });
  child.on("exit", (code, signal) => {
    childExit = { code, signal, error: null, at: Date.now() };
  });

  const startedAt = Date.now();
  const firstProbeAt = startedAt + options.initialProbeDelayMs;
  let lastStatus = "";
  while (Date.now() - startedAt < durationMs) {
    if (Date.now() < firstProbeAt) {
      await wait(Math.min(POLL_INTERVAL_MS, firstProbeAt - Date.now()));
      if (childExit) break;
      continue;
    }
    const probe = await probeStack(options.uiPort, options.apiPort);
    probes.push(probe);
    const status = summarizeProbe(probe);
    if (status !== lastStatus) {
      console.log(
        `[dev-health-check] ${formatDuration(Date.now() - startedAt)} ${status}`,
      );
      lastStatus = status;
    }
    if (childExit) break;
    await wait(POLL_INTERVAL_MS);
  }

  let finalProbe =
    probes.at(-1) ?? (await probeStack(options.uiPort, options.apiPort));
  for (
    let attempt = 1;
    attempt <= FINAL_PROBE_RETRIES &&
    (!finalProbe.uiReady || !finalProbe.apiReady || finalProbe.apiProblem);
    attempt += 1
  ) {
    await wait(FINAL_PROBE_RETRY_DELAY_MS);
    finalProbe = await probeStack(options.uiPort, options.apiPort);
    probes.push(finalProbe);
    console.log(
      `[dev-health-check] final confirmation ${attempt}/${FINAL_PROBE_RETRIES}: ${summarizeProbe(finalProbe)}`,
    );
  }

  await terminateProcessTree(child);

  const logText = allLogText(logChunks);
  await new Promise((resolve) => logStream.end(resolve));
  writeFileSync(logPath, logText, "utf8");

  const logAnalysis = analyzeLogs(logText);
  const uiEverReady = probes.some((probe) => probe.uiReady);
  const apiEverReady = probes.some((probe) => probe.apiReady);
  const exitedEarly = Boolean(
    childExit && childExit.at && childExit.at - startedAt < durationMs - 1000,
  );

  const failures = [];
  if (childExit?.error) {
    failures.push(`dev process failed to spawn: ${childExit.error}`);
  } else if (exitedEarly) {
    failures.push(
      `dev process exited before ${formatDuration(durationMs)} (${childExit.signal || `code ${childExit.code}`})`,
    );
  }
  if (!uiEverReady) {
    failures.push(`UI never became ready on port ${options.uiPort}`);
  }
  if (!apiEverReady) {
    failures.push(`API /api/health never became ready on port ${options.apiPort}`);
  }
  if (!finalProbe.uiReady) {
    failures.push(`UI was not ready at the end of the run on port ${options.uiPort}`);
  }
  if (!finalProbe.apiReady) {
    failures.push(
      `API /api/health was not ready at the end of the run on port ${options.apiPort}`,
    );
  }
  if (finalProbe.apiProblem) {
    failures.push(`API health reports a runtime problem: ${finalProbe.apiProblem}`);
  }
  if (logAnalysis.suspectLines.length > 0) {
    failures.push(`${logAnalysis.suspectLines.length} suspicious log line(s) found`);
  }

  const report = {
    status: failures.length === 0 ? "pass" : "fail",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    command: "bun run dev",
    uiPort: options.uiPort,
    apiPort: options.apiPort,
    logPath,
    runState,
    childExit,
    finalProbe,
    uiEverReady,
    apiEverReady,
    log: {
      lineCount: logAnalysis.lineCount,
      readinessLines: logAnalysis.readinessLines.slice(-20),
      suspectLines: logAnalysis.suspectLines.slice(0, 60),
      suspectLineCount: logAnalysis.suspectLines.length,
    },
    failures,
  };

  const reportPath = logPath.replace(/\.log$/, ".json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`[dev-health-check] final: ${summarizeProbe(finalProbe)}`);
  console.log(`[dev-health-check] log lines: ${logAnalysis.lineCount}`);
  if (logAnalysis.readinessLines.length > 0) {
    console.log("[dev-health-check] readiness evidence:");
    for (const line of logAnalysis.readinessLines.slice(-5)) {
      console.log(`  ${line}`);
    }
  }
  if (logAnalysis.suspectLines.length > 0) {
    console.log("[dev-health-check] suspicious logs:");
    for (const line of logAnalysis.suspectLines.slice(0, 20)) {
      console.log(`  ${line}`);
    }
  }
  console.log(`[dev-health-check] report: ${reportPath}`);

  if (failures.length > 0) {
    console.error("[dev-health-check] FAIL");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log("[dev-health-check] PASS");
}

run().catch((error) => {
  console.error(`[dev-health-check] ${error?.stack || error}`);
  process.exit(1);
});
