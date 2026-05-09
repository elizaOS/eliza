#!/usr/bin/env node
/**
 * Wave-1 default-pack prompt-content linter.
 *
 * Per IMPL §3.4 + GAP §8.9: scans `src/default-packs/*` `promptInstructions`
 * for known PII, absolute paths, hardcoded ISO times outside owner-fact
 * references, and embedded conditional logic.
 *
 * Wave-1 ships **warnings only**: this script always exits 0 unless invoked
 * with `--fail-on-finding` (which W3-B will flip on by default).
 *
 * Usage:
 *   node scripts/lint-default-packs.mjs                 # warnings only (default)
 *   node scripts/lint-default-packs.mjs --fail-on-finding   # CI-fail mode (W3-B)
 *
 * The script reads each `src/default-packs/*.ts` file as text and runs the
 * same regex corpus the runtime `lintPromptText` uses. Reading the source
 * files directly (instead of importing the registered packs) keeps the
 * linter independent of the W1-A spine landing — and avoids needing a TS
 * runtime in `bun run verify`.
 *
 * The corpus is documented in `docs/audit/prompt-content-lint.md`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packsDir = path.resolve(here, "..", "src", "default-packs");

const PII_NAMES = ["Jill", "Marco", "Sarah", "Suran", "Samantha"];
const PII_REGEX = new RegExp(`\\b(${PII_NAMES.join("|")})\\b`, "g");

const ABSOLUTE_PATH_REGEX =
  /(?:^|[\s"'`(])(?:\/[A-Za-z0-9_.\-/]{2,}|~\/[A-Za-z0-9_.\-/]{2,}|[A-Z]:\\[A-Za-z0-9_.\\\-]{2,})/g;

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
  /\b(if user(?:'s)?|when [A-Za-z_]+\s*[=:]+|if owner|if the user is|if name is|when name is)/gi;

/**
 * Extract every `promptInstructions: "..."` string from a TS source file.
 * Handles single-line strings and `+`-concatenated multi-line literals.
 *
 * Crude on purpose — Wave-1 ships warnings; the false-positive cost is low
 * and the script must run without a TS runtime.
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
    console.warn(`[lint-default-packs] no default-packs directory found at ${packsDir}; skipping.`);
    process.exit(0);
  }
  const failOnFinding = process.argv.includes("--fail-on-finding");

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
    console.log("[lint-default-packs] clean — 0 findings across default packs.");
    process.exit(0);
  }

  const isWarning = !failOnFinding;
  const prefix = isWarning ? "WARN" : "FAIL";
  console.error(
    `[lint-default-packs] ${prefix}: ${allFindings.length} finding(s) across default packs:`,
  );
  for (const finding of allFindings) {
    console.error(
      `  [${finding.rule}] ${finding.packKey}#${finding.recordIndex}: ${finding.message} (matched: ${JSON.stringify(finding.match)})`,
    );
  }
  if (failOnFinding) {
    process.exit(1);
  }
  console.error(
    "[lint-default-packs] Wave-1 ships warnings only; promoted to CI-fail by W3-B.",
  );
  process.exit(0);
}

main();
