#!/usr/bin/env node
/**
 * Union-merges LCOV line records produced by isolated test processes.
 * The CLI can remove its input reports after writing the merged output so a
 * recursive coverage gate sees one record per source file within that lane.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function mergeLcovReports(reportPaths, mergedPath) {
  const files = new Map();
  for (const reportPath of reportPaths) {
    if (!existsSync(reportPath)) continue;
    let current = null;
    for (const line of readFileSync(reportPath, "utf8").split("\n")) {
      if (line.startsWith("SF:")) {
        current = line.slice("SF:".length);
        if (!files.has(current)) files.set(current, new Map());
      } else if (line.startsWith("DA:") && current) {
        const [lineNo, hits] = line.slice("DA:".length).split(",");
        const parsedLine = Number(lineNo);
        const parsedHits = Number(hits);
        if (!Number.isFinite(parsedLine) || !Number.isFinite(parsedHits)) {
          continue;
        }
        const lineHits = files.get(current);
        lineHits.set(
          parsedLine,
          Math.max(lineHits.get(parsedLine) ?? 0, parsedHits),
        );
      } else if (line === "end_of_record") {
        current = null;
      }
    }
  }

  const out = ["TN:"];
  for (const [sourceFile, lineHits] of [...files.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    out.push(`SF:${sourceFile}`);
    const sortedLines = [...lineHits.entries()].sort(
      ([left], [right]) => left - right,
    );
    let hit = 0;
    for (const [lineNo, hits] of sortedLines) {
      out.push(`DA:${lineNo},${hits}`);
      if (hits > 0) hit++;
    }
    out.push(`LF:${sortedLines.length}`, `LH:${hit}`, "end_of_record");
  }
  writeFileSync(mergedPath, `${out.join("\n")}\n`);
}

export function mergeAndRemoveLcovReports(reportPaths, mergedPath) {
  const absoluteMergedPath = path.resolve(mergedPath);
  if (
    reportPaths.some(
      (reportPath) => path.resolve(reportPath) === absoluteMergedPath,
    )
  ) {
    throw new Error("Merged LCOV output must not also be an input report.");
  }

  mergeLcovReports(reportPaths, mergedPath);
  for (const reportPath of reportPaths) {
    if (existsSync(reportPath)) unlinkSync(reportPath);
  }
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  const args = process.argv.slice(2);
  const removeInputs = args[0] === "--remove-inputs";
  const paths = removeInputs ? args.slice(1) : args;
  const [mergedPath, ...reportPaths] = paths;
  if (!mergedPath || reportPaths.length === 0) {
    throw new Error(
      "Usage: merge-lcov-reports.mjs [--remove-inputs] <output> <input...>",
    );
  }

  if (removeInputs) {
    mergeAndRemoveLcovReports(reportPaths, mergedPath);
  } else {
    mergeLcovReports(reportPaths, mergedPath);
  }
}
