/**
 * qa.json writer: serialize an ask result into a bundle artifact placed beside
 * the screenshot it describes. The certify reviewer (#14546) reads these to
 * fold vision answers into verdicts, so the record carries the full audit
 * trail — backend, model, token usage, the questions AND the answers — with the
 * subject screenshot's bundle path recorded so a verdict can point back at the
 * exact pixels. Placement is explicit (`bundlePath`), replacing the subject's
 * `.png` extension with `.qa.json` so `visual/<surface>/<slug>.png` gets a
 * sibling `visual/<surface>/<slug>.qa.json` rather than the default `misc/`
 * family dir.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvidenceBundle } from "../bundle.ts";
import { canonicalJson } from "../canonical.ts";
import { EvidenceError } from "../errors.ts";
import type { ArtifactEntry } from "../schema.ts";
import type { AskResult, VisionQuestion } from "./types.ts";

/** The on-disk qa.json shape. Schema-1; widen additively under a bump. */
export interface QaRecord {
  schema: 1;
  /** Bundle-relative path of the screenshot these answers describe. */
  subject: string;
  backend: string;
  model: string;
  questions: VisionQuestion[];
  answers: AskResult["answers"];
  usage: AskResult["provenance"]["usage"];
  latencyMs: number;
  retries: number;
  cached: boolean;
  dimensions: AskResult["provenance"]["dimensions"];
  createdAt: string;
}

/** Build the qa.json record for a subject screenshot and its ask result. */
export function buildQaRecord(
  subjectBundlePath: string,
  questions: VisionQuestion[],
  result: AskResult,
): QaRecord {
  return {
    schema: 1,
    subject: subjectBundlePath,
    backend: result.provenance.backend,
    model: result.provenance.model,
    questions,
    answers: result.answers,
    usage: result.provenance.usage,
    latencyMs: result.provenance.latencyMs,
    retries: result.provenance.retries,
    cached: result.provenance.cached,
    dimensions: result.provenance.dimensions,
    createdAt: result.provenance.timestamp,
  };
}

/** Replace a `.png`/`.jpg`/… subject path's extension with `.qa.json`. */
function qaPathForSubject(subjectBundlePath: string): string {
  const ext = path.posix.extname(subjectBundlePath);
  const base =
    ext.length > 0
      ? subjectBundlePath.slice(0, -ext.length)
      : subjectBundlePath;
  return `${base}.qa.json`;
}

/**
 * Write a qa.json artifact beside the subject screenshot in the bundle. The
 * record is serialized canonically to a temp file, then added via the bundle's
 * content-addressed `addArtifact` so it is hashed and inventoried like any other
 * artifact. Returns the manifest entry.
 */
export async function writeQaRecord(
  bundle: EvidenceBundle,
  subjectBundlePath: string,
  questions: VisionQuestion[],
  result: AskResult,
): Promise<ArtifactEntry> {
  if (subjectBundlePath.length === 0) {
    throw new EvidenceError("writeQaRecord requires a subject bundle path", {
      code: "VISION_QA_SUBJECT",
    });
  }
  const record = buildQaRecord(subjectBundlePath, questions, result);
  const bundlePath = qaPathForSubject(subjectBundlePath);
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "vision-qa-")),
    "qa.json",
  );
  fs.writeFileSync(tmpFile, `${canonicalJson(record)}\n`, "utf8");
  return bundle.addArtifact(tmpFile, {
    kind: "qa",
    source: "vision-qa",
    producedBy: `vision-qa/${result.provenance.backend}`,
    bundlePath,
  });
}
