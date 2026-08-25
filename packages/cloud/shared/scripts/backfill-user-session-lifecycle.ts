/**
 * Dry-runs or applies bounded user-session telemetry lifecycle backfill batches.
 * Output is aggregate JSON only; this operator never prints row or identity data.
 */

import { closeDatabaseConnectionsForTests } from "../src/db/client";
import { userSessionsRepository } from "../src/db/repositories/user-sessions";

type Environment = "staging" | "production";

interface Options {
  apply: boolean;
  environment: Environment;
  batchSize: number;
  maxBatches: number;
  stagingProof?: string;
}

function readValue(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function boundedInteger(raw: string | undefined, fallback: number, maximum: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`expected an integer from 1 through ${maximum}, received ${raw}`);
  }
  return value;
}

function parseUserSessionBackfillOptions(argv: string[]): Options {
  const environment = readValue(argv, "--environment");
  if (environment !== "staging" && environment !== "production") {
    throw new Error("--environment must be staging or production");
  }
  const apply = argv.includes("--apply");
  const stagingProof = readValue(argv, "--staging-proof");
  if (apply && environment === "production" && !stagingProof) {
    throw new Error("production apply requires --staging-proof=<redacted run URL or receipt>");
  }
  return {
    apply,
    environment,
    batchSize: boundedInteger(readValue(argv, "--batch-size"), 500, 1_000),
    maxBatches: boundedInteger(readValue(argv, "--max-batches"), 1, 100),
    ...(stagingProof ? { stagingProof } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseUserSessionBackfillOptions(process.argv.slice(2));
  const before = await userSessionsRepository.previewLifecycleBackfill();
  const batches: Array<{ updated: number; active: number; ended: number }> = [];

  if (options.apply) {
    for (let batch = 0; batch < options.maxBatches; batch++) {
      const result = await userSessionsRepository.applyLifecycleBackfillBatch(options.batchSize);
      batches.push(result);
      if (result.updated < options.batchSize) break;
    }
  }

  const after = options.apply ? await userSessionsRepository.previewLifecycleBackfill() : before;
  process.stdout.write(
    `${JSON.stringify({
      mode: options.apply ? "apply" : "dry-run",
      environment: options.environment,
      batchSize: options.batchSize,
      maxBatches: options.maxBatches,
      before,
      batches,
      after,
    })}\n`,
  );
}

try {
  await main();
} catch (error) {
  // error-policy:J1 CLI is the operator boundary and exits non-zero with no row data.
  process.stderr.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await closeDatabaseConnectionsForTests();
}
