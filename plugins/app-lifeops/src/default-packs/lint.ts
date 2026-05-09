/**
 * Prompt-content lint pass for default-pack `promptInstructions`.
 *
 * Per GAP §8.9: scans for
 *   - known PII names (`Jill | Marco | Sarah | Suran | Samantha | …`)
 *   - absolute paths (regex `/^\//` and `/\\\b[A-Z]:\\\\/i` for Windows-style)
 *   - hardcoded ISO times outside owner-fact references (e.g. `08:00`,
 *     `2024-01-15T07:00:00Z`)
 *   - embedded conditional logic (`if user`, `when X = Y`, `if owner`,
 *     `if name is`)
 *
 * Wave-1 ships warnings only (per IMPL §3.4 risk-and-tradeoff). Wave 3 (W3-B)
 * promotes to CI-fail.
 *
 * The corpus is documented in `docs/audit/prompt-content-lint.md` so future
 * additions are tracked.
 */

import type { ScheduledTaskSeed } from "./contract-stubs.js";
import type { DefaultPack } from "./registry-types.js";

export type PromptLintRuleKind =
  | "pii_name"
  | "absolute_path"
  | "hardcoded_iso_time"
  | "embedded_conditional";

export interface PromptLintFinding {
  packKey: string;
  recordKey: string;
  rule: PromptLintRuleKind;
  message: string;
  match: string;
}

/**
 * Known PII names from `HARDCODING_AUDIT.md` §3 + GAP §8.9. Word-boundary
 * matched, case-sensitive (proper nouns).
 */
const PII_NAMES = ["Jill", "Marco", "Sarah", "Suran", "Samantha"] as const;

const PII_REGEX = new RegExp(`\\b(${PII_NAMES.join("|")})\\b`, "g");

/** Absolute paths: `/foo/bar`, `~/foo`, `C:\foo`. */
const ABSOLUTE_PATH_REGEX =
  /(^|[\s"'`(])(?:\/[A-Za-z0-9_.\-/]{2,}|~\/[A-Za-z0-9_.\-/]{2,}|[A-Z]:\\[A-Za-z0-9_.\\\-]{2,})/g;

/**
 * Hardcoded times. We allow:
 *   - the literal placeholder `HH:MM`
 *   - `morningWindow` / `eveningWindow` references (owner-fact references)
 *
 * Match: standalone `HH:MM`, `HH:MM:SS`, full ISO datetimes.
 */
const ISO_TIME_REGEX =
  /\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-]\d{2}:\d{2})?\b/g;

const ISO_DATE_REGEX = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g;

const OWNER_FACT_TIME_PATTERNS = [
  /morningWindow/i,
  /eveningWindow/i,
  /quietHours/i,
  /HH:MM/,
];

const CONDITIONAL_REGEX =
  /\b(if user(?:'s)?|when [A-Za-z_]+\s*[=:]+|if owner|if the user is|if name is|when name is)/gi;

/**
 * Run all lint rules against a single `promptInstructions` string. Returns the
 * findings; never throws.
 */
export function lintPromptText(args: {
  packKey: string;
  recordKey: string;
  prompt: string;
}): PromptLintFinding[] {
  const findings: PromptLintFinding[] = [];
  const { packKey, recordKey, prompt } = args;

  for (const match of prompt.matchAll(PII_REGEX)) {
    findings.push({
      packKey,
      recordKey,
      rule: "pii_name",
      message: `PII name "${match[1]}" embedded in prompt; reference owner facts via contextRequest.includeOwnerFacts.preferredName instead.`,
      match: match[0],
    });
  }

  for (const match of prompt.matchAll(ABSOLUTE_PATH_REGEX)) {
    findings.push({
      packKey,
      recordKey,
      rule: "absolute_path",
      message: `Absolute path embedded in prompt; default packs ship across hosts and must not bake in filesystem paths.`,
      match: match[0].trim(),
    });
  }

  // Hardcoded times — but only flag if there's no owner-fact reference
  // anywhere in the prompt. This keeps "use morningWindow.start" style
  // prompts clean while flagging "fire at 08:00" prompts.
  const hasOwnerFactReference = OWNER_FACT_TIME_PATTERNS.some((re) =>
    re.test(prompt),
  );
  if (!hasOwnerFactReference) {
    for (const match of prompt.matchAll(ISO_TIME_REGEX)) {
      findings.push({
        packKey,
        recordKey,
        rule: "hardcoded_iso_time",
        message: `Hardcoded clock time "${match[0]}" in prompt; reference ownerFact.morningWindow / eveningWindow instead.`,
        match: match[0],
      });
    }
    for (const match of prompt.matchAll(ISO_DATE_REGEX)) {
      findings.push({
        packKey,
        recordKey,
        rule: "hardcoded_iso_time",
        message: `Hardcoded ISO datetime "${match[0]}" in prompt; reference owner facts or trigger anchors instead.`,
        match: match[0],
      });
    }
  }

  for (const match of prompt.matchAll(CONDITIONAL_REGEX)) {
    findings.push({
      packKey,
      recordKey,
      rule: "embedded_conditional",
      message: `Conditional logic in prompt ("${match[0]}"); express as a registered gate or completionCheck rather than a content branch.`,
      match: match[0],
    });
  }

  return findings;
}

/**
 * Lint every record in a single pack.
 */
export function lintPack(pack: DefaultPack): PromptLintFinding[] {
  const findings: PromptLintFinding[] = [];
  for (const record of pack.records) {
    findings.push(
      ...lintPromptText({
        packKey: pack.key,
        recordKey:
          (record.metadata?.recordKey as string | undefined) ??
          recordIdFor(record),
        prompt: record.promptInstructions,
      }),
    );
  }
  return findings;
}

function recordIdFor(record: ScheduledTaskSeed): string {
  return record.idempotencyKey ?? "<unkeyed>";
}

/**
 * Lint multiple packs and return the aggregated findings.
 */
export function lintPacks(packs: ReadonlyArray<DefaultPack>): PromptLintFinding[] {
  const findings: PromptLintFinding[] = [];
  for (const pack of packs) {
    findings.push(...lintPack(pack));
  }
  return findings;
}

/**
 * Format a list of findings as a human-readable report. Each line is one
 * finding; the runner script prints this to stderr in warning-only mode.
 */
export function formatFindings(findings: ReadonlyArray<PromptLintFinding>): string {
  if (findings.length === 0) return "";
  const lines = findings.map(
    (finding) =>
      `  [${finding.rule}] ${finding.packKey}/${finding.recordKey}: ${finding.message} (matched: ${JSON.stringify(finding.match)})`,
  );
  return lines.join("\n");
}
