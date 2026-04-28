#!/usr/bin/env node
/**
 * audit-actions.mjs
 *
 * Scans every Eliza-style Action exported from in-benchmark action files and
 * flags any violation of the "pure LLM-extracted params" rule:
 *
 *   - regex / string-matching intent inference inside handlers
 *     (`.test(` / `.match(` on message text; `inferSubactionFrom*`;
 *     `haystack` variables; hardcoded service / alias maps)
 *   - missing required Action fields (name, description, similes, examples,
 *     parameters, validate, handler)
 *   - thin / empty descriptions (< 60 chars)
 *   - duplicate similes or similes that equal the action name
 *
 * Output: markdown table printed to stdout and written to
 * `action-audit.md`. Non-zero exit when any HIGH-severity violation is
 * found (so CI can gate on it).
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

// In-benchmark action set: lifeops + agent-level actions wired into the
// runtime factory the benchmark uses. Other paths are out of scope.
const IN_SCOPE_ROOTS = [
  "apps/app-lifeops/src/actions",
  "apps/app-lifeops/src/travel-time",
  "apps/app-lifeops/src/dossier",
  "apps/app-lifeops/src/followup/actions",
  "apps/app-lifeops/src/website-blocker/chat-integration/actions",
  "packages/agent/src/actions",
];

const MIN_DESCRIPTION_LEN = 60;

/** Recursively list *.ts files under a root, excluding tests + .d.ts. */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      out.push(...walk(full));
    } else if (
      s.isFile() &&
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts") &&
      !name.includes(".test.")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Parse all Action object literals from a TS source string. We don't need a
 * full TS parser — Action definitions in this codebase follow a stable
 * shape: an exported const with `: Action = { name: "…", … }` or
 * `: Action & { … } = { … }`. We locate the `name:` field by string
 * scanning and grab the surrounding block.
 */
function extractActions(source, filePath) {
  const actions = [];
  // Resolve `const ACTION_NAME = "X"` referenced by `name: ACTION_NAME`.
  // Many files in this codebase use that constant pattern; without resolution
  // the audit silently skips them.
  const namedConstants = new Map();
  const constRe =
    /\bconst\s+([A-Z][A-Z0-9_]+)\s*=\s*["']([A-Z][A-Z0-9_]+)["']/g;
  for (const m of source.matchAll(constRe)) {
    namedConstants.set(m[1], m[2]);
  }
  const literalRe = /name:\s*["']([A-Z][A-Z0-9_]+)["']/g;
  const constRefRe = /name:\s*([A-Z][A-Z0-9_]+)\s*[,}]/g;
  const sites = [];
  for (const m of source.matchAll(literalRe)) {
    sites.push({ idx: m.index ?? 0, name: m[1] });
  }
  for (const m of source.matchAll(constRefRe)) {
    const resolved = namedConstants.get(m[1]);
    if (resolved) sites.push({ idx: m.index ?? 0, name: resolved });
  }
  // Sort by source position so each Action object is found at its earliest
  // recognizable name reference (`name:` field).
  sites.sort((a, b) => a.idx - b.idx);
  const seenAtIdx = new Set();
  for (const site of sites) {
    const name = site.name;
    const nameIdx = site.idx;
    if (seenAtIdx.has(nameIdx)) continue;
    seenAtIdx.add(nameIdx);
    // Find the enclosing { for this Action object
    let depth = 0;
    let blockStart = -1;
    for (let i = nameIdx; i >= 0; i -= 1) {
      const ch = source[i];
      if (ch === "}") depth += 1;
      else if (ch === "{") {
        if (depth === 0) {
          blockStart = i;
          break;
        }
        depth -= 1;
      }
    }
    if (blockStart === -1) continue;
    // Find the matching close
    depth = 1;
    let blockEnd = -1;
    for (let i = blockStart + 1; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          blockEnd = i;
          break;
        }
      }
    }
    if (blockEnd === -1) continue;
    const block = source.slice(blockStart, blockEnd + 1);
    // Heuristic: the block must look like an Action (has handler + validate
    // or at least handler + description).
    if (!/\bhandler\s*:/.test(block)) continue;
    if (!/\bdescription\s*:/.test(block)) continue;
    actions.push({ name, block, filePath });
  }
  return actions;
}

/** Extract a field's raw literal range; returns null if absent. */
function extractFieldRaw(block, fieldName) {
  const re = new RegExp(`\\b${fieldName}\\s*:`);
  const m = block.match(re);
  if (!m) return null;
  const start = (m.index ?? 0) + m[0].length;
  // Skip whitespace
  let i = start;
  while (i < block.length && /\s/.test(block[i])) i += 1;
  const first = block[i];
  if (first === "[" || first === "{") {
    // Balanced bracket scan
    const open = first;
    const close = first === "[" ? "]" : "}";
    let depth = 0;
    let j = i;
    for (; j < block.length; j += 1) {
      const ch = block[j];
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return block.slice(i, j + 1);
      }
    }
    return null;
  }
  if (first === '"' || first === "'" || first === "`") {
    // String or template — scan for matching quote (respecting escapes +
    // concatenation across `+` on newlines).
    let j = i;
    const quote = first;
    j += 1;
    for (; j < block.length; j += 1) {
      const ch = block[j];
      if (ch === "\\") {
        j += 1;
        continue;
      }
      if (ch === quote) break;
    }
    // Walk past `+ "..."` continuations
    let k = j + 1;
    while (k < block.length) {
      while (k < block.length && /\s/.test(block[k])) k += 1;
      if (block[k] !== "+") break;
      k += 1;
      while (k < block.length && /\s/.test(block[k])) k += 1;
      const nextQuote = block[k];
      if (nextQuote !== '"' && nextQuote !== "'" && nextQuote !== "`") break;
      k += 1;
      while (k < block.length) {
        const ch = block[k];
        if (ch === "\\") {
          k += 2;
          continue;
        }
        if (ch === nextQuote) break;
        k += 1;
      }
      j = k;
      k = j + 1;
    }
    return block.slice(i, j + 1);
  }
  return null;
}

/** Strip quoted strings then concatenate to get the "prose" length. */
function roughDescriptionProseLength(raw) {
  if (!raw) return 0;
  // Remove quotes + `+` / whitespace / backslashes / common escapes, count
  // remaining characters as a floor estimate.
  return raw
    .replace(/["'`]/g, "")
    .replace(/\\n/g, " ")
    .replace(/\s+\+\s+/g, "")
    .replace(/\s+/g, " ")
    .trim().length;
}

function extractStringArray(raw) {
  if (!raw) return [];
  const out = [];
  const re = /["']([^"']+)["']/g;
  for (const m of raw.matchAll(re)) out.push(m[1]);
  return out;
}

/** Heuristic violations detected by scanning the block. */
function findViolations(action, source) {
  const { name, block } = action;
  const violations = [];

  // Required fields
  for (const field of ["description", "similes", "handler", "validate"]) {
    // Match both `field:` (explicit) and `field,` / `field\n}` (shorthand
    // where the property name equals the local variable name).
    if (!new RegExp(`\\b${field}\\s*[:,}\\n]`).test(block)) {
      violations.push({
        severity: field === "validate" ? "medium" : "high",
        rule: `missing-${field}`,
        detail: `Action ${name} is missing required field "${field}"`,
      });
    }
  }
  // `examples` is optional but recommended — accept shorthand too.
  if (!/\bexamples\s*[:,}\n]/.test(block)) {
    violations.push({
      severity: "low",
      rule: "missing-examples",
      detail: `Action ${name} has no examples — planner will only see description/similes`,
    });
  }
  // `parameters` recommended when the action takes any — accept shorthand too.
  if (!/\bparameters\s*[:,}\n]/.test(block)) {
    violations.push({
      severity: "low",
      rule: "missing-parameters",
      detail: `Action ${name} declares no parameters block`,
    });
  }

  // Description length
  const descRaw = extractFieldRaw(block, "description");
  const descLen = roughDescriptionProseLength(descRaw);
  if (descLen < MIN_DESCRIPTION_LEN) {
    violations.push({
      severity: "medium",
      rule: "thin-description",
      detail: `Action ${name} description is only ~${descLen} chars (min ${MIN_DESCRIPTION_LEN}) — small models will mis-classify`,
    });
  }

  // Similes quality
  const similesRaw = extractFieldRaw(block, "similes");
  const similes = extractStringArray(similesRaw);
  const seen = new Set();
  for (const s of similes) {
    const norm = s.toUpperCase();
    if (norm === name) {
      violations.push({
        severity: "low",
        rule: "redundant-simile",
        detail: `Action ${name} lists its own name "${s}" as a simile`,
      });
    }
    if (seen.has(norm)) {
      violations.push({
        severity: "low",
        rule: "duplicate-simile",
        detail: `Action ${name} has duplicate simile "${s}"`,
      });
      continue;
    }
    seen.add(norm);
  }

  // Heuristic intent inference & format-coercion — the "cheating" rules.
  // Two tiers:
  //   HIGH: real intent inference — `looksLike*`, `infer*FromText/Intent`,
  //         `extract*FromText/Intent`, `resolve*Intent/Command`. These
  //         classify the user's intent from message text instead of relying
  //         on the LLM planner.
  //   MEDIUM: parameter-format coercion — `parseLooseParameterString` and
  //         siblings. These tolerate the planner emitting params as a
  //         stringly-typed blob; not strictly intent inference, but still a
  //         deviation from "trust planner-extracted structured params".
  const inferHelperPattern =
    /function\s+(infer\w*FromText|infer\w*FromIntent|inferSubaction|inferKind|inferSurface|inferPasswordManager|extract\w*FromText|extract\w*FromIntent|extractEventTypeUri|extractDateRange|extractPasswordSearchQuery|extractLifeTimeZone\w*|resolveSubscriptionIntent|resolveCryptoCommand|resolveAlarmDayOffset|looksLike\w+)\s*\(/;
  const inferMatch = source.match(inferHelperPattern);
  if (inferMatch) {
    const fn = inferMatch[1];
    const callCount = (source.match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? [])
      .length;
    if (callCount > 1) {
      // Allowlist: validate-time helpers that delegate to the shared i18n
      // keyword loader (`getValidationKeywordTerms` + `findKeywordTermMatch`)
      // are explicitly OK per project policy — string matching in validate()
      // is permitted when fully internationalized + greedy.
      const fnBodyMatch = source.match(
        new RegExp(
          `function\\s+${fn}\\s*\\([^)]*\\)\\s*[^{]*\\{([\\s\\S]{0,800}?)\\n\\}`,
        ),
      );
      const fnBody = fnBodyMatch?.[1] ?? "";
      const usesI18nLoader =
        /\bgetValidationKeywordTerms\s*\(/.test(fnBody) ||
        /\bfindKeywordTermMatch\s*\(/.test(fnBody);
      if (!usesI18nLoader) {
        violations.push({
          severity: "high",
          rule: "regex-intent-inference",
          detail: `Action ${name} file defines and uses heuristic helper ${fn} — LLM should extract all params`,
        });
      }
    }
  }
  const formatCoercionPattern =
    /function\s+(parseLooseParameterString|parseFlatParams|parseInlineParams)\s*\(/;
  const formatMatch = source.match(formatCoercionPattern);
  if (formatMatch) {
    const fn = formatMatch[1];
    const callCount = (source.match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? [])
      .length;
    if (callCount > 1) {
      violations.push({
        severity: "medium",
        rule: "param-format-coercion",
        detail: `Action ${name} file defines and uses ${fn} — accepts stringly-typed planner params; prefer enforcing structured JSON in the planner schema`,
      });
    }
  }

  // Hardcoded lookup tables for service / channel / alias resolution.
  if (/\bconst\s+KNOWN_[A-Z_]+\s*:[^=]*=\s*\{/.test(source)) {
    violations.push({
      severity: "medium",
      rule: "hardcoded-alias-table",
      detail: `Action ${name} file defines a KNOWN_* lookup table — rely on LLM-extracted names instead`,
    });
  }

  // Regex on handler-local text.
  const regexOnText = block.match(
    /\/[^\n/]+\/[gimsuy]*\s*\.\s*(test|match|exec)\s*\(/,
  );
  if (regexOnText) {
    violations.push({
      severity: "medium",
      rule: "regex-in-handler",
      detail: `Action ${name} handler uses a raw regex (${regexOnText[0]}) — suspicious unless it's data-format validation`,
    });
  }

  return violations;
}

function severityRank(s) {
  return { high: 0, medium: 1, low: 2 }[s] ?? 3;
}

function main() {
  const rows = [];
  let fileCount = 0;
  let actionCount = 0;

  for (const rel of IN_SCOPE_ROOTS) {
    const root = join(REPO_ROOT, rel);
    for (const file of walk(root)) {
      fileCount += 1;
      const source = readFileSync(file, "utf-8");
      const actions = extractActions(source, file);
      for (const action of actions) {
        actionCount += 1;
        const violations = findViolations(action, source);
        rows.push({
          file: relative(REPO_ROOT, file),
          name: action.name,
          violations,
        });
      }
    }
  }

  rows.sort((a, b) => {
    const aMax = Math.min(
      ...(a.violations.length
        ? a.violations.map((v) => severityRank(v.severity))
        : [4]),
    );
    const bMax = Math.min(
      ...(b.violations.length
        ? b.violations.map((v) => severityRank(v.severity))
        : [4]),
    );
    if (aMax !== bMax) return aMax - bMax;
    return a.name.localeCompare(b.name);
  });

  const highCount = rows.reduce(
    (n, r) => n + r.violations.filter((v) => v.severity === "high").length,
    0,
  );
  const medCount = rows.reduce(
    (n, r) => n + r.violations.filter((v) => v.severity === "medium").length,
    0,
  );
  const lowCount = rows.reduce(
    (n, r) => n + r.violations.filter((v) => v.severity === "low").length,
    0,
  );

  const lines = [];
  lines.push(`# Action Audit`);
  lines.push("");
  lines.push(
    `Scanned **${actionCount}** actions across **${fileCount}** files.`,
  );
  lines.push(
    `**High:** ${highCount} · **Medium:** ${medCount} · **Low:** ${lowCount}`,
  );
  lines.push("");

  const clean = rows.filter((r) => r.violations.length === 0);
  const dirty = rows.filter((r) => r.violations.length > 0);

  if (dirty.length) {
    lines.push(`## Violations (${dirty.length})`);
    lines.push("");
    lines.push("| Action | Severity | Rule | Detail | File |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const row of dirty) {
      for (const v of row.violations) {
        lines.push(
          `| \`${row.name}\` | ${v.severity} | \`${v.rule}\` | ${v.detail.replace(/\|/g, "\\|")} | \`${row.file}\` |`,
        );
      }
    }
    lines.push("");
  }

  lines.push(`## Clean (${clean.length})`);
  lines.push("");
  if (clean.length) {
    lines.push("| Action | File |");
    lines.push("| --- | --- |");
    for (const row of clean) {
      lines.push(`| \`${row.name}\` | \`${row.file}\` |`);
    }
  }
  lines.push("");

  const out = lines.join("\n");
  const outPath = join(REPO_ROOT, "action-audit.md");
  writeFileSync(outPath, out);
  console.log(out);
  console.log(`\n[audit] wrote ${outPath}`);

  process.exit(highCount > 0 ? 1 : 0);
}

main();
