/**
 * Prompt-content lint pass for default-pack `promptInstructions`.
 *
 * Per GAP §8.9 + IMPL §7.2: scans every shipped pack's `promptInstructions`
 * string for hardcoding patterns the runtime cannot semantically prevent.
 * The corpus is documented in `docs/audit/prompt-content-lint.md`.
 *
 * Rule kinds (all enforced by the same `lintPromptText` entry point):
 *
 *   - `pii_name`            known proper nouns from `HARDCODING_AUDIT.md` §3
 *                           (`Jill`, `Marco`, `Sarah`, `Suran`, `Samantha`).
 *   - `email_pii`           concrete email addresses (`name@host.tld`).
 *   - `phone_pii`           formatted phone numbers (`+1 555-555-5555`,
 *                           `(415) 555-5555`, etc.).
 *   - `absolute_path`       Unix (`/foo/bar`), home (`~/foo`) or Windows
 *                           (`C:\foo`) absolute paths.
 *   - `hardcoded_iso_time`  Standalone clock times (`HH:MM`, `HH:MM:SS`) and
 *                           full ISO datetimes — but **only** when the prompt
 *                           does not reference owner-fact time fields.
 *   - `embedded_conditional` content branches like `if user`, `unless …`,
 *                           `else if`, `case … when`, `when X = Y`.
 *   - `hardcoded_url`       concrete `http(s)://…` URLs.
 *   - `wave_narrative`      internal milestone refs (`Wave-1`, `W3-B`, …).
 *   - `prompt_slop`         AI-generated leftover markers (`TODO`, `FIXME`,
 *                           `XXX`, `HACK`).
 *
 * Wave 3 / W3-B promotes the runner to CI-fail; this module exposes the same
 * rule set at runtime so any code path that registers a pack — including
 * third-party plugin contributions — can opt in via `lintPack` / `lintPacks`.
 */

import type { ScheduledTaskSeed } from "./contract-stubs.js";
import type { DefaultPack } from "./registry-types.js";

export type PromptLintRuleKind =
  | "pii_name"
  | "email_pii"
  | "phone_pii"
  | "absolute_path"
  | "hardcoded_iso_time"
  | "embedded_conditional"
  | "hardcoded_url"
  | "wave_narrative"
  | "prompt_slop";

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

/**
 * Concrete email addresses. We match a simple `local@host.tld` shape; any
 * literal email in a default pack is a leak (use owner facts or entity
 * references).
 */
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Formatted phone numbers. International prefix optional; accepts `+1 555…`,
 * `(415) 555-5555`, `415-555-5555`, `415.555.5555`. Loose enough to flag the
 * common shapes; tight enough that random digit clusters in copy don't trip
 * (we require the area-code+exchange+line shape).
 */
const PHONE_REGEX =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g;

/** Absolute paths: `/foo/bar`, `~/foo`, `C:\foo`. */
const ABSOLUTE_PATH_REGEX =
  /(^|[\s"'`(])(?:\/[A-Za-z0-9_.\-/]{2,}|~\/[A-Za-z0-9_.\-/]{2,}|[A-Z]:\\[A-Za-z0-9_.\\-]{2,})/g;

/**
 * Hardcoded times. We allow:
 *   - the literal placeholder `HH:MM`
 *   - `morningWindow` / `eveningWindow` references (owner-fact references)
 *
 * Match: standalone `HH:MM`, `HH:MM:SS`, full ISO datetimes.
 */
const ISO_TIME_REGEX =
  /\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-]\d{2}:\d{2})?\b/g;

const ISO_DATE_REGEX =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g;

const OWNER_FACT_TIME_PATTERNS: ReadonlyArray<RegExp> = [
  /morningWindow/i,
  /eveningWindow/i,
  /quietHours/i,
  /HH:MM/,
];

/**
 * Embedded conditional logic. Catches:
 *   - `if user`, `if user's`, `if owner`, `if the user is`, `if name is`
 *   - `unless <X>` (e.g. `unless owner replied`)
 *   - `else if`
 *   - `case <X> when` (switch-style)
 *   - `when X = Y` / `when X: Y` (assignment-style branches)
 *   - `when name is`
 */
const CONDITIONAL_REGEX =
  /\b(if user(?:'s)?|when [A-Za-z_]+\s*[=:]+|if owner|if the user is|if name is|when name is|unless owner|unless user|else if\b|case [A-Za-z_]+ when\b)/gi;

/**
 * Concrete `http(s)://` URLs. Default packs reference connector capabilities,
 * not literal URLs; bake-in URLs are host- or environment-specific.
 */
const URL_REGEX = /\bhttps?:\/\/[^\s'"`)<>]+/g;

/**
 * Wave-N / W<N>-<L> narrative leak. Internal milestone references belong in
 * comments and docs, never inside `promptInstructions` (which ship to the
 * planner at runtime).
 */
const WAVE_NARRATIVE_REGEX = /\b(?:Wave[\s-]?\d+|W[1-9]\d*-[A-Z])\b/g;

/**
 * AI-generated leftover markers. `TODO`/`FIXME`/`XXX`/`HACK` in a prompt is
 * always a slip — finish the prompt or remove the placeholder.
 */
const SLOP_REGEX = /\b(TODO|FIXME|XXX|HACK)\b/g;

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

  for (const match of prompt.matchAll(EMAIL_REGEX)) {
    findings.push({
      packKey,
      recordKey,
      rule: "email_pii",
      message: `Concrete email address "${match[0]}" embedded in prompt; reference the owner or an EntityStore contact instead.`,
      match: match[0],
    });
  }

  for (const match of prompt.matchAll(PHONE_REGEX)) {
    findings.push({
      packKey,
      recordKey,
      rule: "phone_pii",
      message: `Phone number "${match[0]}" embedded in prompt; reference the owner or an EntityStore contact instead.`,
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

  for (const match of prompt.matchAll(URL_REGEX)) {
    findings.push({
      packKey,
      recordKey,
      rule: "hardcoded_url",
      message: `Concrete URL "${match[0]}" embedded in prompt; reference a connector capability rather than baking in a host-specific URL.`,
      match: match[0],
    });
  }

  for (const match of prompt.matchAll(WAVE_NARRATIVE_REGEX)) {
    findings.push({
      packKey,
      recordKey,
      rule: "wave_narrative",
      message: `Internal milestone reference "${match[0]}" in prompt; Wave/W-prefixed labels belong in comments and docs, not in runtime prompt content.`,
      match: match[0],
    });
  }

  for (const match of prompt.matchAll(SLOP_REGEX)) {
    findings.push({
      packKey,
      recordKey,
      rule: "prompt_slop",
      message: `Leftover marker "${match[0]}" in prompt; finish the prompt or remove the placeholder.`,
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
export function lintPacks(
  packs: ReadonlyArray<DefaultPack>,
): PromptLintFinding[] {
  const findings: PromptLintFinding[] = [];
  for (const pack of packs) {
    findings.push(...lintPack(pack));
  }
  return findings;
}

/**
 * Format a list of findings as a human-readable report. Each line is one
 * finding; the runner script prints this to stderr.
 */
export function formatFindings(
  findings: ReadonlyArray<PromptLintFinding>,
): string {
  if (findings.length === 0) return "";
  const lines = findings.map(
    (finding) =>
      `  [${finding.rule}] ${finding.packKey}/${finding.recordKey}: ${finding.message} (matched: ${JSON.stringify(finding.match)})`,
  );
  return lines.join("\n");
}
