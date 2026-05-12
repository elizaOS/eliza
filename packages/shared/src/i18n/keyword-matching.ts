/**
 * Keyword matching utilities for i18n validation keywords.
 *
 * These functions operate on keyword terms (individual words/phrases) that are
 * loaded from the generated keyword data. They handle Unicode normalization,
 * word boundary detection, and greedy matching across message history.
 *
 * The keyword data itself lives in generated/validation-keyword-data.js
 * at runtime (codegen'd from keywords/*.keywords.json).
 */

import type { CharacterLanguage } from "../contracts/onboarding.js";
import { normalizeCharacterLanguage } from "../onboarding-presets.js";
import { VALIDATION_KEYWORD_DOCS } from "./generated/validation-keyword-data.js";

// Re-export the generated data so existing consumers can still reach it
export { VALIDATION_KEYWORD_DOCS };

type ValidationKeywordDoc = {
  base?: string;
  locales?: Partial<Record<CharacterLanguage, string>>;
};

function isValidationKeywordDoc(value: unknown): value is ValidationKeywordDoc {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return "base" in record || "locales" in record;
}

function lookupValidationKeywordDoc(key: string): ValidationKeywordDoc {
  let current: unknown = VALIDATION_KEYWORD_DOCS;
  for (const segment of key.split(".")) {
    if (!current || typeof current !== "object") {
      throw new Error(`Unknown validation keyword key: ${key}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (!isValidationKeywordDoc(current)) {
    throw new Error(`Unknown validation keyword key: ${key}`);
  }

  return current;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeKeywordMatchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function usesAsciiWordBoundaries(term: string): boolean {
  return /^[a-z0-9][a-z0-9' -]*$/i.test(term);
}

export function splitKeywordDoc(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const entry of value.split(/\n+/)) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizeKeywordMatchText(trimmed);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    terms.push(trimmed);
  }
  return terms;
}

export function textIncludesKeywordTerm(text: string, term: string): boolean {
  const normalizedText = normalizeKeywordMatchText(text);
  const normalizedTerm = normalizeKeywordMatchText(term);
  if (!normalizedText || !normalizedTerm) {
    return false;
  }

  if (usesAsciiWordBoundaries(normalizedTerm)) {
    const pattern = new RegExp(
      `\\b${escapePattern(normalizedTerm).replace(/\\ /g, "\\s+")}\\b`,
      "i",
    );
    if (pattern.test(text)) {
      return true;
    }

    const hasNonAsciiText = [...text].some((char) => char.charCodeAt(0) > 0x7f);
    if (hasNonAsciiText) {
      return normalizedText.includes(normalizedTerm);
    }
    return false;
  }

  return normalizedText.includes(normalizedTerm);
}

export function collectKeywordTermMatches(
  texts: readonly string[],
  terms: readonly string[],
): Set<string> {
  const matches = new Set<string>();
  for (const text of texts) {
    for (const term of terms) {
      if (textIncludesKeywordTerm(text, term)) {
        matches.add(term);
      }
    }
  }
  return matches;
}

export function findKeywordTermMatch(
  text: string,
  terms: readonly string[],
): string | undefined {
  const sorted = [...terms].sort((left, right) => right.length - left.length);
  return sorted.find((term) => textIncludesKeywordTerm(text, term));
}

export function getValidationKeywordTerms(
  key: string,
  options?: {
    includeAllLocales?: boolean;
    locale?: unknown;
  },
): string[] {
  const doc = lookupValidationKeywordDoc(key);
  if (options?.includeAllLocales) {
    return splitKeywordDoc(
      [doc.base, ...Object.values(doc.locales ?? {})]
        .filter((value): value is string => typeof value === "string")
        .join("\n"),
    );
  }

  const locale = normalizeCharacterLanguage(options?.locale);
  return splitKeywordDoc(`${doc.base ?? ""}\n${doc.locales?.[locale] ?? ""}`);
}

export function getValidationKeywordLocaleTerms(
  key: string,
  locale: unknown,
): string[] {
  const doc = lookupValidationKeywordDoc(key);
  const normalizedLocale = normalizeCharacterLanguage(locale);
  return splitKeywordDoc(doc.locales?.[normalizedLocale] ?? "");
}
