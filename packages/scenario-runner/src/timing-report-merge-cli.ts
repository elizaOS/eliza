#!/usr/bin/env bun
/** Merges complete timing-evaluation shard reports into a verified matrix. */
import fs from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { mergeTimingReports } from "./timing-report-merge.ts";

const outputArgument = process.argv
  .slice(2)
  .find((value) => value.startsWith("--output="));
const inputs = process.argv
  .slice(2)
  .filter((value) => !value.startsWith("--output="));
if (!outputArgument || inputs.length === 0) {
  throw new ElizaError(
    "usage: timing-report-merge --output=<matrix.json> <shard-report.json>...",
    { code: "TIMING_REPORT_MERGE_CLI_INVALID_ARGUMENT" },
  );
}
const output = path.resolve(outputArgument.slice("--output=".length));
const matrix = mergeTimingReports(inputs);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
process.stdout.write(
  `${JSON.stringify(matrix.cells.map((cell) => ({ dataset: cell.dataset, backend: cell.backend, requestedModel: cell.requestedModel, acceptedRows: cell.acceptedRows, excludedRows: cell.excludedRows, malformedRows: cell.malformedRows, accuracy: cell.metrics.accuracy })))}\nmatrix: ${output}\n`,
);
