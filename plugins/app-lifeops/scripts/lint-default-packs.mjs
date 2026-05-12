#!/usr/bin/env node
/**
 * Default-pack prompt-content linter.
 *
 * Per IMPL §7.2 + GAP §8.9: scans `src/default-packs/*` `promptInstructions`
 * for the corpus documented in `docs/audit/prompt-content-lint.md`:
 *   - PII names, email addresses, phone numbers
 *   - absolute filesystem paths
 *   - hardcoded ISO times / datetimes outside owner-fact references
 *   - embedded conditional logic
 *   - hardcoded URLs
 *   - Wave-N / W<N>-<L> narrative leaks
 *   - leftover slop markers (TODO / FIXME / XXX / HACK)
 *
 * W3-B promotion: this runner exits non-zero on any finding by default.
 * `--allow-warnings` opts back into the legacy warnings-only behavior; it
 * exists only so a maintainer can re-run without CI failing while triaging
 * a wave of changes locally.
 *
 * Usage:
 *   node scripts/lint-default-packs.mjs                  # CI-fail mode (default)
 *   node scripts/lint-default-packs.mjs --allow-warnings # warnings-only
 *
 * The script reads each `src/default-packs/*.ts` file as text and runs the
 * same regex corpus the runtime `lintPromptText` uses. Reading the source
 * files directly (instead of importing the registered packs) keeps the
 * linter independent of the W1-A spine and avoids needing a TS runtime in
 * `bun run verify`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packsDir = path.resolve(here, "..", "src", "default-packs");

const PII_NAMES = ["Jill", "Marco", "Sarah", "Suran", "Samantha"];
const PII_REGEX = new RegExp(`\\b(${PII_NAMES.join("|")})\\b`, "g");

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const PHONE_REGEX =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g;

const ABSOLUTE_PATH_REGEX =
  /(?:^|[\s"'`(])(?:\/[A-Za-z0-9_.\-/]{2,}|~\/[A-Za-z0-9_.\-/]{2,}|[A-Z]:\\[A-Za-z0-9_.\\-]{2,})/g;

const ISO_TIME_REGEX =
  /\b(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-]\d{2}:\d{2})?\b/g;
const ISO_DATE_REGEX =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g;

const OWNER_FACT_TIME_PATTERNS = [
  /morningWindow/i,
  /eveningWindow/i,
  /quietHours/i,
  /HH:MM/,
];

const CONDITIONAL_REGEX =
  /\b(if user(?:'s)?|when [A-Za-z_]+\s*[=:]+|if owner|if the user is|if name is|when name is|unless owner|unless user|else if\b|case [A-Za-z_]+ when\b)/gi;

const URL_REGEX = /\bhttps?:\/\/[^\s'"`)<>]+/g;

const WAVE_NARRATIVE_REGEX = /\b(?:Wave[\s-]?\d+|W[1-9]\d*-[A-Z])\b/g;

const SLOP_REGEX = /\b(TODO|FIXME|XXX|HACK)\b/g;

/**
 * Extract every `promptInstructions: "..."` string from a TS source file.
 * Handles single-line strings and `+`-concatenated multi-line literals.
 *
 * Crude on purpose — the script must run without a TS runtime, and
 * `promptInstructions` values are by convention plain string literals
 * (single-quoted, double-quoted, or backtick-quoted). The runtime
 * `lintPromptText` is what backs in-process pack registration.
 */
function extractPrompts(source) {
  const prompts = [];
  // Match `promptInstructions:` followed by an optional literal (single, double,
  // or backtick-quoted). Support `+`-concatenated string literals on subsequent
  // lines.
  const re = /promptInstructions:\s*([\s\S]+?)(?=,\s*\n\s*(?:[a-zA-Z_]+:|\}))/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const slice = match[1];
    // Pull every quoted literal in `slice` and concatenate.
    const literalRe = /(["'`])((?:\\.|(?!\1).)*)\1/g;
    let literalMatch;
    let combined = "";
    while ((literalMatch = literalRe.exec(slice)) !== null) {
      combined += literalMatch[2].replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    if (combined.length > 0) {
      prompts.push(combined);
    }
  }
  return prompts;
}

function lintPromptText(packKey, recordIndex, prompt) {
  const findings = [];
  for (const m of prompt.matchAll(PII_REGEX)) {
    findings.push({
      rule: "pii_name",
      packKey,
      recordIndex,
      message: `PII name "${m[1]}" embedded in prompt; reference owner facts via contextRequest.includeOwnerFacts.preferredName instead.`,
      match: m[0],
    });
  }
  for (const m of prompt.matchAll(EMAIL_REGEX)) {
    findings.push({
      rule: "email_pii",
      packKey,
      recordIndex,
      message: `Concrete email address "${m[0]}" embedded in prompt; reference the owner or an EntityStore contact instead.`,
      match: m[0],
    });
  }
  for (const m of prompt.matchAll(PHONE_REGEX)) {
    findings.push({
      rule: "phone_pii",
      packKey,
      recordIndex,
      message: `Phone number "${m[0]}" embedded in prompt; reference the owner or an EntityStore contact instead.`,
      match: m[0],
    });
  }
  for (const m of prompt.matchAll(ABSOLUTE_PATH_REGEX)) {
    findings.push({
      rule: "absolute_path",
      packKey,
      recordIndex,
      message: `Absolute path embedded in prompt; default packs ship across hosts and must not bake in filesystem paths.`,
      match: m[0].trim(),
    });
  }
  const hasOwnerFactReference = OWNER_FACT_TIME_PATTERNS.some((re) =>
    re.test(prompt),
  );
  if (!hasOwnerFactReference) {
    for (const m of prompt.matchAll(ISO_TIME_REGEX)) {
      findings.push({
        rule: "hardcoded_iso_time",
        packKey,
        recordIndex,
        message: `Hardcoded clock time "${m[0]}" in prompt; reference ownerFact.morningWindow / eveningWindow instead.`,
        match: m[0],
      });
    }
    for (const m of prompt.matchAll(ISO_DATE_REGEX)) {
      findings.push({
        rule: "hardcoded_iso_time",
        packKey,
        recordIndex,
        message: `Hardcoded ISO datetime "${m[0]}" in prompt; reference owner facts or trigger anchors instead.`,
        match: m[0],
      });
    }
  }
  for (const m of prompt.matchAll(CONDITIONAL_REGEX)) {
    findings.push({
      rule: "embedded_conditional",
      packKey,
      recordIndex,
      message: `Conditional logic in prompt ("${m[0]}"); express as a registered gate or completionCheck rather than a content branch.`,
      match: m[0],
    });
  }
  for (const m of prompt.matchAll(URL_REGEX)) {
    findings.push({
      rule: "hardcoded_url",
      packKey,
      recordIndex,
      message: `Concrete URL "${m[0]}" embedded in prompt; reference a connector capability rather than baking in a host-specific URL.`,
      match: m[0],
    });
  }
  for (const m of prompt.matchAll(WAVE_NARRATIVE_REGEX)) {
    findings.push({
      rule: "wave_narrative",
      packKey,
      recordIndex,
      message: `Internal milestone reference "${m[0]}" in prompt; Wave/W-prefixed labels belong in comments and docs, not in runtime prompt content.`,
      match: m[0],
    });
  }
  for (const m of prompt.matchAll(SLOP_REGEX)) {
    findings.push({
      rule: "prompt_slop",
      packKey,
      recordIndex,
      message: `Leftover marker "${m[0]}" in prompt; finish the prompt or remove the placeholder.`,
      match: m[0],
    });
  }
  return findings;
}

function packKeyFromFilename(filename) {
  // Pack files are named like `daily-rhythm.ts`; the key matches the filename
  // stem. Skip helper / contract / registry / lint / index / consolidation /
  // escalation files.
  const stem = path.basename(filename, ".ts");
  const skip = new Set([
    "index",
    "registry-types",
    "contract-stubs",
    "consolidation-policies",
    "escalation-ladders",
    "lint",
  ]);
  return skip.has(stem) ? null : stem;
}

function main() {
  if (!fs.existsSync(packsDir)) {
    console.error(
      `[lint-default-packs] FAIL: no default-packs directory found at ${packsDir}.`,
    );
    process.exit(1);
  }
  const allowWarnings = process.argv.includes("--allow-warnings");

  const files = fs
    .readdirSync(packsDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  const allFindings = [];

  for (const file of files) {
    const packKey = packKeyFromFilename(file);
    if (!packKey) continue;
    const fullPath = path.join(packsDir, file);
    const source = fs.readFileSync(fullPath, "utf8");
    const prompts = extractPrompts(source);
    prompts.forEach((prompt, recordIndex) => {
      const findings = lintPromptText(packKey, recordIndex, prompt);
      allFindings.push(...findings);
    });
  }

  if (allFindings.length === 0) {
    console.log(
      "[lint-default-packs] clean — 0 findings across default packs.",
    );
    process.exit(0);
  }

  const prefix = allowWarnings ? "WARN" : "FAIL";
  console.error(
    `[lint-default-packs] ${prefix}: ${allFindings.length} finding(s) across default packs:`,
  );
  for (const finding of allFindings) {
    console.error(
      `  [${finding.rule}] ${finding.packKey}#${finding.recordIndex}: ${finding.message} (matched: ${JSON.stringify(finding.match)})`,
    );
  }
  if (allowWarnings) {
    console.error(
      "[lint-default-packs] --allow-warnings: exiting 0 despite findings.",
    );
    process.exit(0);
  }
  console.error(
    "[lint-default-packs] failing CI on findings (W3-B). Re-run with --allow-warnings only for local triage.",
  );
  process.exit(1);
}

main();
