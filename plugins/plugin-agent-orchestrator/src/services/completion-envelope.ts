/**
 * CompletionEnvelope — a structured, machine-checkable contract a sub-agent
 * returns when it claims a task is done (#8895, EPIC #8884).
 *
 * Today sub-agents claim completion in free-form prose, so grilling is
 * prompt-based, not contract-based. This module defines the envelope schema,
 * the instruction injected into the spawn prompt, and a pure parser/validator.
 * The completion path runs structural validation BEFORE the LLM judge: a present
 * but malformed envelope is auto-blocked with a targeted re-prompt, while an
 * ABSENT envelope falls back to the existing heuristic path (back-compat).
 */

/** One command the sub-agent ran to verify its work. */
export interface EnvelopeTestResult {
  command: string;
  exitCode: number;
  summary: string;
}

/** Per-criterion self-assessment with the evidence backing it. */
export interface EnvelopeCriterionStatus {
  criterion: string;
  met: boolean;
  evidence: string;
}

/** The structured final report a sub-agent returns on completion. */
export interface CompletionEnvelope {
  diffSummary: string;
  filesChanged: string[];
  /** Real workdir path observed by the orchestrator/verifier, never a requested path guess. */
  realWorkdir?: string;
  /** Disk-verified changed files, populated by truthful completion routing/verifiers. */
  verifiedChangedFiles?: Array<{
    path: string;
    exists: boolean;
    absolutePath?: string;
    sizeBytes?: number;
  }>;
  /** False when any claimed changed file/artifact was missing at completion. */
  artifactsVerified?: boolean;
  missingArtifacts?: string[];
  testResults: EnvelopeTestResult[];
  screenshotPaths: string[];
  trajectoryPath?: string;
  acceptanceCriteriaStatus: EnvelopeCriterionStatus[];
  residualRisks: string[];
}

/**
 * The instruction appended to the spawn prompt. Asks the agent to END its final
 * message with a fenced ```json block matching the schema, in ADDITION to its
 * prose — so weak adapters that ignore it still produce a usable prose
 * completion (the parser treats a missing block as "fall back to heuristic").
 */
export const COMPLETION_ENVELOPE_INSTRUCTION = [
  "When (and only when) you report the task FINISHED, end your final message with a fenced JSON code block matching this schema, after any prose:",
  "```json",
  JSON.stringify(
    {
      diffSummary: "string — one-line summary of what changed",
      filesChanged: ["string — repo-relative paths"],
      realWorkdir:
        "string — optional; the actual working directory used, not the requested path",
      verifiedChangedFiles: [
        {
          path: "string — repo/workdir-relative path",
          exists: true,
          absolutePath: "string — optional absolute path verified on disk",
          sizeBytes: 123,
        },
      ],
      artifactsVerified:
        "boolean — optional; false if any changed file/artifact is missing",
      missingArtifacts: ["string — optional missing claimed files/artifacts"],
      testResults: [
        {
          command: "string",
          exitCode: 0,
          summary: "string — pass/fail detail",
        },
      ],
      screenshotPaths: ["string — absolute paths to any screenshots/artifacts"],
      trajectoryPath: "string — optional path to a trajectory JSONL",
      acceptanceCriteriaStatus: [
        { criterion: "string", met: true, evidence: "string — how you know" },
      ],
      residualRisks: ["string — anything still uncertain"],
    },
    null,
    2,
  ),
  "```",
  "Required keys: diffSummary, filesChanged, testResults, acceptanceCriteriaStatus, residualRisks (use empty arrays where nothing applies). Do NOT emit the block while still working or when blocked — only on genuine completion.",
].join("\n");

/** Result of attempting to read an envelope out of a completion message. */
export type CompletionEnvelopeParse =
  | { present: false }
  | { present: true; ok: true; envelope: CompletionEnvelope }
  | { present: true; ok: false; errors: string[] };

const FENCED_JSON_RE = /```json\s*\n([\s\S]*?)```/gi;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function extractJsonCandidate(text: string): string | null {
  // Prefer the LAST fenced ```json block (the completion envelope comes last).
  let match: RegExpExecArray | null;
  let last: string | null = null;
  FENCED_JSON_RE.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((match = FENCED_JSON_RE.exec(text)) !== null) {
    last = match[1]?.trim() ?? null;
  }
  if (last) return last;
  // No fence: only treat the whole message as JSON when it clearly looks like
  // an object (avoids misreading prose as an absent-envelope fallback).
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return null;
}

/**
 * Pure: detect + validate a CompletionEnvelope in a sub-agent's final message.
 * Absent → `{present:false}` (caller uses the heuristic path). Present but
 * invalid → `{present:true, ok:false, errors}` (caller re-prompts/blocks).
 */
export function parseCompletionEnvelope(text: string): CompletionEnvelopeParse {
  const candidate = extractJsonCandidate(text ?? "");
  if (!candidate) return { present: false };

  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    // error-policy:J3 untrusted sub-agent output; JSON.parse failure → explicit invalid envelope
    // A fenced json block that doesn't parse IS a (broken) attempt — block it.
    return { present: true, ok: false, errors: ["envelope is not valid JSON"] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      present: true,
      ok: false,
      errors: ["envelope is not a JSON object"],
    };
  }
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof o.diffSummary !== "string")
    errors.push("diffSummary must be a string");
  if (!isStringArray(o.filesChanged))
    errors.push("filesChanged must be a string[]");
  if (!isStringArray(o.residualRisks))
    errors.push("residualRisks must be a string[]");
  if (o.realWorkdir !== undefined && typeof o.realWorkdir !== "string")
    errors.push("realWorkdir must be a string");
  if (
    o.artifactsVerified !== undefined &&
    typeof o.artifactsVerified !== "boolean"
  ) {
    errors.push("artifactsVerified must be a boolean");
  }
  if (o.missingArtifacts !== undefined && !isStringArray(o.missingArtifacts)) {
    errors.push("missingArtifacts must be a string[]");
  }
  if (!Array.isArray(o.screenshotPaths)) {
    // optional-ish but must be an array when present; default to [] if missing
    if (o.screenshotPaths !== undefined)
      errors.push("screenshotPaths must be a string[]");
  }

  const verifiedChangedFiles: CompletionEnvelope["verifiedChangedFiles"] = [];
  if (o.verifiedChangedFiles !== undefined) {
    if (!Array.isArray(o.verifiedChangedFiles)) {
      errors.push("verifiedChangedFiles must be an array");
    } else {
      for (const [i, f] of o.verifiedChangedFiles.entries()) {
        const file = f as Record<string, unknown>;
        if (
          !file ||
          typeof file.path !== "string" ||
          typeof file.exists !== "boolean"
        ) {
          errors.push(`verifiedChangedFiles[${i}] must be {path, exists}`);
        } else {
          verifiedChangedFiles.push({
            path: file.path,
            exists: file.exists,
            ...(typeof file.absolutePath === "string"
              ? { absolutePath: file.absolutePath }
              : {}),
            ...(typeof file.sizeBytes === "number"
              ? { sizeBytes: file.sizeBytes }
              : {}),
          });
        }
      }
    }
  }

  const testResults: EnvelopeTestResult[] = [];
  if (!Array.isArray(o.testResults)) {
    errors.push("testResults must be an array");
  } else {
    for (const [i, t] of o.testResults.entries()) {
      const tr = t as Record<string, unknown>;
      if (
        !tr ||
        typeof tr.command !== "string" ||
        typeof tr.exitCode !== "number" ||
        typeof tr.summary !== "string"
      ) {
        errors.push(`testResults[${i}] must be {command, exitCode, summary}`);
      } else {
        testResults.push({
          command: tr.command,
          exitCode: tr.exitCode,
          summary: tr.summary,
        });
      }
    }
  }

  const criteria: EnvelopeCriterionStatus[] = [];
  if (!Array.isArray(o.acceptanceCriteriaStatus)) {
    errors.push("acceptanceCriteriaStatus must be an array");
  } else {
    for (const [i, c] of o.acceptanceCriteriaStatus.entries()) {
      const cs = c as Record<string, unknown>;
      if (
        !cs ||
        typeof cs.criterion !== "string" ||
        typeof cs.met !== "boolean" ||
        typeof cs.evidence !== "string"
      ) {
        errors.push(
          `acceptanceCriteriaStatus[${i}] must be {criterion, met, evidence}`,
        );
      } else {
        criteria.push({
          criterion: cs.criterion,
          met: cs.met,
          evidence: cs.evidence,
        });
      }
    }
  }

  if (errors.length > 0) return { present: true, ok: false, errors };

  return {
    present: true,
    ok: true,
    envelope: {
      diffSummary: o.diffSummary as string,
      filesChanged: o.filesChanged as string[],
      ...(typeof o.realWorkdir === "string"
        ? { realWorkdir: o.realWorkdir }
        : {}),
      ...(verifiedChangedFiles.length > 0 ? { verifiedChangedFiles } : {}),
      ...(typeof o.artifactsVerified === "boolean"
        ? { artifactsVerified: o.artifactsVerified }
        : {}),
      ...(isStringArray(o.missingArtifacts)
        ? { missingArtifacts: o.missingArtifacts }
        : {}),
      testResults,
      screenshotPaths: isStringArray(o.screenshotPaths)
        ? o.screenshotPaths
        : [],
      trajectoryPath:
        typeof o.trajectoryPath === "string" ? o.trajectoryPath : undefined,
      acceptanceCriteriaStatus: criteria,
      residualRisks: o.residualRisks as string[],
    },
  };
}

/** Compact human summary of a validated envelope, for the verifier/log. */
export function summarizeEnvelope(env: CompletionEnvelope): string {
  const tests = env.testResults
    .map((t) => `${t.command} → exit ${t.exitCode}`)
    .join("; ");
  const unmet = env.acceptanceCriteriaStatus
    .filter((c) => !c.met)
    .map((c) => c.criterion);
  return [
    `diff: ${env.diffSummary}`,
    env.realWorkdir ? `workdir: ${env.realWorkdir}` : "",
    `files: ${env.filesChanged.length}`,
    env.verifiedChangedFiles
      ? `verifiedFiles: ${env.verifiedChangedFiles.filter((f) => f.exists).length}/${env.verifiedChangedFiles.length}`
      : "",
    env.artifactsVerified === false && env.missingArtifacts?.length
      ? `UNVERIFIED missing: ${env.missingArtifacts.join(", ")}`
      : "",
    tests ? `tests: ${tests}` : "tests: none",
    `criteria: ${env.acceptanceCriteriaStatus.filter((c) => c.met).length}/${env.acceptanceCriteriaStatus.length} met`,
    unmet.length > 0 ? `unmet: ${unmet.join("; ")}` : "",
    env.residualRisks.length > 0
      ? `risks: ${env.residualRisks.join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

/** A targeted re-prompt for a present-but-malformed envelope. */
export function envelopeCorrection(errors: string[]): string {
  return [
    "Your completion did not include a valid CompletionEnvelope. Fix these and re-report when truly done:",
    ...errors.map((e) => `- ${e}`),
    "End your final message with the fenced ```json block exactly matching the required schema.",
  ].join("\n");
}
