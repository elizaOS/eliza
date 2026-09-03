#!/usr/bin/env node
/**
 * Runs exact-SHA staging latency certification while retaining only bounded,
 * privacy-safe evidence. Raw Worker Tail bytes remain in a private temporary
 * directory that is removed on every success or failure path.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  isCloudflarePlacement,
  sanitizeInferenceAuthTail,
  summarizeDeferredCacheWrites,
  waitForInferenceAuthTail,
} from "./inference-auth-latency.mjs";

const STAGING_BASE_URL = "https://api-staging.eliza.app";
const CEREBRAS_BASE_URL = "https://api.cerebras.ai";
const STAGING_WORKER = "eliza-cloud-api-staging";
const EXPECTED_PAIRED_RECORDS = 44;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

function sleep(durationMs) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, durationMs),
  );
}

function parseJsonLines(text, label) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("record is not an object");
      }
      return value;
    } catch (cause) {
      // error-policy:J2 certification evidence must be complete JSONL; retain
      // the parser cause locally without echoing arbitrary record contents.
      throw new Error(`${label} record ${index + 1} is invalid JSON`, {
        cause,
      });
    }
  });
}

export function parseCertificationArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "deploy-sha": { type: "string" },
      "output-dir": { type: "string" },
      auth: { type: "boolean", default: false },
      suspended: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const deploySha = values["deploy-sha"]?.trim() ?? "";
  if (!SHA_PATTERN.test(deploySha)) {
    throw new Error("--deploy-sha must be a lowercase 40-character commit");
  }
  const outputDir = values["output-dir"]?.trim() ?? "";
  if (!outputDir) throw new Error("--output-dir is required");
  if (values.suspended && !values.auth) {
    throw new Error("--suspended requires --auth");
  }
  return {
    deploySha,
    outputDir: resolve(outputDir),
    runAuth: values.auth,
    runSuspended: values.suspended,
  };
}

function requireSecret(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Required protected secret is missing: ${name}`);
  return value;
}

export function requirePairedSecrets(env) {
  return {
    directApiKey: requireSecret(env, "CEREBRAS_API_KEY"),
    gatewayApiKey: requireSecret(env, "ELIZAOS_CLOUD_API_KEY"),
  };
}

export function requireAuthSecrets(env, runSuspended = false) {
  const secrets = {
    apiKey: requireSecret(env, "ELIZAOS_CLOUD_API_KEY"),
    probeToken: requireSecret(env, "INFERENCE_AUTH_PROBE_TOKEN"),
    cloudflareApiToken: requireSecret(env, "CLOUDFLARE_API_TOKEN"),
    cloudflareAccountId: requireSecret(env, "CLOUDFLARE_ACCOUNT_ID"),
  };
  return runSuspended
    ? {
        ...secrets,
        suspendedApiKey: requireSecret(env, "ELIZA_STAGING_SUSPENDED_API_KEY"),
      }
    : secrets;
}

export async function verifyExactDeployment(deploySha, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${STAGING_BASE_URL}/api/health`, {
      headers: { "user-agent": "eliza-cloud-latency-certification/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    // error-policy:J2 keep network details out of the workflow boundary while
    // preserving the local cause for a debugger.
    throw new Error("Staging health request failed", { cause });
  }
  if (!response.ok) {
    throw new Error(`Staging health returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body?.commit !== deploySha) {
    throw new Error("Staging Worker did not serve the expected commit");
  }
  if (body?.environment !== "staging") {
    throw new Error("Staging health returned the wrong environment");
  }
  return { kind: "deployment", deploySha, environment: "staging" };
}

export function validatePairedEvidence(text, deploySha) {
  const records = parseJsonLines(text, "Paired latency evidence");
  if (records.length !== EXPECTED_PAIRED_RECORDS) {
    throw new Error(
      `Paired latency evidence must contain ${EXPECTED_PAIRED_RECORDS} records`,
    );
  }
  const counts = { direct: 0, gateway: 0 };
  for (const record of records) {
    if (record.target !== "direct" && record.target !== "gateway") {
      throw new Error("Paired latency evidence contains an unexpected target");
    }
    counts[record.target]++;
    if (
      record.ok !== true ||
      record.transportOk !== true ||
      record.proofMatched !== true
    ) {
      throw new Error("Paired latency evidence contains a failed proof");
    }
    if (record.ci?.sha !== deploySha) {
      throw new Error(
        "Paired latency evidence is not bound to the dispatch SHA",
      );
    }
    const placement = record.headers?.["cf-placement"];
    if (
      record.target === "gateway" &&
      placement !== undefined &&
      !isCloudflarePlacement(placement)
    ) {
      throw new Error(
        "Gateway latency evidence contains an invalid Worker placement",
      );
    }
    if (
      record.target === "gateway" &&
      typeof placement === "string" &&
      placement.startsWith("remote-")
    ) {
      throw new Error(
        "Gateway latency evidence observed remote Worker placement",
      );
    }
  }
  if (counts.direct !== 22 || counts.gateway !== 22) {
    throw new Error("Paired latency evidence is not a balanced 20-run matrix");
  }
  return { records, counts };
}

export function validateAuthEvidence(text, deploySha, runSuspended = false) {
  const records = parseJsonLines(text, "Inference auth evidence");
  const expectedRecordCount = runSuspended ? 45 : 44;
  if (records.length !== expectedRecordCount) {
    throw new Error(
      `Inference auth evidence must contain ${expectedRecordCount} records`,
    );
  }
  const deployment = records.filter((record) => record.kind === "deployment");
  const samples = records.filter((record) => record.kind === "sample");
  const guards = records.filter((record) => record.kind === "guard");
  const summaries = records.filter((record) => record.kind === "summary");
  if (
    deployment.length !== 1 ||
    samples.length !== 40 ||
    guards.length !== (runSuspended ? 3 : 2) ||
    summaries.length !== 1
  ) {
    throw new Error("Inference auth evidence has an invalid record matrix");
  }
  if (
    deployment[0].deploySha !== deploySha ||
    deployment[0].environment !== "staging"
  ) {
    throw new Error("Inference auth deployment evidence is not exact staging");
  }
  const hits = samples.filter((record) => record.phase === "hit");
  const misses = samples.filter((record) => record.phase === "miss");
  if (hits.length !== 30 || misses.length !== 10) {
    throw new Error("Inference auth evidence has an invalid hit/miss count");
  }
  for (const record of records.filter((value) => value.kind !== "deployment")) {
    if (record.deploySha !== deploySha) {
      throw new Error(
        "Inference auth evidence contains a different deploy SHA",
      );
    }
  }
  for (const record of hits) {
    if (
      record.status !== 400 ||
      record.auth?.read !== "hit" ||
      record.auth?.result !== "authorized_cache"
    ) {
      throw new Error(
        "Inference auth hit evidence is not a cache authorization",
      );
    }
  }
  for (const record of misses) {
    if (
      record.status !== 400 ||
      record.auth?.read !== "miss" ||
      record.auth?.authoritative !== "authorized" ||
      record.auth?.write !== "deferred" ||
      record.auth?.result !== "authorized_origin"
    ) {
      throw new Error("Inference auth miss evidence is not authoritative");
    }
  }
  const guardByName = new Map(guards.map((record) => [record.guard, record]));
  if (
    guardByName.get("invalid_key")?.status !== 401 ||
    guardByName.get("forged_probe")?.status !== 400
  ) {
    throw new Error("Inference auth guard evidence is incomplete");
  }
  const suspendedGuard = guardByName.get("suspended_key");
  if (
    (runSuspended && suspendedGuard?.status !== 403) ||
    (!runSuspended && suspendedGuard !== undefined)
  ) {
    throw new Error("Inference auth suspended guard evidence is inconsistent");
  }
  const expectedSuspendedStatus = runSuspended ? "observed" : "not_requested";
  if (summaries[0]?.suspendedGuard !== expectedSuspendedStatus) {
    throw new Error("Inference auth summary misstates the suspended guard");
  }
  const traceIds = [...samples, ...guards].map((record) => record.traceId);
  if (
    traceIds.length !== (runSuspended ? 43 : 42) ||
    new Set(traceIds).size !== traceIds.length ||
    traceIds.some((traceId) => !TRACE_ID_PATTERN.test(traceId))
  ) {
    throw new Error("Inference auth evidence has invalid trace correlation");
  }
  return { records, traceIds };
}

export async function withPrivateTailDirectory(task, root = tmpdir()) {
  const directory = await mkdtemp(join(root, "eliza-inference-auth-tail-"));
  await chmod(directory, 0o700);
  let result;
  let failure;
  try {
    result = await task(directory);
  } catch (error) {
    // error-policy:J5 the same failure is rethrown immediately after the raw
    // Tail directory has been removed.
    failure = error;
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (cause) {
    // error-policy:J2 raw Tail cleanup is a security boundary and therefore
    // cannot degrade to a warning or a successful certification.
    throw new Error("Private Worker Tail cleanup failed", { cause });
  }
  if (failure) throw failure;
  return result;
}

async function runCommandToFile({
  command,
  args,
  stdoutPath,
  stderrPath,
  env,
  label,
}) {
  const stdout = await open(stdoutPath, "wx", 0o600);
  const stderr = await open(stderrPath, "wx", 0o600);
  try {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    const exitCode = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", (cause) => {
        rejectPromise(new Error(`${label} could not start`, { cause }));
      });
      child.once("exit", (code, signal) => {
        if (signal) {
          rejectPromise(new Error(`${label} exited from signal ${signal}`));
          return;
        }
        resolvePromise(code ?? 1);
      });
    });
    if (exitCode !== 0)
      throw new Error(`${label} failed with exit ${exitCode}`);
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
}

async function startPrivateTail(directory, env) {
  const rawPath = join(directory, "wrangler-tail.raw.json");
  const stderrPath = join(directory, "wrangler-tail.stderr");
  const stdout = await open(rawPath, "wx", 0o600);
  const stderr = await open(stderrPath, "wx", 0o600);
  const child = spawn(
    "bunx",
    ["wrangler@4.116.0", "tail", STAGING_WORKER, "--format", "json"],
    { env, stdio: ["ignore", stdout.fd, stderr.fd] },
  );
  await Promise.all([stdout.close(), stderr.close()]);
  return { child, rawPath };
}

async function raceTailLifetime(child, operation) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (cause) => {
      cleanup();
      rejectPromise(new Error("Worker Tail could not start", { cause }));
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectPromise(
        new Error(
          `Worker Tail stopped before evidence capture (${signal ?? code ?? "unknown"})`,
        ),
      );
    };
    child.once("error", onError);
    child.once("exit", onExit);
    operation.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        cleanup();
        rejectPromise(error);
      },
    );
  });
}

async function stopTail(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => {
    child.once("exit", () => resolvePromise(true));
  });
  child.kill("SIGINT");
  const stopped = await Promise.race([exited, sleep(5_000).then(() => false)]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function waitForSanitizedTail(rawPath, traceIds, deploySha) {
  let lastFailure;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (attempt > 0) await sleep(250);
    try {
      const rawText = await readFile(rawPath, "utf8");
      return sanitizeInferenceAuthTail(rawText, traceIds, deploySha);
    } catch (error) {
      // error-policy:J3 a live JSON stream can be incomplete between writes;
      // only a fully sanitized fixed-schema result leaves this retry boundary.
      lastFailure = error;
    }
  }
  throw new Error(
    "Worker Tail did not yield complete sanitized auth evidence",
    {
      cause: lastFailure,
    },
  );
}

async function runPaired({ deploySha, outputDir, env }) {
  requirePairedSecrets(env);
  const outputPath = join(outputDir, "paired.jsonl");
  const stderrPath = join(outputDir, ".paired.stderr");
  const scriptPath = new URL("./chat-latency.mjs", import.meta.url);
  try {
    await runCommandToFile({
      command: process.execPath,
      args: [
        scriptPath.pathname,
        "--target",
        "paired",
        "--gateway-base-url",
        STAGING_BASE_URL,
        "--direct-base-url",
        CEREBRAS_BASE_URL,
        "--gateway-api-key-env",
        "ELIZAOS_CLOUD_API_KEY",
        "--direct-api-key-env",
        "CEREBRAS_API_KEY",
        "--case",
        "gemma-4-31b@omit@512",
        "--repeat",
        "20",
        "--idle-ms",
        "500",
        "--pair-interval-ms",
        "250",
        "--seed",
        `staging-${deploySha}`,
      ],
      stdoutPath: outputPath,
      stderrPath,
      env: { ...env, ELIZA_GATEWAY_DEPLOY_SHA: deploySha },
      label: "Paired latency probe",
    });
    return validatePairedEvidence(
      await readFile(outputPath, "utf8"),
      deploySha,
    );
  } finally {
    await rm(stderrPath, { force: true });
  }
}

async function runAuth({ deploySha, outputDir, env, runSuspended }) {
  const secrets = requireAuthSecrets(env, runSuspended);
  const privateRoot = env.RUNNER_TEMP?.trim() || tmpdir();
  return await withPrivateTailDirectory(async (directory) => {
    const { child, rawPath } = await startPrivateTail(directory, env);
    let failure;
    let result;
    try {
      await raceTailLifetime(
        child,
        waitForInferenceAuthTail({
          baseUrl: STAGING_BASE_URL,
          apiKey: secrets.apiKey,
          probeToken: secrets.probeToken,
          deploySha,
          timeoutMs: 30_000,
          readTail: () => readFileSync(rawPath, "utf8"),
        }),
      );
      const outputPath = join(outputDir, "inference-auth.jsonl");
      const stderrPath = join(directory, "inference-auth.stderr");
      const scriptPath = new URL(
        "./inference-auth-latency.mjs",
        import.meta.url,
      );
      await raceTailLifetime(
        child,
        runCommandToFile({
          command: process.execPath,
          args: [
            scriptPath.pathname,
            "--base-url",
            STAGING_BASE_URL,
            "--api-key-env",
            "ELIZAOS_CLOUD_API_KEY",
            "--probe-token-env",
            "INFERENCE_AUTH_PROBE_TOKEN",
            "--deploy-sha",
            deploySha,
            "--hit-count",
            "30",
            "--miss-count",
            "10",
            "--timeout-ms",
            "30000",
            "--interval-ms",
            "250",
            ...(runSuspended
              ? ["--suspended-api-key-env", "ELIZA_STAGING_SUSPENDED_API_KEY"]
              : []),
          ],
          stdoutPath: outputPath,
          stderrPath,
          env,
          label: "Inference auth probe",
        }),
      );
      const validation = validateAuthEvidence(
        await readFile(outputPath, "utf8"),
        deploySha,
        runSuspended,
      );
      const workerRecords = await raceTailLifetime(
        child,
        waitForSanitizedTail(rawPath, validation.traceIds, deploySha),
      );
      const workerPath = join(outputDir, "inference-auth-worker.jsonl");
      await writeFile(
        workerPath,
        `${workerRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
        { mode: 0o600, flag: "wx" },
      );
      result = {
        records: validation.records.length,
        workerRecords: workerRecords.length,
        suspendedGuard: runSuspended ? "observed" : "not_requested",
        deferredCacheWriteMs: summarizeDeferredCacheWrites(workerRecords),
      };
    } catch (error) {
      // error-policy:J5 the same failure is rethrown after the Tail subprocess
      // is stopped and withPrivateTailDirectory removes every raw byte.
      failure = error;
    } finally {
      try {
        await stopTail(child);
      } catch (cause) {
        // error-policy:J2 a Tail process that cannot be terminated invalidates
        // the certification rather than leaving credentialed observation alive.
        failure = new Error("Worker Tail teardown failed", { cause });
      }
    }
    if (failure) throw failure;
    return result;
  }, privateRoot);
}

export async function runCertification(
  options,
  { env = process.env, fetchImpl = fetch } = {},
) {
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  const deployment = await verifyExactDeployment(options.deploySha, fetchImpl);
  await writeFile(
    join(options.outputDir, "deployment.json"),
    `${JSON.stringify(deployment)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  const paired = await runPaired({ ...options, env });
  const auth = options.runAuth
    ? await runAuth({ ...options, env })
    : {
        skipped: true,
        reason: "not_requested",
        suspendedGuard: "not_requested",
      };
  const summary = {
    kind: "cloud_latency_certification",
    deploySha: options.deploySha,
    environment: "staging",
    paired: { records: paired.records.length, counts: paired.counts },
    auth,
  };
  await writeFile(
    join(options.outputDir, "summary.json"),
    `${JSON.stringify(summary)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCertification(parseCertificationArgs(process.argv.slice(2))).catch(
    (error) => {
      // error-policy:J1 the CLI emits one bounded category; child stderr, raw
      // Tail bytes, request headers, and nested causes never reach Actions logs.
      process.stderr.write(
        `[cloud-latency-certification] ${error instanceof Error ? error.message : "unknown failure"}\n`,
      );
      process.exitCode = 1;
    },
  );
}
