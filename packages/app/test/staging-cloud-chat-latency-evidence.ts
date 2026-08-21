/**
 * Produces and validates the staging Cloud chat-latency handoff artifact.
 * Its closed schema carries one duration and fixed labels only: no prompt,
 * assistant text, credential, account, agent, conversation, or provider ID can
 * enter the workflow artifact consumed by the staging receipt writer.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SCHEMA_VERSION = 1;
const LANE = "app-live-e2e-cloud-staging";
const METRIC = "first-turn-latency";
const DEFINITION =
  "composer-send-click-to-settled-valid-assistant-turn: starts immediately before the UI send click; ends after the same fresh non-empty assistant row settles and passes the liveness contract; not first-token latency";

export interface StagingCloudChatLatencyEvidence {
  schemaVersion: 1;
  lane: typeof LANE;
  metric: typeof METRIC;
  definition: typeof DEFINITION;
  firstTurnLatencyMs: number;
}

function fail(message: string): never {
  throw new Error(`[staging-cloud-chat-latency] ${message}`);
}

function positiveDuration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail("value must be a positive safe integer duration in milliseconds");
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

export function createStagingCloudChatLatencyEvidence(
  firstTurnLatencyMs: number,
): StagingCloudChatLatencyEvidence {
  return {
    schemaVersion: SCHEMA_VERSION,
    lane: LANE,
    metric: METRIC,
    definition: DEFINITION,
    firstTurnLatencyMs: positiveDuration(firstTurnLatencyMs),
  };
}

export function parseStagingCloudChatLatencyEvidence(
  value: unknown,
): StagingCloudChatLatencyEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "definition",
      "firstTurnLatencyMs",
      "lane",
      "metric",
      "schemaVersion",
    ])
  ) {
    fail("artifact must use the exact closed schema");
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    fail(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (
    value.lane !== LANE ||
    value.metric !== METRIC ||
    value.definition !== DEFINITION
  ) {
    fail("artifact labels do not match the staging chat latency contract");
  }
  return createStagingCloudChatLatencyEvidence(
    positiveDuration(value.firstTurnLatencyMs),
  );
}

export async function writeStagingCloudChatLatencyEvidence(
  outputPath: string,
  firstTurnLatencyMs: number,
): Promise<string> {
  if (!outputPath.trim()) fail("output path must not be empty");
  const resolvedPath = resolve(outputPath);
  const evidence = createStagingCloudChatLatencyEvidence(firstTurnLatencyMs);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return resolvedPath;
}

export async function readStagingCloudChatLatencyEvidence(
  inputPath: string,
): Promise<StagingCloudChatLatencyEvidence> {
  if (!inputPath.trim()) fail("input path must not be empty");
  const raw = await readFile(resolve(inputPath), "utf8");
  return parseStagingCloudChatLatencyEvidence(JSON.parse(raw) as unknown);
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) {
      fail("usage: bun staging-cloud-chat-latency-evidence.ts <artifact.json>");
    }
    const evidence = await readStagingCloudChatLatencyEvidence(process.argv[2]);
    process.stdout.write(String(evidence.firstTurnLatencyMs));
  } catch (error) {
    // error-policy:J1 the CLI boundary reports invalid or unreadable evidence
    // and exits non-zero so a successful smoke cannot publish a receipt without
    // its independently measured latency.
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
