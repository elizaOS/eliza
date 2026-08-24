/**
 * Merges complete timing-evaluation shards into auditable model cells. The
 * merger rereads each source JSONL and refuses missing, duplicate, partial, or
 * mixed-configuration coverage instead of extrapolating a baseline.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import {
  isTimingRowSelected,
  summarizeTimingPredictions,
  type TimingDataset,
  type TimingPrediction,
  type TimingReport,
} from "./when2speak-eval.ts";

type TimingReportFragment = Pick<
  TimingReport,
  | "schema"
  | "status"
  | "dataset"
  | "input"
  | "inputSha256"
  | "provider"
  | "requestedModel"
  | "backend"
  | "characterPreset"
  | "selection"
  | "predictions"
  | "exclusions"
  | "failures"
>;

export interface TimingMatrixCell {
  dataset: TimingDataset;
  input: string;
  inputSha256: string;
  provider: string;
  requestedModel: string;
  backend: string;
  characterPreset: TimingReport["characterPreset"];
  shardCount: number;
  sourceReports: string[];
  physicalRows: number;
  acceptedRows: number;
  excludedRows: number;
  malformedRows: number;
  rejectedRows: number;
  metrics: TimingReport["metrics"];
  objectives: TimingReport["objectives"];
  slices: TimingReport["slices"];
}

export interface TimingMatrixReport {
  schema: 1;
  generatedAt: string;
  cells: TimingMatrixCell[];
}

function mergeError(
  code: string,
  message: string,
  context?: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    ...(context === undefined ? {} : { context }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function isDataset(value: unknown): value is TimingDataset {
  return (
    value === "duke-trust-lab/When2Speak" ||
    value === "mookiezi/Discord-Dialogues"
  );
}

function isTimingPrediction(value: unknown): value is TimingPrediction {
  if (value === null || typeof value !== "object") return false;
  return (
    "row" in value &&
    typeof value.row === "number" &&
    Number.isSafeInteger(value.row) &&
    "gold" in value &&
    (value.gold === "SPEAK" || value.gold === "SILENT") &&
    "predicted" in value &&
    (value.predicted === "SPEAK" || value.predicted === "SILENT") &&
    "textuallyReferencesAgent" in value &&
    typeof value.textuallyReferencesAgent === "boolean" &&
    "directlyAddressesAgent" in value &&
    typeof value.directlyAddressesAgent === "boolean" &&
    "speakerCount" in value &&
    Number.isSafeInteger(value.speakerCount) &&
    "contextTurns" in value &&
    Number.isSafeInteger(value.contextTurns)
  );
}

function isTimingFailure(
  value: unknown,
): value is TimingReport["failures"][number] {
  return (
    value !== null &&
    typeof value === "object" &&
    "row" in value &&
    typeof value.row === "number" &&
    Number.isSafeInteger(value.row) &&
    "error" in value &&
    typeof value.error === "string"
  );
}

function isTimingExclusion(
  value: unknown,
): value is TimingReport["exclusions"][number] {
  return (
    value !== null &&
    typeof value === "object" &&
    "row" in value &&
    typeof value.row === "number" &&
    Number.isSafeInteger(value.row) &&
    "reason" in value &&
    typeof value.reason === "string"
  );
}

function isSelection(value: unknown): value is TimingReport["selection"] {
  return (
    value !== null &&
    typeof value === "object" &&
    "shardIndex" in value &&
    typeof value.shardIndex === "number" &&
    Number.isSafeInteger(value.shardIndex) &&
    "shardCount" in value &&
    typeof value.shardCount === "number" &&
    Number.isSafeInteger(value.shardCount) &&
    value.shardCount > 0 &&
    value.shardIndex >= 0 &&
    value.shardIndex < value.shardCount &&
    "startRow" in value &&
    typeof value.startRow === "number" &&
    Number.isSafeInteger(value.startRow) &&
    value.startRow > 0 &&
    "limit" in value &&
    (value.limit === null ||
      (typeof value.limit === "number" &&
        Number.isSafeInteger(value.limit) &&
        value.limit > 0))
  );
}

function parseReport(file: string): TimingReportFragment {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    // error-policy:J2 Report I/O or JSON failures retain the source path.
    throw mergeError(
      "TIMING_REPORT_READ_FAILED",
      "Failed to read timing shard report",
      { file },
      cause,
    );
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !("schema" in value) ||
    value.schema !== 3 ||
    !("status" in value) ||
    (value.status !== "in-progress" && value.status !== "complete") ||
    !("dataset" in value) ||
    !isDataset(value.dataset) ||
    !("input" in value) ||
    typeof value.input !== "string" ||
    !("inputSha256" in value) ||
    typeof value.inputSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.inputSha256) ||
    !("provider" in value) ||
    typeof value.provider !== "string" ||
    !("requestedModel" in value) ||
    typeof value.requestedModel !== "string" ||
    !("backend" in value) ||
    typeof value.backend !== "string" ||
    !("characterPreset" in value) ||
    (value.characterPreset !== "minimal" &&
      value.characterPreset !== "eliza") ||
    !("selection" in value) ||
    !isSelection(value.selection) ||
    !("predictions" in value) ||
    !Array.isArray(value.predictions) ||
    !value.predictions.every(isTimingPrediction) ||
    !("exclusions" in value) ||
    !Array.isArray(value.exclusions) ||
    !value.exclusions.every(isTimingExclusion) ||
    !("failures" in value) ||
    !Array.isArray(value.failures) ||
    !value.failures.every(isTimingFailure)
  ) {
    throw mergeError(
      "TIMING_REPORT_INVALID",
      "Timing shard report has an invalid schema",
      { file },
    );
  }
  return {
    schema: value.schema,
    status: value.status,
    dataset: value.dataset,
    input: value.input,
    inputSha256: value.inputSha256,
    provider: value.provider,
    requestedModel: value.requestedModel,
    backend: value.backend,
    characterPreset: value.characterPreset,
    selection: value.selection,
    predictions: value.predictions,
    exclusions: value.exclusions,
    failures: value.failures,
  };
}

function cellKey(report: TimingReportFragment): string {
  return JSON.stringify([
    report.dataset,
    path.resolve(report.input),
    report.inputSha256,
    report.provider,
    report.requestedModel,
    report.backend,
    report.characterPreset,
    report.selection.shardCount,
  ]);
}

function countPhysicalRows(input: string): number {
  const lines = fs.readFileSync(input, "utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

export function mergeTimingReports(
  files: readonly string[],
): TimingMatrixReport {
  if (files.length === 0)
    throw mergeError(
      "TIMING_REPORTS_EMPTY",
      "At least one timing shard report is required",
    );
  const groups = new Map<
    string,
    Array<{ file: string; report: TimingReportFragment }>
  >();
  for (const inputFile of files) {
    const file = path.resolve(inputFile);
    const report = parseReport(file);
    const entries = groups.get(cellKey(report)) ?? [];
    entries.push({ file, report });
    groups.set(cellKey(report), entries);
  }
  const cells = [...groups.values()].map((entries): TimingMatrixCell => {
    const first = entries[0].report;
    const expectedShards = new Set(
      Array.from({ length: first.selection.shardCount }, (_, index) => index),
    );
    const rows = new Set<number>();
    const predictions: TimingPrediction[] = [];
    let excludedRows = 0;
    let malformedRows = 0;
    for (const { file, report } of entries) {
      if (
        report.status !== "complete" ||
        report.selection.startRow !== 1 ||
        report.selection.limit !== null
      ) {
        throw mergeError(
          "TIMING_REPORT_PARTIAL",
          "Matrix cells require complete, unbounded shards starting at row 1",
          { file, status: report.status, selection: report.selection },
        );
      }
      if (!expectedShards.delete(report.selection.shardIndex)) {
        throw mergeError(
          "TIMING_REPORT_DUPLICATE_SHARD",
          "Timing matrix cell has a duplicate or invalid shard index",
          { file, shardIndex: report.selection.shardIndex },
        );
      }
      for (const prediction of report.predictions) {
        if (!isTimingRowSelected({ row: prediction.row, ...report.selection }))
          throw mergeError(
            "TIMING_REPORT_WRONG_SHARD_ROW",
            "Timing matrix row does not belong to its reported shard",
            { file, row: prediction.row, selection: report.selection },
          );
        if (rows.has(prediction.row))
          throw mergeError(
            "TIMING_REPORT_DUPLICATE_ROW",
            "Timing matrix cell contains a duplicate physical row",
            { file, row: prediction.row },
          );
        rows.add(prediction.row);
        predictions.push(prediction);
      }
      for (const failure of report.failures) {
        if (!isTimingRowSelected({ row: failure.row, ...report.selection }))
          throw mergeError(
            "TIMING_REPORT_WRONG_SHARD_ROW",
            "Timing matrix row does not belong to its reported shard",
            { file, row: failure.row, selection: report.selection },
          );
        if (rows.has(failure.row))
          throw mergeError(
            "TIMING_REPORT_DUPLICATE_ROW",
            "Timing matrix cell contains a duplicate physical row",
            { file, row: failure.row },
          );
        rows.add(failure.row);
        malformedRows += 1;
      }
      for (const exclusion of report.exclusions) {
        if (!isTimingRowSelected({ row: exclusion.row, ...report.selection }))
          throw mergeError(
            "TIMING_REPORT_WRONG_SHARD_ROW",
            "Timing matrix row does not belong to its reported shard",
            { file, row: exclusion.row, selection: report.selection },
          );
        if (rows.has(exclusion.row))
          throw mergeError(
            "TIMING_REPORT_DUPLICATE_ROW",
            "Timing matrix cell contains a duplicate physical row",
            { file, row: exclusion.row },
          );
        rows.add(exclusion.row);
        excludedRows += 1;
      }
    }
    if (expectedShards.size > 0)
      throw mergeError(
        "TIMING_REPORT_MISSING_SHARD",
        "Timing matrix cell is missing required shards",
        { missingShardIndexes: [...expectedShards] },
      );
    const input = path.resolve(first.input);
    const currentInputSha256 = createHash("sha256")
      .update(fs.readFileSync(input))
      .digest("hex");
    if (currentInputSha256 !== first.inputSha256)
      throw mergeError(
        "TIMING_REPORT_INPUT_CHANGED",
        "Timing matrix input content does not match the shard reports",
        { input, expected: first.inputSha256, actual: currentInputSha256 },
      );
    const physicalRows = countPhysicalRows(input);
    const missingRows = Array.from(
      { length: physicalRows },
      (_, index) => index + 1,
    ).filter((row) => !rows.has(row));
    const outOfRangeRows = [...rows].filter(
      (row) => row < 1 || row > physicalRows,
    );
    if (missingRows.length > 0 || outOfRangeRows.length > 0)
      throw mergeError(
        "TIMING_REPORT_INCOMPLETE_COVERAGE",
        "Timing matrix cell does not cover every physical input row",
        { coveredRows: rows.size, physicalRows, missingRows, outOfRangeRows },
      );
    const summary = summarizeTimingPredictions(predictions);
    return {
      dataset: first.dataset,
      input,
      inputSha256: first.inputSha256,
      provider: first.provider,
      requestedModel: first.requestedModel,
      backend: first.backend,
      characterPreset: first.characterPreset,
      shardCount: first.selection.shardCount,
      sourceReports: entries.map(({ file }) => file).sort(),
      physicalRows,
      acceptedRows: predictions.length,
      excludedRows,
      malformedRows,
      rejectedRows: excludedRows + malformedRows,
      ...summary,
    };
  });
  cells.sort((left, right) =>
    [left.dataset, left.backend, left.requestedModel]
      .join("\0")
      .localeCompare(
        [right.dataset, right.backend, right.requestedModel].join("\0"),
      ),
  );
  return { schema: 1, generatedAt: new Date().toISOString(), cells };
}
