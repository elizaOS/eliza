/**
 * Merge one analyzer's result into a subject's `analysis.json`. The runner
 * writes a whole document at once, but the GPU queue worker contributes ONE
 * `gpu`-tier analyzer's result per job, out of band, after the cpu-tier document
 * already exists — so it reads-modify-writes the `results` map keyed by analyzer
 * name. The write is atomic (temp file + rename) because a certification run may
 * read `analysis.json` while the worker is streaming results into it, and a
 * torn read of half-written JSON must never happen.
 *
 * A missing target document is created as a fresh schema-1 doc rather than
 * failing: the worker can legitimately land a gpu result before the cpu pass
 * wrote anything for a newly-captured subject.
 */

import fs from "node:fs";
import path from "node:path";
import type { AnalysisDocument, AnalyzerResult } from "../analyzers/types.ts";
import { EvidenceError } from "../errors.ts";

/** Read an existing analysis document, or start a fresh one for `artifact`. */
function loadOrInit(analysisPath: string, artifact: string): AnalysisDocument {
  let raw: string;
  try {
    raw = fs.readFileSync(analysisPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema: 1, artifact, results: {} };
    }
    // error-policy:J2 context-adding rethrow — an unreadable target (perms, I/O)
    // is a real failure the worker must surface, not silently overwrite.
    throw new EvidenceError(
      `cannot read analysis document at ${analysisPath}`,
      {
        code: "ANALYSIS_MERGE_READ_FAILED",
        cause: error,
        context: { analysisPath },
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // error-policy:J3 corrupt existing document — refuse to merge onto garbage
    // rather than fabricate a fresh doc that would drop prior analyzers' results.
    throw new EvidenceError(
      `analysis document is not valid JSON: ${analysisPath}`,
      { code: "ANALYSIS_MERGE_CORRUPT", cause, context: { analysisPath } },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schema?: unknown }).schema !== 1 ||
    typeof (parsed as { results?: unknown }).results !== "object" ||
    (parsed as { results?: unknown }).results === null
  ) {
    throw new EvidenceError(
      `analysis document has an unexpected shape: ${analysisPath}`,
      { code: "ANALYSIS_MERGE_CORRUPT", context: { analysisPath } },
    );
  }
  return parsed as AnalysisDocument;
}

/**
 * Merge `result` under `analyzerId` into the analysis document at
 * `analysisPath`, creating the document (and its directory) when absent. Returns
 * the written document. The write is temp-file + atomic-rename within the same
 * directory so concurrent readers see either the old or the new document, never
 * a partial one.
 */
export function mergeAnalyzerResult(params: {
  analysisPath: string;
  artifact: string;
  analyzerId: string;
  result: AnalyzerResult;
}): AnalysisDocument {
  const { analysisPath, artifact, analyzerId, result } = params;
  const dir = path.dirname(analysisPath);
  fs.mkdirSync(dir, { recursive: true });

  const document = loadOrInit(analysisPath, artifact);
  document.results[analyzerId] = result;

  const tmp = path.join(
    dir,
    `.${path.basename(analysisPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`);
  fs.renameSync(tmp, analysisPath);
  return document;
}
