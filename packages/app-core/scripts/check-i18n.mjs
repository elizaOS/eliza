#!/usr/bin/env node
// Strict i18n linter: every t("key") / i18nKey: "key" used in source must exist
// in every locale, and every locale key must be used somewhere in source.
//
// Dynamic call sites (t(variable), t(`prefix.${x}.suffix`)) are listed in the
// sibling i18n-dynamic-keys.json — keys/prefixes there are accepted as "used".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname → eliza/packages/app-core/scripts; up 3 → eliza repo root
const repoRoot = path.resolve(__dirname, "..", "..", "..");

const LOCALE_DIR = path.join(repoRoot, "packages/app-core/src/i18n/locales");
const SCAN_DIRS = [
  path.join(repoRoot, "packages/app-core/src"),
  path.join(repoRoot, "packages/ui/src"),
];
const ALLOWLIST_PATH = path.join(__dirname, "i18n-dynamic-keys.json");
const SOURCE_LOCALE = "en";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "i18n",
  "__tests__",
  "__mocks__",
]);
const SKIP_FILE_RE = /\.(d\.ts|test\.tsx?|spec\.tsx?|stories\.tsx?)$/;

const LITERAL_KEY_RE = /\bt\(\s*["']([^"'\n]+)["']/g;
const I18N_KEY_RE = /\bi18nKey:\s*["']([^"'\n]+)["']/g;
const TEMPLATE_RE = /\bt\(\s*`([^`]*)`/g;
const DYNAMIC_RE = /\bt\(\s*([^"'`\s)])/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !SKIP_FILE_RE.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function relpath(p) {
  return path.relative(repoRoot, p);
}

function scanSources() {
  const literalKeys = new Map(); // key -> [{file, line}]
  const prefixWildcards = new Map(); // prefix -> [{file, line}]
  const dynamicSites = []; // {file, line, snippet}

  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const text = fs.readFileSync(file, "utf8");

      LITERAL_KEY_RE.lastIndex = 0;
      let m = LITERAL_KEY_RE.exec(text);
      while (m) {
        const arr = literalKeys.get(m[1]) ?? [];
        arr.push({ file, line: lineOf(text, m.index) });
        literalKeys.set(m[1], arr);
        m = LITERAL_KEY_RE.exec(text);
      }

      I18N_KEY_RE.lastIndex = 0;
      m = I18N_KEY_RE.exec(text);
      while (m) {
        const arr = literalKeys.get(m[1]) ?? [];
        arr.push({ file, line: lineOf(text, m.index) });
        literalKeys.set(m[1], arr);
        m = I18N_KEY_RE.exec(text);
      }

      TEMPLATE_RE.lastIndex = 0;
      m = TEMPLATE_RE.exec(text);
      while (m) {
        const tpl = m[1];
        const line = lineOf(text, m.index);
        if (!tpl.includes("${")) {
          const arr = literalKeys.get(tpl) ?? [];
          arr.push({ file, line });
          literalKeys.set(tpl, arr);
        } else {
          const prefix = tpl.split("${")[0];
          if (prefix) {
            const arr = prefixWildcards.get(prefix) ?? [];
            arr.push({ file, line });
            prefixWildcards.set(prefix, arr);
          } else {
            dynamicSites.push({
              file,
              line,
              snippet: tpl.slice(0, 40),
            });
          }
        }
        m = TEMPLATE_RE.exec(text);
      }

      DYNAMIC_RE.lastIndex = 0;
      m = DYNAMIC_RE.exec(text);
      while (m) {
        // Skip JSX `{t(<something>)}` where the snippet is one of `{`, `(` etc.
        // The DYNAMIC_RE only matches non-quote/backtick first chars, and we
        // already covered template literals above, so anything left is a
        // variable/expression first arg.
        dynamicSites.push({
          file,
          line: lineOf(text, m.index),
          snippet: text
            .slice(m.index, Math.min(text.length, m.index + 60))
            .replace(/\n.*$/s, ""),
        });
        m = DYNAMIC_RE.exec(text);
      }
    }
  }

  return { literalKeys, prefixWildcards, dynamicSites };
}

function loadLocales() {
  const locales = {};
  for (const entry of fs.readdirSync(LOCALE_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const lang = entry.replace(/\.json$/, "");
    const data = JSON.parse(
      fs.readFileSync(path.join(LOCALE_DIR, entry), "utf8"),
    );
    if (data && typeof data === "object" && !Array.isArray(data)) {
      locales[lang] = data;
    }
  }
  return locales;
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) {
    return { keys: [], prefixes: [] };
  }
  const raw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
  return {
    keys: Array.isArray(raw.keys) ? raw.keys : [],
    prefixes: Array.isArray(raw.prefixes) ? raw.prefixes : [],
  };
}

function isCoveredByPrefixes(key, prefixes) {
  for (const p of prefixes) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

function fmtSites(sites, max = 3) {
  const shown = sites.slice(0, max).map((s) => `${relpath(s.file)}:${s.line}`);
  const more = sites.length > max ? ` (+${sites.length - max} more)` : "";
  return `${shown.join(", ")}${more}`;
}

function main() {
  const { literalKeys, prefixWildcards, dynamicSites } = scanSources();
  const locales = loadLocales();
  const allowlist = loadAllowlist();

  const langs = Object.keys(locales).sort();
  if (!langs.includes(SOURCE_LOCALE)) {
    console.error(`[i18n] missing source locale ${SOURCE_LOCALE}.json`);
    process.exit(1);
  }

  const errors = [];
  const warnings = [];

  // 1. Every literal key must exist in every locale.
  const missingByLang = new Map(); // lang -> [{key, sites}]
  for (const [key, sites] of literalKeys) {
    for (const lang of langs) {
      if (!(key in locales[lang])) {
        const arr = missingByLang.get(lang) ?? [];
        arr.push({ key, sites });
        missingByLang.set(lang, arr);
      }
    }
  }

  for (const lang of langs) {
    const missing = missingByLang.get(lang);
    if (!missing || missing.length === 0) continue;
    errors.push(
      `[i18n] ${lang}.json missing ${missing.length} key(s) used in source:`,
    );
    for (const { key, sites } of missing.slice(0, 50)) {
      errors.push(`  - ${key}   (${fmtSites(sites)})`);
    }
    if (missing.length > 50) {
      errors.push(`  ... ${missing.length - 50} more`);
    }
  }

  // 1b. Every key in the source locale must also exist in every other locale
  // (catches keys referenced only via dynamic/prefix calls — they fall back to
  // en at runtime, which means non-en users see English mid-UI).
  const sourceKeys = Object.keys(locales[SOURCE_LOCALE]);
  for (const lang of langs) {
    if (lang === SOURCE_LOCALE) continue;
    const untranslated = sourceKeys.filter((k) => !(k in locales[lang]));
    if (untranslated.length === 0) continue;
    errors.push(
      `[i18n] ${lang}.json missing ${untranslated.length} key(s) present in ${SOURCE_LOCALE}.json (untranslated):`,
    );
    for (const key of untranslated.slice(0, 50)) {
      errors.push(`  - ${key}`);
    }
    if (untranslated.length > 50) {
      errors.push(`  ... ${untranslated.length - 50} more`);
    }
  }

  // 2. Every locale key must be referenced in source (literal, wildcard prefix,
  //    or allowlist).
  const allowedKeys = new Set([...literalKeys.keys(), ...allowlist.keys]);
  const allowedPrefixes = [...prefixWildcards.keys(), ...allowlist.prefixes];

  const unusedByLang = new Map();
  for (const lang of langs) {
    const unused = [];
    for (const key of Object.keys(locales[lang])) {
      if (allowedKeys.has(key)) continue;
      if (isCoveredByPrefixes(key, allowedPrefixes)) continue;
      unused.push(key);
    }
    if (unused.length > 0) unusedByLang.set(lang, unused);
  }

  if (unusedByLang.size > 0) {
    // Report based on the source locale (en) as the canonical set; if a key
    // is unused in en it's almost certainly unused everywhere.
    const enUnused = unusedByLang.get(SOURCE_LOCALE) ?? [];
    if (enUnused.length > 0) {
      errors.push(
        `[i18n] ${SOURCE_LOCALE}.json has ${enUnused.length} unused key(s) (not referenced in source or allowlist):`,
      );
      for (const key of enUnused.slice(0, 50)) {
        errors.push(`  - ${key}`);
      }
      if (enUnused.length > 50) {
        errors.push(`  ... ${enUnused.length - 50} more`);
      }
    }
    // Other locales may have keys en doesn't (drift). Surface those too.
    for (const lang of langs) {
      if (lang === SOURCE_LOCALE) continue;
      const onlyHere = (unusedByLang.get(lang) ?? []).filter(
        (k) => !(k in locales[SOURCE_LOCALE]),
      );
      if (onlyHere.length === 0) continue;
      errors.push(
        `[i18n] ${lang}.json has ${onlyHere.length} key(s) absent from ${SOURCE_LOCALE}.json (orphaned translation):`,
      );
      for (const key of onlyHere.slice(0, 50)) {
        errors.push(`  - ${key}`);
      }
      if (onlyHere.length > 50) {
        errors.push(`  ... ${onlyHere.length - 50} more`);
      }
    }
  }

  // 3. Surface dynamic call sites the allowlist doesn't cover (informational).
  if (dynamicSites.length > 0) {
    const uncovered = dynamicSites.filter(() => {
      // We can't know what key the dynamic call resolves to; treat the
      // allowlist as the contract. If the allowlist has any keys/prefixes,
      // we trust the developer. Otherwise, warn.
      return allowlist.keys.length === 0 && allowlist.prefixes.length === 0;
    });
    if (uncovered.length > 0) {
      warnings.push(
        `[i18n] ${dynamicSites.length} dynamic t(<expr>) call site(s) — add resolved keys/prefixes to ${relpath(ALLOWLIST_PATH)} so unused-key checking stays accurate:`,
      );
      for (const s of dynamicSites.slice(0, 10)) {
        warnings.push(`  - ${relpath(s.file)}:${s.line}  ${s.snippet}`);
      }
      if (dynamicSites.length > 10) {
        warnings.push(`  ... ${dynamicSites.length - 10} more`);
      }
    }
  }

  for (const w of warnings) console.warn(w);
  for (const e of errors) console.error(e);

  if (errors.length === 0) {
    const totalKeys = Object.keys(locales[SOURCE_LOCALE]).length;
    console.log(
      `[i18n] OK — ${literalKeys.size} literal keys, ${prefixWildcards.size} wildcard prefixes, ${dynamicSites.length} dynamic sites; ${totalKeys} keys × ${langs.length} locales aligned.`,
    );
    process.exit(0);
  }
  process.exit(1);
}

main();
