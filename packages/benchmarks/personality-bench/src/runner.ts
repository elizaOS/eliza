#!/usr/bin/env bun
/**
 * @fileoverview CLI: grade an entire run directory and emit aggregate
 * report.md + report.json. Walks `--run-dir` for `*.json` files whose payload
 * is either a `PersonalityScenario` or an object with `{ scenario, trajectory }`.
 *
 * Usage:
 *   bun run src/runner.ts --run-dir <path> --output report.md
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { gradeScenario } from "./judge/index.ts";
import type {
  BatchReport,
  Bucket,
  CalibrationCase,
  PersonalityScenario,
  PersonalityVerdict,
  Verdict,
} from "./types.ts";

const BUCKETS: Bucket[] = [
  "shut_up",
  "hold_style",
  "note_trait_unrelated",
  "escalation",
  "scope_global_vs_user",
];

interface CliArgs {
  runDir: string;
  outputMd: string;
  outputJson: string;
  agent: string | null;
  calibration: boolean;
  calibrationDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  let runDir = "";
  let outputMd = "report.md";
  let outputJson = "report.json";
  let agent: string | null = null;
  let calibration = false;
  let calibrationDir = path.join("tests", "calibration");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run-dir") runDir = argv[++i] ?? "";
    else if (arg === "--output") outputMd = argv[++i] ?? "report.md";
    else if (arg === "--output-json") outputJson = argv[++i] ?? "report.json";
    else if (arg === "--agent") agent = argv[++i] ?? null;
    else if (arg === "--calibration") calibration = true;
    else if (arg === "--calibration-dir")
      calibrationDir = argv[++i] ?? calibrationDir;
  }
  if (!runDir && !calibration) {
    console.error("error: --run-dir is required");
    process.exit(1);
  }
  return { runDir, outputMd, outputJson, agent, calibration, calibrationDir };
}

export async function loadScenarios(
  runDir: string,
): Promise<PersonalityScenario[]> {
  const entries = await fs.readdir(runDir, { withFileTypes: true });
  const scenarios: PersonalityScenario[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(runDir, entry.name);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as
      | PersonalityScenario
      | { scenarios: PersonalityScenario[] }
      | {
          scenario?: PersonalityScenario;
          trajectory?: PersonalityScenario["trajectory"];
          agent?: string;
        };
    if (
      Array.isArray((parsed as { scenarios?: PersonalityScenario[] }).scenarios)
    ) {
      scenarios.push(
        ...(parsed as { scenarios: PersonalityScenario[] }).scenarios,
      );
    } else if (
      (parsed as { scenario?: PersonalityScenario }).scenario?.id &&
      (parsed as { scenario?: PersonalityScenario }).scenario?.bucket
    ) {
      const wrapped = parsed as {
        scenario: PersonalityScenario;
        trajectory?: PersonalityScenario["trajectory"];
        agent?: string;
      };
      scenarios.push({
        ...wrapped.scenario,
        trajectory: wrapped.trajectory ?? wrapped.scenario.trajectory ?? [],
        agent: wrapped.agent ?? wrapped.scenario.agent,
      });
    } else if (
      (parsed as PersonalityScenario).id &&
      (parsed as PersonalityScenario).bucket
    ) {
      scenarios.push(parsed as PersonalityScenario);
    }
  }
  return scenarios;
}

async function loadJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
    .map((line) => JSON.parse(line) as T);
}

async function loadCalibrationCases(
  calibrationDir: string,
): Promise<CalibrationCase[]> {
  const root = path.resolve(calibrationDir);
  const cases: CalibrationCase[] = [];
  for (const filename of ["hand-graded.jsonl", "adversarial.jsonl"]) {
    const filePath = path.join(root, filename);
    cases.push(...(await loadJsonl<CalibrationCase>(filePath)));
  }
  return cases;
}

function calibrationToScenario(
  c: CalibrationCase,
  agent: string | null,
): PersonalityScenario {
  return {
    id: c.scenario_id,
    bucket: c.bucket,
    personalityExpect: c.personalityExpect,
    trajectory: c.trajectory,
    agent: agent ?? undefined,
  };
}

function emptyBucketMatrix(): Record<
  Bucket,
  { pass: number; fail: number; needsReview: number }
> {
  return {
    shut_up: { pass: 0, fail: 0, needsReview: 0 },
    hold_style: { pass: 0, fail: 0, needsReview: 0 },
    note_trait_unrelated: { pass: 0, fail: 0, needsReview: 0 },
    escalation: { pass: 0, fail: 0, needsReview: 0 },
    scope_global_vs_user: { pass: 0, fail: 0, needsReview: 0 },
  };
}

function tallyInto(
  bucket: Bucket,
  verdict: "PASS" | "FAIL" | "NEEDS_REVIEW",
  matrix: ReturnType<typeof emptyBucketMatrix>,
): void {
  if (verdict === "PASS") matrix[bucket].pass += 1;
  else if (verdict === "FAIL") matrix[bucket].fail += 1;
  else matrix[bucket].needsReview += 1;
}

function renderMatrix(
  matrix: Record<Bucket, { pass: number; fail: number; needsReview: number }>,
): string {
  const lines = [
    "| bucket | PASS | FAIL | NEEDS_REVIEW |",
    "| --- | --- | --- | --- |",
  ];
  for (const b of BUCKETS) {
    const row = matrix[b];
    lines.push(`| ${b} | ${row.pass} | ${row.fail} | ${row.needsReview} |`);
  }
  return lines.join("\n");
}

function renderReport(report: BatchReport): string {
  const lines: string[] = [];
  lines.push(`# Personality bench report`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push(`Scenarios: ${report.totals.scenarios}`);
  lines.push(
    `Pass: ${report.totals.pass} · Fail: ${report.totals.fail} · NeedsReview: ${report.totals.needsReview}`,
  );
  lines.push("");
  lines.push("## Per-bucket matrix");
  lines.push("");
  lines.push(renderMatrix(report.perBucket));
  lines.push("");
  for (const [agent, matrix] of Object.entries(report.perAgent)) {
    lines.push(`## Per-bucket matrix — agent: ${agent}`);
    lines.push("");
    lines.push(renderMatrix(matrix));
    lines.push("");
  }
  lines.push("## Per-scenario verdicts");
  lines.push("");
  for (const v of report.verdicts) {
    lines.push(
      `- \`${v.scenarioId}\` [${v.bucket}] **${v.verdict}** — ${v.reason}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function scoreCalibration(
  cases: CalibrationCase[],
  verdicts: PersonalityVerdict[],
): {
  total: number;
  agreed: number;
  disagreed: number;
  needsReview: number;
  falsePositive: number;
  falseNegative: number;
  agreementRate: number;
  falsePositiveRate: number;
  reviewRate: number;
  score: number;
  mismatches: Array<{
    id: string;
    expected: Verdict;
    actual: Verdict;
    reason: string;
  }>;
} {
  let agreed = 0;
  let disagreed = 0;
  let needsReview = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  const mismatches: Array<{
    id: string;
    expected: Verdict;
    actual: Verdict;
    reason: string;
  }> = [];

  for (let i = 0; i < cases.length; i++) {
    const expected = cases[i]?.ground_truth;
    const actual = verdicts[i]?.verdict;
    if (!expected || !actual) continue;
    if (actual === expected) {
      agreed += 1;
      if (actual === "NEEDS_REVIEW") needsReview += 1;
      continue;
    }
    if (actual === "NEEDS_REVIEW") {
      needsReview += 1;
    } else {
      disagreed += 1;
      if (actual === "PASS" && expected === "FAIL") falsePositive += 1;
      if (actual === "FAIL" && expected === "PASS") falseNegative += 1;
    }
    mismatches.push({
      id: cases[i]?.scenario_id ?? `case-${i}`,
      expected,
      actual,
      reason: verdicts[i]?.reason ?? "",
    });
  }

  const total = cases.length;
  const decided = agreed + disagreed;
  const agreementRate = decided === 0 ? 0 : agreed / decided;
  const falsePositiveRate = total === 0 ? 0 : falsePositive / total;
  const reviewRate = total === 0 ? 0 : needsReview / total;
  return {
    total,
    agreed,
    disagreed,
    needsReview,
    falsePositive,
    falseNegative,
    agreementRate,
    falsePositiveRate,
    reviewRate,
    score: agreementRate,
    mismatches,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const calibrationCases = args.calibration
    ? await loadCalibrationCases(args.calibrationDir)
    : [];
  const scenarios = args.calibration
    ? calibrationCases.map((c) => calibrationToScenario(c, args.agent))
    : await loadScenarios(args.runDir);
  if (args.agent) {
    for (const s of scenarios) s.agent = s.agent ?? args.agent;
  }

  const verdicts: PersonalityVerdict[] = [];
  for (const scenario of scenarios) {
    const verdict = await gradeScenario(scenario);
    verdicts.push(verdict);
  }

  const perBucket = emptyBucketMatrix();
  const perAgent: BatchReport["perAgent"] = {};
  const totals = { pass: 0, fail: 0, needsReview: 0 };

  for (let i = 0; i < verdicts.length; i++) {
    const v = verdicts[i];
    if (!v) continue;
    const s = scenarios[i];
    if (!s) continue;
    tallyInto(v.bucket, v.verdict, perBucket);
    if (v.verdict === "PASS") totals.pass += 1;
    else if (v.verdict === "FAIL") totals.fail += 1;
    else totals.needsReview += 1;
    const agent = s.agent ?? "unknown";
    if (!perAgent[agent]) perAgent[agent] = emptyBucketMatrix();
    const agentMatrix = perAgent[agent];
    if (agentMatrix) tallyInto(v.bucket, v.verdict, agentMatrix);
  }

  const report: BatchReport & {
    score?: number;
    calibration?: ReturnType<typeof scoreCalibration>;
  } = {
    schemaVersion: "personality-bench-v1",
    generatedAt: new Date().toISOString(),
    totals: { scenarios: verdicts.length, ...totals },
    perBucket,
    perAgent,
    verdicts,
  };
  if (args.calibration) {
    report.calibration = scoreCalibration(calibrationCases, verdicts);
    report.score = report.calibration.score;
  }

  await fs.writeFile(args.outputMd, renderReport(report), "utf8");
  await fs.writeFile(args.outputJson, JSON.stringify(report, null, 2), "utf8");
  console.log(
    `wrote ${args.outputMd} (${verdicts.length} scenarios) — pass=${totals.pass} fail=${totals.fail} review=${totals.needsReview}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
