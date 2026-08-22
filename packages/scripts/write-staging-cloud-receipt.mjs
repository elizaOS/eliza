/**
 * Writes the durable, secret-free receipt for the staging Cloud live lane.
 *
 * The schema is deliberately closed: callers provide only GitHub identity,
 * timing, and outcome values, while Cloud annotations are fixed here. Bearer
 * credentials, model replies, and raw HTTP bodies can never enter the file.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseDeployedRendererProof } from "../cloud/scripts/pages-deployment-authority.mjs";

const REQUIRED_ARGUMENTS = new Set([
  "output",
  "source-sha",
  "run-id",
  "run-attempt",
  "outcome",
  "started-ms",
  "completed-ms",
  "first-turn-latency-ms",
  "continuity-evidence",
]);
const OPTIONAL_ARGUMENTS = new Set(["deployed-proof-file"]);

function fail(message) {
  throw new Error(`[staging-cloud-receipt] ${message}`);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      fail("arguments must be --name value pairs");
    }
    const name = flag.slice(2);
    if (!REQUIRED_ARGUMENTS.has(name) && !OPTIONAL_ARGUMENTS.has(name)) {
      fail(`unsupported argument: ${flag}`);
    }
    if (values.has(name)) {
      fail(`duplicate argument: ${flag}`);
    }
    values.set(name, value);
  }

  for (const name of REQUIRED_ARGUMENTS) {
    if (!values.has(name)) {
      fail(`missing argument: --${name}`);
    }
  }
  return values;
}

function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value)) {
    fail(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail(`${name} exceeds the safe integer range`);
  }
  return parsed;
}

function timestamp(value, name) {
  if (!/^\d{13}$/.test(value)) {
    fail(`${name} must be a 13-digit Unix timestamp in milliseconds`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail(`${name} exceeds the safe integer range`);
  }
  return parsed;
}

export function createStagingCloudReceipt(argv) {
  const values = parseArguments(argv);
  const sourceSha = values.get("source-sha");
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    fail("source-sha must be an exact lowercase 40-hex commit SHA");
  }

  const outcome = values.get("outcome");
  if (outcome !== "success" && outcome !== "failure") {
    fail("outcome must be success or failure");
  }

  const startedAtMs = timestamp(values.get("started-ms"), "started-ms");
  const completedAtMs = timestamp(values.get("completed-ms"), "completed-ms");
  if (completedAtMs < startedAtMs) {
    fail("completed-ms must not precede started-ms");
  }

  const latencyValue = values.get("first-turn-latency-ms");
  let firstTurnLatencyMs = null;
  if (outcome === "success") {
    if (latencyValue === "unavailable") {
      fail("successful outcome requires first-turn-latency-ms");
    }
    firstTurnLatencyMs = positiveInteger(latencyValue, "first-turn-latency-ms");
    if (firstTurnLatencyMs > completedAtMs - startedAtMs) {
      fail("first-turn-latency-ms must not exceed the whole lane duration");
    }
  } else if (latencyValue !== "unavailable") {
    fail("failed outcome must mark first-turn-latency-ms unavailable");
  }

  const continuityValue = values.get("continuity-evidence");
  const continuityVerified = continuityValue === "verified";
  if (outcome === "success" && !continuityVerified) {
    fail("successful outcome requires verified continuity-evidence");
  }
  if (outcome === "failure" && continuityValue !== "unavailable") {
    fail("failed outcome must mark continuity-evidence unavailable");
  }

  const receipt = {
    schemaVersion: 2,
    lane: "app-live-e2e-cloud-staging",
    sourceSha,
    workflow: {
      runId: positiveInteger(values.get("run-id"), "run-id"),
      runAttempt: positiveInteger(values.get("run-attempt"), "run-attempt"),
    },
    result: {
      outcome,
      startedAtMs,
      completedAtMs,
      durationMs: completedAtMs - startedAtMs,
    },
    measurements: {
      firstTurnLatencyDefinition:
        "composer-send-click-to-settled-valid-assistant-turn: starts immediately before the UI send click; ends after the same fresh non-empty assistant row settles and passes the liveness contract; not first-token latency",
      firstTurnLatencyMs,
    },
    continuity: {
      verified: continuityVerified,
      challengeTurnCount: continuityVerified ? 1 : null,
      noAdditionalChatSendAfterChallenge: continuityVerified ? true : null,
      personalIdentityEndpointPassed: continuityVerified ? true : null,
      reloadHistoryPassed: continuityVerified ? true : null,
      freshContextHistoryPassed: continuityVerified ? true : null,
      personalIdentityReused: continuityVerified ? true : null,
      runtimeBindingReused: continuityVerified ? true : null,
      apiBaseReused: continuityVerified ? true : null,
      forbiddenAgentMutationCount: continuityVerified ? 0 : null,
    },
    cleanup: {
      cleanupDisposition: continuityVerified
        ? "no-test-owned-agent"
        : "unavailable",
      conversationHistoryDisposition: continuityVerified
        ? "preserved"
        : "unavailable",
    },
    annotations: {
      cloudApiOrigin: "https://api-staging.eliza.app",
      cloudEnvironment: "staging",
      rendererSource: "local-checkout",
      deployedRendererTested: false,
      loginPersonalIdentityChatPassed: outcome === "success",
      historyContinuityPassed: continuityVerified,
    },
  };

  const deployedProofPath = values.get("deployed-proof-file");
  if (!deployedProofPath) return receipt;
  if (outcome !== "success") {
    fail("deployed proof requires a successful outcome");
  }
  const deployedProofRaw = readFileSync(resolve(deployedProofPath), "utf8");
  let deployedProofValue;
  try {
    deployedProofValue = JSON.parse(deployedProofRaw);
  } catch {
    // error-policy:J3 a malformed proof file cannot become deployed evidence.
    fail("deployed-proof-file must contain valid JSON");
  }
  const deployedProof = parseDeployedRendererProof(deployedProofValue);
  const runId = positiveInteger(values.get("run-id"), "run-id");
  const runAttempt = positiveInteger(values.get("run-attempt"), "run-attempt");
  if (
    deployedProof.sourceSha !== sourceSha ||
    deployedProof.workflow.runId !== runId ||
    deployedProof.workflow.runAttempt !== runAttempt
  ) {
    fail("deployed proof does not match the receipt source/run identity");
  }
  if (deployedProof.latency.firstTurnLatencyMs !== firstTurnLatencyMs) {
    fail("deployed proof latency does not match the receipt measurement");
  }

  return {
    ...receipt,
    schemaVersion: 3,
    deployment: {
      proofSha256: createHash("sha256").update(deployedProofRaw).digest("hex"),
      cloudflarePagesAlias: deployedProof.authority.aliasUrl,
      deploymentUrl: deployedProof.authority.deploymentUrl,
      deploymentIdSha256: deployedProof.authority.deploymentIdSha256,
      rendererBuildId: deployedProof.preflight.renderer.buildId,
      rendererManifestCommit: deployedProof.sourceSha,
      publicPreflightPassed: true,
      remoteBrowserSmokePassed: true,
      publicPostflightPassed: true,
    },
    annotations: {
      ...receipt.annotations,
      rendererSource: "cloudflare-pages-alias",
      deployedRendererTested: true,
      cloudflarePagesAlias: deployedProof.authority.aliasUrl,
    },
  };
}

export async function writeStagingCloudReceipt(argv) {
  const values = parseArguments(argv);
  const outputPath = resolve(values.get("output"));
  const receipt = createStagingCloudReceipt(argv);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return outputPath;
}

if (import.meta.main) {
  try {
    const outputPath = await writeStagingCloudReceipt(process.argv.slice(2));
    process.stdout.write(`${outputPath}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
