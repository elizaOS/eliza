/**
 * Writes the durable, secret-free receipt for the staging Cloud live lane.
 *
 * The schema is deliberately closed: callers provide only GitHub identity,
 * timing, and outcome values, while Cloud annotations are fixed here. Bearer
 * credentials, model replies, and raw HTTP bodies can never enter the file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const EXPECTED_ARGUMENTS = new Set([
  "output",
  "source-sha",
  "run-id",
  "run-attempt",
  "outcome",
  "started-ms",
  "completed-ms",
]);

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
    if (!EXPECTED_ARGUMENTS.has(name)) {
      fail(`unsupported argument: ${flag}`);
    }
    if (values.has(name)) {
      fail(`duplicate argument: ${flag}`);
    }
    values.set(name, value);
  }

  for (const name of EXPECTED_ARGUMENTS) {
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

  return {
    schemaVersion: 1,
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
    annotations: {
      cloudApiOrigin: "https://api-staging.eliza.app",
      cloudEnvironment: "staging",
      rendererSource: "local-checkout",
      deployedRendererTested: false,
      loginProvisionChatPassed: outcome === "success",
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
