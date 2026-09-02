#!/usr/bin/env node
/**
 * Certifies a staging-only Smart Placement A/B against two pre-provisioned
 * Workers while retaining bounded timing and placement metadata only.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { parseProbeCase, probeOpenAi } from "./chat-latency.mjs";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const WORKER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DEFAULT_SUCCESS_PAIRS = 30;
const DEFAULT_MAX_ATTEMPTS = 45;

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function boundedToken(value, fallback = "unknown") {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value)
    ? value
    : fallback;
}

export function validateStagingArmUrl(raw, label) {
  let url;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new Error(`${label} must be an absolute URL`, { cause });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(`${label} must be a credential-free HTTPS origin`);
  }
  const hostname = url.hostname.toLowerCase();
  const allowed =
    hostname === "api-staging.eliza.app" ||
    (hostname.endsWith(".workers.dev") && hostname.includes("staging"));
  if (!allowed || hostname.includes("prod")) {
    throw new Error(`${label} must identify a staging Worker origin`);
  }
  return url.origin;
}

export function validateStagingWorkerName(value, label) {
  const name = value.trim();
  if (
    !WORKER_PATTERN.test(name) ||
    !name.includes("staging") ||
    name.includes("prod")
  ) {
    throw new Error(`${label} must be a staging-only Worker name`);
  }
  return name;
}

export function parsePlacementAbArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "deploy-sha": { type: "string" },
      "smart-base-url": { type: "string" },
      "control-base-url": { type: "string" },
      "smart-worker": { type: "string" },
      "control-worker": { type: "string" },
      "output-dir": { type: "string" },
      "success-pairs": {
        type: "string",
        default: String(DEFAULT_SUCCESS_PAIRS),
      },
      "max-attempts": {
        type: "string",
        default: String(DEFAULT_MAX_ATTEMPTS),
      },
    },
    strict: true,
    allowPositionals: false,
  });
  const deploySha = values["deploy-sha"]?.trim() ?? "";
  if (!SHA_PATTERN.test(deploySha)) {
    throw new Error("--deploy-sha must be a lowercase 40-character commit");
  }
  const outputDir = values["output-dir"]?.trim();
  if (!outputDir) throw new Error("--output-dir is required");
  const successPairs = boundedInteger(
    values["success-pairs"],
    "success-pairs",
    30,
    100,
  );
  const maxAttempts = boundedInteger(
    values["max-attempts"],
    "max-attempts",
    successPairs,
    150,
  );
  const smartBaseUrl = validateStagingArmUrl(
    values["smart-base-url"] ?? "",
    "--smart-base-url",
  );
  const controlBaseUrl = validateStagingArmUrl(
    values["control-base-url"] ?? "",
    "--control-base-url",
  );
  const smartWorker = validateStagingWorkerName(
    values["smart-worker"] ?? "",
    "--smart-worker",
  );
  const controlWorker = validateStagingWorkerName(
    values["control-worker"] ?? "",
    "--control-worker",
  );
  if (smartBaseUrl === controlBaseUrl || smartWorker === controlWorker) {
    throw new Error("Smart and control arms must be distinct Workers");
  }
  return {
    deploySha,
    smartBaseUrl,
    controlBaseUrl,
    smartWorker,
    controlWorker,
    outputDir: resolve(outputDir),
    successPairs,
    maxAttempts,
  };
}

export async function verifyArmDeployment(
  { arm, baseUrl, deploySha },
  fetchImpl = fetch,
) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/health`, {
      headers: { "user-agent": "eliza-cloud-placement-ab/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new Error(`${arm} health request failed`, { cause });
  }
  if (!response.ok)
    throw new Error(`${arm} health returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.commit !== deploySha || body?.environment !== "staging") {
    throw new Error(`${arm} did not serve the exact staging commit`);
  }
  return {
    arm,
    deploySha,
    environment: "staging",
    placement: boundedToken(response.headers.get("cf-placement"), "absent"),
    colo: boundedToken(response.headers.get("cf-ray")?.split("-").at(-1)),
  };
}

export function sanitizePlacementServiceResult(worker, payload) {
  if (payload?.success !== true) {
    throw new Error(`Cloudflare placement status failed for ${worker}`);
  }
  const script =
    payload.result?.default_environment?.script ?? payload.result?.script;
  const placement = script?.placement;
  return {
    worker,
    mode: boundedToken(placement?.mode ?? script?.placement_mode, "absent"),
    status: boundedToken(
      placement?.status ?? script?.placement_status,
      "absent",
    ),
    lastAnalyzedAt:
      typeof placement?.last_analyzed_at === "string"
        ? placement.last_analyzed_at
        : null,
  };
}

export async function readPlacementStatus(
  { worker, accountId, apiToken },
  fetchImpl = fetch,
) {
  let response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/services/${encodeURIComponent(worker)}`,
      {
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (cause) {
    throw new Error(
      `Cloudflare placement status request failed for ${worker}`,
      {
        cause,
      },
    );
  }
  if (!response.ok) {
    throw new Error(
      `Cloudflare placement status returned HTTP ${response.status} for ${worker}`,
    );
  }
  return sanitizePlacementServiceResult(worker, await response.json());
}

/** Reject a placement window unless its two arms retain their intended modes. */
export function assertExpectedPlacementModes(placements, phase) {
  const [smart, control] = placements;
  if (smart?.mode !== "smart") {
    throw new Error(`${phase} Smart arm is not configured for Smart Placement`);
  }
  if (control?.mode !== "absent") {
    throw new Error(`${phase} control arm must use default placement`);
  }
}

/**
 * Reattests both staging arms before or after a probe window. Health readback
 * binds the observation to the requested SHA, while service metadata verifies
 * the Smart Placement/default-placement comparison did not change mid-run.
 */
export async function verifyPlacementWindow(
  { arms, deploySha, accountId, apiToken, phase },
  fetchImpl = fetch,
) {
  const deployments = await Promise.all(
    arms.map((arm) => verifyArmDeployment({ ...arm, deploySha }, fetchImpl)),
  );
  const placements = await Promise.all(
    arms.map(({ worker }) =>
      readPlacementStatus({ worker, accountId, apiToken }, fetchImpl),
    ),
  );
  assertExpectedPlacementModes(placements, phase);
  return { deployments, placements };
}

export function fingerprintWorkerBindings(worker, payload) {
  if (payload?.success !== true || !Array.isArray(payload.result?.bindings)) {
    throw new Error(`Cloudflare binding readback failed for ${worker}`);
  }
  const bindings = payload.result.bindings
    .map((binding) => ({
      name: boundedToken(binding?.name),
      type: boundedToken(binding?.type),
      namespaceId: boundedToken(binding?.namespace_id, "absent"),
      id: boundedToken(binding?.id, "absent"),
      bucketName: boundedToken(binding?.bucket_name, "absent"),
      className: boundedToken(binding?.class_name, "absent"),
      scriptName: boundedToken(binding?.script_name, "absent"),
      service: boundedToken(binding?.service, "absent"),
      environment: boundedToken(binding?.environment, "absent"),
      entrypoint: boundedToken(binding?.entrypoint, "absent"),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const types = Object.fromEntries(
    [...Map.groupBy(bindings, (binding) => binding.type).entries()]
      .map(([type, group]) => [type, group.length])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    worker,
    bindingCount: bindings.length,
    types,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(bindings))
      .digest("hex"),
  };
}

export async function readWorkerBindingContract(
  { worker, accountId, apiToken },
  fetchImpl = fetch,
) {
  let response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(worker)}/settings`,
      {
        headers: { authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (cause) {
    throw new Error(`Cloudflare binding readback failed for ${worker}`, {
      cause,
    });
  }
  if (!response.ok) {
    throw new Error(
      `Cloudflare binding readback returned HTTP ${response.status} for ${worker}`,
    );
  }
  return fingerprintWorkerBindings(worker, await response.json());
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const value =
    lower === upper
      ? sorted[lower]
      : sorted[lower] * (1 - (index - lower)) + sorted[upper] * (index - lower);
  return Math.round(value * 100) / 100;
}

function metric(records, selector) {
  const values = records.map(selector).filter(Number.isFinite);
  return {
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
  };
}

export function summarizePlacementRecords(records) {
  const groups = Map.groupBy(
    records.filter((record) => record.phase === "warm"),
    (record) => `${record.arm}:${record.headers?.["cf-placement"] ?? "absent"}`,
  );
  return [...groups.entries()]
    .map(([key, group]) => {
      const successful = group.filter((record) => record.ok === true);
      const [arm, placement] = key.split(":", 2);
      return {
        arm,
        placement,
        attempts: group.length,
        successes: successful.length,
        failures: group.length - successful.length,
        responseHeadersMs: metric(
          successful,
          (record) => record.responseHeadersMs,
        ),
        firstTokenMs: metric(successful, (record) => record.firstTokenMs),
        totalMs: metric(successful, (record) => record.totalMs),
        preforwardTotalMs: metric(
          successful,
          (record) => record.preforward?.total,
        ),
        preforwardAuthMs: metric(
          successful,
          (record) => record.preforward?.auth,
        ),
        preforwardMiddleMs: metric(
          successful,
          (record) => record.preforward?.mid,
        ),
        preforwardReserveMs: metric(
          successful,
          (record) => record.preforward?.reserve,
        ),
        preforwardSetupMs: metric(
          successful,
          (record) => record.preforward?.setup,
        ),
        upstreamHeadersMs: metric(
          successful,
          (record) => record.serverTiming?.upstream_headers,
        ),
      };
    })
    .sort((left, right) => left.arm.localeCompare(right.arm));
}

function requiredSecret(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Required protected secret is missing: ${name}`);
  return value;
}

async function sleep(durationMs) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
}

async function runProbePair({ options, apiKey, phase, sequence, fetchImpl }) {
  const proof = `placement-proof-${randomUUID()}`;
  const pairId = randomUUID();
  const probeCase = parseProbeCase("gemma-4-31b@omit@512");
  return await Promise.all(
    [
      ["smart", options.smartBaseUrl],
      ["control", options.controlBaseUrl],
    ].map(async ([arm, baseUrl]) =>
      probeOpenAi({
        target: arm,
        probeCase,
        baseUrl,
        apiKey,
        proof,
        timeoutMs: 30_000,
        sequence,
        promptCacheKey: `placement-ab-${options.deploySha}`,
        metadata: { arm, phase, pairId, deploySha: options.deploySha },
        fetchImpl,
      }),
    ),
  );
}

export async function runPlacementAb(
  options,
  { env = process.env, fetchImpl = fetch } = {},
) {
  const apiKey = requiredSecret(env, "ELIZAOS_CLOUD_API_KEY");
  const apiToken = requiredSecret(env, "CLOUDFLARE_API_TOKEN");
  const accountId = requiredSecret(env, "CLOUDFLARE_ACCOUNT_ID");
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });

  const arms = [
    {
      arm: "smart",
      baseUrl: options.smartBaseUrl,
      worker: options.smartWorker,
    },
    {
      arm: "control",
      baseUrl: options.controlBaseUrl,
      worker: options.controlWorker,
    },
  ];
  const { deployments, placements: placementBefore } =
    await verifyPlacementWindow(
      {
        arms,
        deploySha: options.deploySha,
        accountId,
        apiToken,
        phase: "Pre-window",
      },
      fetchImpl,
    );
  const bindingContracts = await Promise.all(
    arms.map(({ worker }) =>
      readWorkerBindingContract({ worker, accountId, apiToken }, fetchImpl),
    ),
  );
  if (bindingContracts[0]?.fingerprint !== bindingContracts[1]?.fingerprint) {
    throw new Error("Placement arms do not have identical binding topology");
  }

  const records = [];
  records.push(
    ...(await runProbePair({
      options,
      apiKey,
      phase: "cold",
      sequence: 1,
      fetchImpl,
    })),
  );
  let successfulPairs = 0;
  for (
    let attempt = 1;
    attempt <= options.maxAttempts && successfulPairs < options.successPairs;
    attempt += 1
  ) {
    await sleep(250);
    const pair = await runProbePair({
      options,
      apiKey,
      phase: "warm",
      sequence: attempt,
      fetchImpl,
    });
    records.push(...pair);
    if (pair.every((record) => record.ok && record.proofMatched))
      successfulPairs++;
  }
  await sleep(500);
  records.push(
    ...(await runProbePair({
      options,
      apiKey,
      phase: "post-idle",
      sequence: 1,
      fetchImpl,
    })),
  );
  const { deployments: deploymentsAfter, placements: placementAfter } =
    await verifyPlacementWindow(
      {
        arms,
        deploySha: options.deploySha,
        accountId,
        apiToken,
        phase: "Post-window",
      },
      fetchImpl,
    );

  await writeFile(
    resolve(options.outputDir, "placement-ab.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600, flag: "wx" },
  );
  const summary = {
    kind: "cloud_placement_ab",
    deploySha: options.deploySha,
    successfulPairs,
    requiredSuccessfulPairs: options.successPairs,
    deployments,
    deploymentsAfter,
    bindingContracts,
    placementBefore,
    placementAfter,
    warm: summarizePlacementRecords(records),
  };
  await writeFile(
    resolve(options.outputDir, "summary.json"),
    `${JSON.stringify(summary)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  if (successfulPairs < options.successPairs) {
    throw new Error(
      "Placement A/B did not collect enough successful warm pairs",
    );
  }
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runPlacementAb(parsePlacementAbArgs(process.argv.slice(2))).catch((error) => {
    // error-policy:J1 workflow boundary emits only bounded categories and
    // never prints response bodies, prompts, generated text, or credentials.
    process.stderr.write(
      `[cloud-placement-ab] ${error instanceof Error ? error.message : "unknown failure"}\n`,
    );
    process.exitCode = 1;
  });
}
