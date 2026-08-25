#!/usr/bin/env bun
/** Validates complete, independently judged group-chat scenario evidence. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ValidationOptions {
  report: string;
  artifactsDir: string;
  scenarioDir: string;
  provider: string;
}

interface ScenarioRecord {
  id: string;
  status: "passed" | "failed";
  judgeSelfGraded: boolean;
}

interface AggregateReport {
  providerName: string;
  totals: { passed: number; failed: number; skipped: number; total: number };
  scenarios: ScenarioRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    throw new Error(
      `group-chat report totals.${key} must be a non-negative integer`,
    );
  }
  return value;
}

function parseScenario(value: unknown): ScenarioRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0
  ) {
    throw new Error("group-chat report contains a scenario without an id");
  }
  if (value.status !== "passed" && value.status !== "failed") {
    throw new Error(
      `group-chat scenario ${value.id} has status ${String(value.status)}`,
    );
  }
  return {
    id: value.id,
    status: value.status,
    judgeSelfGraded: value.judgeSelfGraded === true,
  };
}

function parseAggregate(value: unknown): AggregateReport {
  if (
    !isRecord(value) ||
    typeof value.providerName !== "string" ||
    !isRecord(value.totals) ||
    !Array.isArray(value.scenarios)
  ) {
    throw new Error("group-chat aggregate report has an invalid envelope");
  }
  return {
    providerName: value.providerName,
    totals: {
      passed: readInteger(value.totals, "passed"),
      failed: readInteger(value.totals, "failed"),
      skipped: readInteger(value.totals, "skipped"),
      total: readInteger(value.totals, "total"),
    },
    scenarios: value.scenarios.map(parseScenario),
  };
}

function scenarioFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return scenarioFiles(target);
    return entry.isFile() && entry.name.endsWith(".scenario.ts")
      ? [target]
      : [];
  });
}

function artifactReports(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const report = path.join(directory, entry.name, "report.json");
    return fs.existsSync(report) ? [report] : [];
  });
}

export function validateGroupChatEvalReport(options: ValidationOptions): {
  provider: string;
  total: number;
  passed: number;
  failed: number;
} {
  const aggregate = parseAggregate(
    JSON.parse(fs.readFileSync(options.report, "utf8")),
  );
  const expectedTotal = scenarioFiles(options.scenarioDir).length;
  const retainedReports = artifactReports(options.artifactsDir);
  const ids = new Set(aggregate.scenarios.map(({ id }) => id));
  const summedTotal = aggregate.totals.passed + aggregate.totals.failed;

  if (expectedTotal === 0)
    throw new Error("group-chat scenario directory is empty");
  if (aggregate.providerName !== options.provider) {
    throw new Error(
      `group-chat acting provider mismatch: expected ${options.provider}, got ${aggregate.providerName}`,
    );
  }
  if (
    aggregate.totals.total !== expectedTotal ||
    aggregate.scenarios.length !== expectedTotal ||
    retainedReports.length !== expectedTotal ||
    ids.size !== expectedTotal ||
    aggregate.totals.skipped !== 0 ||
    summedTotal !== expectedTotal
  ) {
    throw new Error(
      `group-chat evidence is incomplete: expected=${expectedTotal} total=${aggregate.totals.total} scenarios=${aggregate.scenarios.length} retained=${retainedReports.length} unique=${ids.size} skipped=${aggregate.totals.skipped}`,
    );
  }
  const selfGraded = aggregate.scenarios.filter(
    ({ judgeSelfGraded }) => judgeSelfGraded,
  );
  if (selfGraded.length > 0) {
    throw new Error(
      `group-chat evidence contains ${selfGraded.length} self-graded scenario(s)`,
    );
  }
  return {
    provider: aggregate.providerName,
    total: expectedTotal,
    passed: aggregate.totals.passed,
    failed: aggregate.totals.failed,
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const report = option("report");
  const artifactsDir = option("artifacts-dir");
  const scenarioDir = option("scenario-dir");
  const provider = option("provider");
  if (!report || !artifactsDir || !scenarioDir || !provider) {
    throw new Error(
      "usage: validate-group-chat-eval-report --report <json> --artifacts-dir <dir> --scenario-dir <dir> --provider <name>",
    );
  }
  process.stdout.write(
    `${JSON.stringify(validateGroupChatEvalReport({ report, artifactsDir, scenarioDir, provider }))}\n`,
  );
}
