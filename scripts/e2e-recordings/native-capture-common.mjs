/**
 * Shared helpers for the native capture scripts (capture-android-emu,
 * capture-ios-sim): CLI/env arg parsing, evidence-path resolution, capture
 * logging, starting the device-facing host agent, artifact copying, and writing
 * the capture manifest. SKIP_EXIT_CODE (77) is the agreed "device unavailable,
 * skip cleanly" exit code across those scripts.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SKIP_EXIT_CODE = 77;

export function hasArg(args, flag) {
  return args.includes(flag);
}

export function argValue(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function resolveCapturePaths({ repoRoot, platform, slug, args }) {
  const issue = argValue(args, "--issue", process.env.EVIDENCE_ISSUE);
  const prefix =
    argValue(args, "--evidence-prefix", process.env.EVIDENCE_PREFIX) ??
    (issue ? `${issue}-${slug}` : `local-${slug}`);
  const evidenceDir = path.resolve(
    repoRoot,
    argValue(
      args,
      "--out",
      process.env.EVIDENCE_ARTIFACT_DIR ??
        path.join(".github", "issue-evidence", prefix),
    ),
  );
  const recordingResultDir = path.join(
    repoRoot,
    "e2e-recordings",
    platform,
    "test-results",
    "native-capture",
  );
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(recordingResultDir, { recursive: true });
  return { prefix, evidenceDir, recordingResultDir };
}

export function createCaptureLog(logPath, prefix) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  return {
    logPath,
    writeRaw(chunk) {
      stream.write(chunk);
    },
    log(message) {
      const line = `[${prefix}] ${message}`;
      console.log(line);
      stream.write(`${line}\n`);
    },
    close() {
      stream.end();
    },
  };
}

export async function runCommandWithLog(command, args, options = {}) {
  const {
    cwd,
    env = {},
    logSink,
    label = `${command} ${args.join(" ")}`,
  } = options;
  logSink?.log(`running ${label}`);

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      logSink?.writeRaw(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      logSink?.writeRaw(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} exited with ${code}`));
    });
  });
}

async function healthReady(url) {
  try {
    const response = await fetch(url, {
      headers: { "X-ElizaOS-Client-Id": "native-capture" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthReady(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

export async function startDeviceE2EHostAgent({
  repoRoot,
  port = 31337,
  timeoutMs = 180_000,
  logSink,
}) {
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  if (await waitForHealth(healthUrl, 2_000)) {
    logSink?.log(`reusing host agent at ${healthUrl}`);
    return { started: false, async stop() {} };
  }

  logSink?.log(`starting deterministic host agent at ${healthUrl}`);
  const child = spawn(
    process.execPath,
    [
      "packages/app-core/scripts/run-node-tsx.mjs",
      "packages/app-core/scripts/serve-real-local-agent.ts",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ELIZA_API_PORT: String(port),
        ELIZA_PAIRING_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    logSink?.writeRaw(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    logSink?.writeRaw(chunk);
  });

  if (!(await waitForHealth(healthUrl, timeoutMs))) {
    child.kill("SIGTERM");
    throw new Error(`host agent did not become healthy at ${healthUrl}`);
  }

  return {
    started: true,
    async stop() {
      if (child.exitCode !== null) return;
      logSink?.log("stopping deterministic host agent");
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

export function copyArtifact(src, destDir, destName, { required = true } = {}) {
  if (!src) {
    if (required) throw new Error("copyArtifact requires a source path");
    return null;
  }
  try {
    if (fs.statSync(src).size <= 0) throw new Error("empty file");
  } catch (error) {
    if (!required) return null;
    throw new Error(`artifact missing or empty: ${src} (${error.message})`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, destName ?? path.basename(src));
  fs.copyFileSync(src, dest);
  return dest;
}

export function writeCaptureManifest(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
