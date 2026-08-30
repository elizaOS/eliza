/** Privacy-safe resolver for the protected production Railway Postgres service. */
import { readFile, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  type RailwayTargetEvidence,
  type RailwayTargetExpectation,
  resolveCanonicalRailwayTarget,
} from "./audit-production-railway-database-authority";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;

function requireUuid(value: string | undefined): string {
  if (!value || !UUID.test(value)) throw new Error("protected_target_invalid");
  return value;
}

async function readPrivateJson(path: string): Promise<unknown> {
  const metadata = await stat(path);
  if (
    !metadata.isFile() ||
    metadata.size > MAX_EVIDENCE_BYTES ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("private_evidence_invalid");
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function publish(verdict: "match" | "mismatch" | "unavailable"): void {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, railwayTarget: verdict })}\n`,
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      "status-json": { type: "string" },
      "services-json": { type: "string" },
      "service-id-output": { type: "string" },
    },
  });
  const requiredPath = (name: keyof typeof parsed.values): string => {
    const value = parsed.values[name];
    if (typeof value !== "string" || !value)
      throw new Error("input_path_invalid");
    return value;
  };
  const [status, services] = await Promise.all([
    readPrivateJson(requiredPath("status-json")),
    readPrivateJson(requiredPath("services-json")),
  ]);
  if (!isRecord(status) || !Array.isArray(services)) {
    throw new Error("railway_evidence_invalid");
  }
  const expectation: RailwayTargetExpectation = {
    projectId: requireUuid(process.env.RAILWAY_PROJECT_ID),
    environmentId: requireUuid(process.env.RAILWAY_ENVIRONMENT_ID),
    serviceId: process.env.RAILWAY_POSTGRES_SERVICE_ID?.trim()
      ? requireUuid(process.env.RAILWAY_POSTGRES_SERVICE_ID.trim())
      : undefined,
  };
  const evidence: RailwayTargetEvidence = {
    status,
    services,
    variables: {},
  };
  const resolution = resolveCanonicalRailwayTarget(evidence, expectation);
  publish(resolution.verdict);
  if (resolution.verdict !== "match") {
    process.exitCode = 1;
    return;
  }
  await writeFile(
    requiredPath("service-id-output"),
    `${resolution.serviceId}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

if (import.meta.main) {
  // error-policy:J1 the CLI translates all failures to one allowlisted verdict.
  main().catch(() => {
    publish("unavailable");
    process.exitCode = 1;
  });
}
