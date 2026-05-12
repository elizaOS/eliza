#!/usr/bin/env node
/**
 * Audit action-search keyword i18n coverage.
 *
 * This checks the retrieval keyword file, not validate() behavior. Every
 * action stem must have English base terms plus non-empty supported locale
 * arrays with at least one locale-specific term.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ACTION_KEYWORDS_PATH = join(
  ROOT,
  "packages/shared/src/i18n/keywords/action-search.generated.keywords.json",
);
const SUPPORTED_LOCALES = ["es", "ko", "pt", "tl", "vi", "zh-CN"];
const args = new Set(process.argv.slice(2));
const format = args.has("--json") ? "json" : "markdown";

const audit = JSON.parse(
  execFileSync(
    process.execPath,
    [join(ROOT, "scripts/audit-action-availability.mjs"), "--json"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  ),
);
const keywordFile = JSON.parse(readFileSync(ACTION_KEYWORDS_PATH, "utf8"));
const expectedKeys = [
  ...new Set(
    audit.actions
      .map((action) => actionNameToKeywordStem(action.name))
      .filter(Boolean)
      .map((stem) => `action.${stem}.request`),
  ),
].sort();

const issues = [];

for (const locale of SUPPORTED_LOCALES) {
  if (!keywordFile.locales?.includes(locale)) {
    issues.push({
      key: "(file)",
      locale,
      issue: "missing_declared_locale",
    });
  }
}

for (const key of expectedKeys) {
  const entry = keywordFile.entries?.[key];
  if (!entry) {
    issues.push({ key, issue: "missing_entry" });
    continue;
  }

  const base = arrayValue(entry.base);
  if (base.length === 0) {
    issues.push({ key, issue: "missing_base_terms" });
  }
  const baseSet = new Set(base.map(normalizeTerm));

  for (const locale of SUPPORTED_LOCALES) {
    const terms = arrayValue(entry[locale]);
    if (terms.length === 0) {
      issues.push({ key, locale, issue: "missing_locale_terms" });
      continue;
    }
    if (!terms.some((term) => !baseSet.has(normalizeTerm(term)))) {
      issues.push({ key, locale, issue: "locale_terms_duplicate_base_only" });
    }
  }
}

for (const key of Object.keys(keywordFile.entries ?? {})) {
  if (!expectedKeys.includes(key)) {
    issues.push({ key, issue: "unexpected_entry" });
  }
}

const summary = {
  expectedActions: expectedKeys.length,
  keywordEntries: Object.keys(keywordFile.entries ?? {}).length,
  locales: SUPPORTED_LOCALES,
  issues: issues.length,
  missingEntries: issues.filter((issue) => issue.issue === "missing_entry")
    .length,
  missingLocaleTerms: issues.filter(
    (issue) => issue.issue === "missing_locale_terms",
  ).length,
  duplicateBaseOnlyLocaleTerms: issues.filter(
    (issue) => issue.issue === "locale_terms_duplicate_base_only",
  ).length,
};

if (format === "json") {
  console.log(JSON.stringify({ summary, issues }, null, 2));
} else {
  console.log(renderMarkdown(summary, issues));
}

if (issues.length > 0) {
  process.exitCode = 1;
}

function renderMarkdown(summary, issues) {
  const lines = [
    "# Action Keyword i18n Audit",
    "",
    `- Expected action keyword entries: ${summary.expectedActions}`,
    `- Actual action keyword entries: ${summary.keywordEntries}`,
    `- Locales: ${summary.locales.join(", ")}`,
    `- Issues: ${summary.issues}`,
  ];

  if (issues.length > 0) {
    lines.push("", "| Key | Locale | Issue |", "| --- | --- | --- |");
    for (const issue of issues) {
      lines.push(`| ${issue.key} | ${issue.locale ?? "-"} | ${issue.issue} |`);
    }
  }

  return lines.join("\n");
}

function actionNameToKeywordStem(actionName) {
  const words = String(actionName ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/g)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  if (words.length === 0) return "";
  return [words[0], ...words.slice(1).map(capitalizeAscii)].join("");
}

function capitalizeAscii(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeTerm(term) {
  return String(term ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
