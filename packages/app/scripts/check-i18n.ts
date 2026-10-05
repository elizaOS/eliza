#!/usr/bin/env node
/**
 * i18n catalog contract: every literal t("key") / i18nKey used in source must
 * exist in the SOURCE locale (en.json), every source-locale key must be used
 * somewhere, and no locale may carry orphaned keys the source lacks. Those are
 * errors. Non-source locales missing translations are reported as warning
 * summaries by default and only fail under --strict-translations: the source
 * catalog is the invariant CI can hold on every PR (no new key ships
 * uncataloged), while translation backfill is a content task whose incomplete
 * state must not make the gate permanently red — the previous all-errors
 * contract made this checker unwireable, it ended up wired into no lane, and
 * the source catalog silently drifted 705 keys behind source (#17605).
 *
 * Two value-level rules are also errors (#30636): no locale value may contain
 * a raw JavaScript `${expr}` placeholder (only `{{var}}` interpolates), and no
 * source-locale value may be its key's own humanized name ("Unsaved Changes
 * Title") while the call site's defaultValue supplies the real text — the
 * catalog overrides defaultValue, so the key name would ship.
 *
 * Dynamic call sites (t(variable), t(`prefix.${x}`)) are declared in
 * packages/app/scripts/i18n-dynamic-keys.json (`keys` / `prefixes`). The same file
 * carries `uncatalogued`: keys whose call sites pass a RUNTIME-CONDITIONAL
 * defaultValue — cataloging those would override the ternary and change
 * rendered English, so they are deliberately absent from every catalog until
 * their call sites are split into per-branch keys; each entry records why.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");

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

// Matches `t("key")` and the stable-ref indirection `tRef.current("key")`
// (`const tRef = useRef(t)`), which components use to call the translator from
// effects without re-subscribing. The ref form was invisible to this scan, so
// keys reached only through it looked unreferenced and were classified dead —
// `documentsview.FailedToLoadDocumentsData` was purged from all eight locales
// on that basis and caught in review. A translator reached through a ref is a
// literal use like any other.
const LITERAL_KEY_RE = /\bt(?:Ref\.current)?\(\s*["']([^"'\n]+)["']/g;
const I18N_KEY_RE = /\bi18nKey:\s*["']([^"'\n]+)["']/g;
const TEMPLATE_RE = /\bt\(\s*`([^`]*)`/g;
const DYNAMIC_RE = /\bt\(\s*([^"'`\s)])/g;

// General reachability scan: ANY quoted string literal, anywhere in the
// scanned surface (object props, arrays, maps — not only call sites), is
// treated as a potential indirect key reference. This is the conservative,
// enumeration-free fix for the metadata-indirection defect class: keys
// reached only as a VALUE (`labelKey: "connectormode.discord.managed.label"`)
// consumed elsewhere via `t(mode.labelKey)` are invisible to any regex that
// enumerates call syntaxes, because the key text never appears inside a
// `t(...)`/`i18nKey:` site — it appears as a plain string literal. Rather
// than add another call-syntax alternative (the instance-wise patch that
// produced this class twice — tRef.current, then labelKey/descriptionKey),
// this scan does not look at call syntax at all: it collects every string
// literal's contents and lets the unused-key check (rule 2 below) treat a
// catalog key as referenced if its exact text occurs ANYWHERE as a literal.
// Keeping a stale key one extra line costs nothing; deleting a live one
// breaks 7 locales — so this rule intentionally over-approximates uses.
const SINGLE_QUOTE_STR_RE = /'((?:\\.|[^'\\\n])*)'/g;
const DOUBLE_QUOTE_STR_RE = /"((?:\\.|[^"\\\n])*)"/g;
const BACKTICK_STR_RE = /`((?:\\.|[^`\\])*)`/g;

// `t("key", { ... })` — the options object starts at the match's final `{`.
const CALL_WITH_OPTIONS_RE =
  /\bt(?:Ref\.current)?\(\s*["']([^"'\n]+)["']\s*,\s*\{/g;
const DEFAULT_VALUE_RE =
  /\bdefaultValue:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/;

// A JavaScript template placeholder copied into a catalog value (`${expr}`)
// renders literally: the translator only interpolates `{{var}}`. A dollar sign
// directly before an interpolation (`${{amount}}`) is a currency amount and is
// legitimate, so only `${` NOT followed by a second `{` is rejected.
const JS_PLACEHOLDER_RE = /\$\{(?!\{)/;

// Key-name suffixes that describe a string's ROLE rather than its text: a
// catalog value that is just the key name with one of these ("Unsaved Changes
// Title", "Mode Line", "Approved Notice") is never real copy.
const STRUCTURAL_KEY_SUFFIX_RE =
  /(Title|Body|Prompt|Placeholder|Warning|Description|Desc|Line|Count|Notice|Failed|Hint|Message|Tooltip)$/;

// Returns the balanced `{ ... }` starting at `start`, skipping string and
// template-literal contents, or null when unbalanced.
function balancedObjectAt(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i++;
      } else if (c === quote) {
        quote = null;
      } else if (quote === "`" && c === "$" && text[i + 1] === "{") {
        let inner = 0;
        for (let j = i + 1; j < text.length; j++) {
          if (text[j] === "{") inner++;
          else if (text[j] === "}" && --inner === 0) {
            i = j;
            break;
          }
        }
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function decodeStringLiteral(literal) {
  const body = literal.slice(1, -1);
  if (literal[0] === '"') {
    try {
      return JSON.parse(literal);
    } catch {
      return body;
    }
  }
  return body.replace(/\\(.)/g, "$1");
}

// "UnsavedChangesTitle" / "testConnection" -> "unsaved changes title" /
// "test connection": the Title-Cased stub the catalog backfill produced.
export function humanizeKeyName(key) {
  const segment = key.split(".").pop() ?? key;
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

const lettersOnly = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

// True when a catalog value is its key's own name standing in for the text the
// call site actually supplies. Short labels whose key IS the text ("Secrets",
// "Running", "Save Settings") are deliberately not flagged even when a call
// site passes a different default — that is a product wording choice, not a
// backfill stub. Flagged only when the key name degraded the call-site text
// (case/punctuation lost from a multi-word label: "Dont Save" vs "Don't
// save"), or stands in for a sentence, an interpolated string, or a string
// whose key names its role (…Title, …Body, …Count).
export function isKeyNamedStub(key, catalogValue, callSiteDefault) {
  if (catalogValue === callSiteDefault) return false;
  const keyName = humanizeKeyName(key);
  if (catalogValue.trim().toLowerCase() !== keyName) return false;
  if (
    keyName.includes(" ") &&
    lettersOnly(catalogValue) === lettersOnly(callSiteDefault)
  ) {
    return true;
  }
  return (
    /\{\{\w+\}\}|\$\{/.test(callSiteDefault) ||
    /[.?!…]$/.test(callSiteDefault.trim()) ||
    STRUCTURAL_KEY_SUFFIX_RE.test(key.split(".").pop() ?? key)
  );
}

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

function scanSources(scanDirs) {
  const literalKeys = new Map(); // key -> [{file, line}]  (direct t()/i18nKey call sites)
  const prefixWildcards = new Map(); // prefix -> [{file, line}]
  const dynamicSites = []; // {file, line, snippet}
  const anyLiteralOccurrences = new Map(); // key -> [{file, line}]  (any string literal, any position)
  const callDefaults = new Map(); // key -> [{file, line, value}]  (static defaultValue at a t() call site)

  for (const dir of scanDirs) {
    for (const file of walk(dir)) {
      const text = fs.readFileSync(file, "utf8");

      for (const re of [SINGLE_QUOTE_STR_RE, DOUBLE_QUOTE_STR_RE]) {
        re.lastIndex = 0;
        let sm = re.exec(text);
        while (sm) {
          const arr = anyLiteralOccurrences.get(sm[1]) ?? [];
          arr.push({ file, line: lineOf(text, sm.index) });
          anyLiteralOccurrences.set(sm[1], arr);
          sm = re.exec(text);
        }
      }
      BACKTICK_STR_RE.lastIndex = 0;
      let bm = BACKTICK_STR_RE.exec(text);
      while (bm) {
        if (!bm[1].includes("${")) {
          const arr = anyLiteralOccurrences.get(bm[1]) ?? [];
          arr.push({ file, line: lineOf(text, bm.index) });
          anyLiteralOccurrences.set(bm[1], arr);
        }
        bm = BACKTICK_STR_RE.exec(text);
      }

      for (const re of [LITERAL_KEY_RE, I18N_KEY_RE]) {
        re.lastIndex = 0;
        let m = re.exec(text);
        while (m) {
          const arr = literalKeys.get(m[1]) ?? [];
          arr.push({ file, line: lineOf(text, m.index) });
          literalKeys.set(m[1], arr);
          m = re.exec(text);
        }
      }

      CALL_WITH_OPTIONS_RE.lastIndex = 0;
      let cm = CALL_WITH_OPTIONS_RE.exec(text);
      while (cm) {
        const options = balancedObjectAt(text, cm.index + cm[0].length - 1);
        const dm = options ? DEFAULT_VALUE_RE.exec(options) : null;
        if (dm) {
          const arr = callDefaults.get(cm[1]) ?? [];
          arr.push({
            file,
            line: lineOf(text, cm.index),
            value: decodeStringLiteral(dm[1]),
          });
          callDefaults.set(cm[1], arr);
        }
        cm = CALL_WITH_OPTIONS_RE.exec(text);
      }

      TEMPLATE_RE.lastIndex = 0;
      let m = TEMPLATE_RE.exec(text);
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
            dynamicSites.push({ file, line, snippet: tpl.slice(0, 40) });
          }
        }
        m = TEMPLATE_RE.exec(text);
      }

      DYNAMIC_RE.lastIndex = 0;
      m = DYNAMIC_RE.exec(text);
      while (m) {
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

  return {
    literalKeys,
    prefixWildcards,
    dynamicSites,
    anyLiteralOccurrences,
    callDefaults,
  };
}

function loadLocales(localeDir) {
  const locales = {};
  for (const entry of fs.readdirSync(localeDir)) {
    if (!entry.endsWith(".json")) continue;
    const lang = entry.replace(/\.json$/, "");
    const data = JSON.parse(
      fs.readFileSync(path.join(localeDir, entry), "utf8"),
    );
    if (data && typeof data === "object" && !Array.isArray(data)) {
      locales[lang] = data;
    }
  }
  return locales;
}

function loadAllowlist(allowlistPath) {
  // Fail closed. An absent allowlist silently disabled the dynamic-key and
  // uncatalogued rules — the checker still exited 0 and read as "i18n is
  // clean" while two of its rules were not running at all. A missing file is
  // a broken invocation, not an empty allowlist.
  if (!fs.existsSync(allowlistPath)) {
    throw new Error(
      `[i18n] allowlist not found at ${allowlistPath} — the dynamic-key and uncatalogued rules cannot run. Pass --allowlist <path> or restore the file; an absent allowlist is never treated as an empty one.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  return {
    keys: Array.isArray(raw.keys) ? raw.keys : [],
    prefixes: Array.isArray(raw.prefixes) ? raw.prefixes : [],
    uncatalogued: Array.isArray(raw.uncatalogued)
      ? raw.uncatalogued.map((entry) =>
          typeof entry === "string" ? entry : entry.key,
        )
      : [],
  };
}

function isCoveredByPrefixes(key, prefixes) {
  for (const p of prefixes) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

// Validates the catalog contract against a repo layout. Pure — no console, no
// process.exit — so tests can drive it against fixture trees; the CLI wrapper
// below owns printing and the exit code.
export function runI18nCheck(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const localeDir =
    options.localeDir ?? path.join(repoRoot, "packages/ui/src/i18n/locales");
  const scanDirs = options.scanDirs ?? [
    path.join(repoRoot, "packages/app/src"),
    path.join(repoRoot, "packages/ui/src"),
  ];
  const allowlistPath =
    options.allowlistPath ??
    path.join(repoRoot, "packages/app/scripts/i18n-dynamic-keys.json");
  const sourceLocale = options.sourceLocale ?? "en";
  const strictTranslations = options.strictTranslations ?? false;
  const relpath = (p) => path.relative(repoRoot, p);
  const fmtSites = (sites, max = 3) => {
    const shown = sites
      .slice(0, max)
      .map((s) => `${relpath(s.file)}:${s.line}`);
    const more = sites.length > max ? ` (+${sites.length - max} more)` : "";
    return `${shown.join(", ")}${more}`;
  };

  const {
    literalKeys,
    prefixWildcards,
    dynamicSites,
    anyLiteralOccurrences,
    callDefaults,
  } = scanSources(scanDirs);
  const locales = loadLocales(localeDir);
  const allowlist = loadAllowlist(allowlistPath);
  const uncatalogued = new Set(allowlist.uncatalogued);

  const langs = Object.keys(locales).sort();
  if (!langs.includes(sourceLocale)) {
    return {
      ok: false,
      errors: [`[i18n] missing source locale ${sourceLocale}.json`],
      warnings: [],
    };
  }

  const errors = [];
  const warnings = [];

  // 1. Every literal key must exist in the SOURCE locale — the catalog
  //    invariant CI holds on every PR. The same gap in a non-source locale is
  //    translation debt: a warning summary unless strictTranslations.
  for (const lang of langs) {
    const missing = [];
    for (const [key, sites] of literalKeys) {
      if (uncatalogued.has(key)) continue;
      if (!(key in locales[lang])) missing.push({ key, sites });
    }
    if (missing.length === 0) continue;
    const isError = lang === sourceLocale || strictTranslations;
    const sink = isError ? errors : warnings;
    sink.push(
      `[i18n] ${lang}.json missing ${missing.length} key(s) used in source:`,
    );
    const cap = isError ? 50 : 10;
    for (const { key, sites } of missing.slice(0, cap)) {
      sink.push(`  - ${key}   (${fmtSites(sites)})`);
    }
    if (missing.length > cap) sink.push(`  ... ${missing.length - cap} more`);
  }

  // 1b. Source-locale keys absent from another locale fall back to English at
  //     runtime — the same warning/strict split.
  const sourceKeys = Object.keys(locales[sourceLocale]);
  for (const lang of langs) {
    if (lang === sourceLocale) continue;
    const untranslated = sourceKeys.filter((k) => !(k in locales[lang]));
    if (untranslated.length === 0) continue;
    const sink = strictTranslations ? errors : warnings;
    sink.push(
      `[i18n] ${lang}.json is missing ${untranslated.length} translation(s) of ${sourceLocale}.json keys (falls back to ${sourceLocale} at runtime)`,
    );
    if (strictTranslations) {
      for (const key of untranslated.slice(0, 50)) sink.push(`  - ${key}`);
      if (untranslated.length > 50) {
        sink.push(`  ... ${untranslated.length - 50} more`);
      }
    }
  }

  // 2. Every source-locale key must be REACHABLE from source — an unused
  //    source key is dead copy, an error — and a key present in a locale but
  //    absent from the source catalog is an orphaned translation, also an
  //    error. Reachability is conservative and general: a key is reachable
  //    if it is a DIRECT call-site literal (t()/i18nKey/template-call), is
  //    covered by a wildcard prefix or the allowlist, OR occurs as a bare
  //    string literal ANYWHERE in the scanned source (`anyLiteralOccurrences`
  //    — object-literal props like `labelKey:`, key arrays, menu maps, and
  //    any future indirection form, without enumerating any of them). Only a
  //    key with NO literal occurrence at all is dead.
  const allowedKeys = new Set([...literalKeys.keys(), ...allowlist.keys]);
  const allowedPrefixes = [...prefixWildcards.keys(), ...allowlist.prefixes];

  const unusedSource = Object.keys(locales[sourceLocale]).filter(
    (key) =>
      !allowedKeys.has(key) &&
      !anyLiteralOccurrences.has(key) &&
      !isCoveredByPrefixes(key, allowedPrefixes),
  );
  // ADVISORY, never an error, and never grounds for deletion. A static scan
  // cannot prove a key is dead: `tRef.current("key")` and keys carried as
  // METADATA VALUES (connector-mode registries, eventTypeMeta.labelKey, tray
  // menus) reach t() only at runtime. Acting on an earlier version of this
  // list removed 86 live keys across eight locales. The checker nominates
  // candidates; a human verifies each against every call form. Missing-from-
  // catalog stays an error because a literal call with no entry IS provable.
  if (unusedSource.length > 0) {
    warnings.push(
      `[i18n] ${sourceLocale}.json has ${unusedSource.length} key(s) with no literal occurrence (ADVISORY — metadata-driven and ref-wrapped call sites are invisible to a static scan; never delete on this signal alone):`,
    );
    for (const key of unusedSource.slice(0, 20)) warnings.push(`  - ${key}`);
    if (unusedSource.length > 20) {
      warnings.push(`  ... ${unusedSource.length - 20} more`);
    }
  }

  // 2b. Tiered visibility (A5): a source key reachable only through the
  // general literal scan — never a direct call site, prefix, or allowlist
  // entry — is real but worth an operator's eyes. Report the count and a
  // sample of where it's reached from so indirect reachability stays
  // auditable rather than silently absorbed.
  const indirectOnly = Object.keys(locales[sourceLocale]).filter(
    (key) =>
      !allowedKeys.has(key) &&
      !isCoveredByPrefixes(key, allowedPrefixes) &&
      anyLiteralOccurrences.has(key),
  );
  if (indirectOnly.length > 0) {
    warnings.push(
      `[i18n] ${indirectOnly.length} ${sourceLocale}.json key(s) reached only indirectly (no direct t()/i18nKey call site — a string-literal occurrence elsewhere, e.g. a metadata prop or key array):`,
    );
    for (const key of indirectOnly.slice(0, 10)) {
      const sites = anyLiteralOccurrences.get(key) ?? [];
      warnings.push(`  - ${key}   (${fmtSites(sites, 1)})`);
    }
    if (indirectOnly.length > 10) {
      warnings.push(`  ... ${indirectOnly.length - 10} more`);
    }
  }
  for (const lang of langs) {
    if (lang === sourceLocale) continue;
    const orphaned = Object.keys(locales[lang]).filter(
      (k) => !(k in locales[sourceLocale]),
    );
    if (orphaned.length === 0) continue;
    errors.push(
      `[i18n] ${lang}.json has ${orphaned.length} key(s) absent from ${sourceLocale}.json (orphaned translation):`,
    );
    for (const key of orphaned.slice(0, 50)) errors.push(`  - ${key}`);
    if (orphaned.length > 50) errors.push(`  ... ${orphaned.length - 50} more`);
  }

  // 3. An uncatalogued entry is only legitimate while a call site still uses
  //    the key; once the site is split or removed, the entry must go too.
  for (const key of uncatalogued) {
    if (!literalKeys.has(key)) {
      errors.push(
        `[i18n] uncatalogued entry "${key}" is no longer used in source — remove it from ${relpath(allowlistPath)}`,
      );
    }
  }

  // 4. No locale value may carry a JavaScript template placeholder. `${expr}`
  //    is copied source, not a message: the translator interpolates only
  //    `{{var}}`, so the placeholder renders literally in the UI.
  for (const lang of langs) {
    const leaked = Object.entries(locales[lang]).filter(
      ([, value]) => typeof value === "string" && JS_PLACEHOLDER_RE.test(value),
    );
    if (leaked.length === 0) continue;
    errors.push(
      `[i18n] ${lang}.json has ${leaked.length} value(s) with a raw JavaScript \${...} placeholder (renders literally — use {{var}} and pass var at the call site):`,
    );
    for (const [key, value] of leaked.slice(0, 50)) {
      errors.push(`  - ${key}: ${JSON.stringify(value)}`);
    }
    if (leaked.length > 50) errors.push(`  ... ${leaked.length - 50} more`);
  }

  // 5. A source-locale value must not be its key's own name while the call
  //    site supplies the real text. The catalog wins over `defaultValue`, so
  //    a backfilled stub ("Unsaved Changes Title" for UnsavedChangesTitle)
  //    ships verbatim. Keys whose call sites disagree on the default are
  //    skipped: no single catalog value can match all of them.
  const stubs = [];
  for (const [key, sites] of callDefaults) {
    const catalogValue = locales[sourceLocale][key];
    if (typeof catalogValue !== "string") continue;
    const defaults = new Set(sites.map((s) => s.value));
    if (defaults.size !== 1) continue;
    const [callSiteDefault] = defaults;
    if (isKeyNamedStub(key, catalogValue, callSiteDefault)) {
      stubs.push({ key, catalogValue, callSiteDefault, sites });
    }
  }
  if (stubs.length > 0) {
    errors.push(
      `[i18n] ${sourceLocale}.json has ${stubs.length} value(s) that are the key's own name while the call site supplies the text (the catalog overrides defaultValue, so the key name ships):`,
    );
    for (const s of stubs) {
      errors.push(
        `  - ${s.key}: catalog ${JSON.stringify(s.catalogValue)} vs call site ${JSON.stringify(s.callSiteDefault)}   (${fmtSites(s.sites, 1)})`,
      );
    }
  }

  // 6. Surface unresolved dynamic call sites (informational). Unconditional:
  //    a non-empty allowlist is evidence that dynamic sites exist and are
  //    being hand-tracked, not evidence that every site is accounted for.
  //    Gating this on an empty allowlist silenced the report precisely when
  //    the repo actually has dynamic sites (#17606 review round 2).
  if (dynamicSites.length > 0) {
    warnings.push(
      `[i18n] ${dynamicSites.length} dynamic t(<expr>) call site(s) — add resolved keys/prefixes to ${relpath(allowlistPath)} so unused-key checking stays accurate:`,
    );
    for (const s of dynamicSites.slice(0, 10)) {
      warnings.push(`  - ${relpath(s.file)}:${s.line}  ${s.snippet}`);
    }
    if (dynamicSites.length > 10) {
      warnings.push(`  ... ${dynamicSites.length - 10} more`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      literalKeys: literalKeys.size,
      wildcardPrefixes: prefixWildcards.size,
      dynamicSites: dynamicSites.length,
      indirectKeys: indirectOnly.length,
      sourceKeys: sourceKeys.length,
      locales: langs.length,
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const allowlistArg = process.argv.indexOf("--allowlist");
  let result;
  try {
    result = runI18nCheck({
      strictTranslations: process.argv.includes("--strict-translations"),
      ...(allowlistArg !== -1 && process.argv[allowlistArg + 1]
        ? { allowlistPath: path.resolve(process.argv[allowlistArg + 1]) }
        : {}),
    });
  } catch (error) {
    // error-policy:J1 boundary translation — a misconfigured invocation is an
    // operator-facing message and exit 1, not a stack trace in the CI log.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  for (const w of result.warnings) console.warn(w);
  for (const e of result.errors) console.error(e);
  if (result.ok) {
    const s = result.stats;
    console.log(
      `[i18n] OK — ${s.literalKeys} literal keys, ${s.wildcardPrefixes} wildcard prefixes, ${s.dynamicSites} dynamic sites, ${s.indirectKeys} indirect-only keys; ${s.sourceKeys} source keys × ${s.locales} locales (translation gaps above are warnings; --strict-translations upgrades them).`,
    );
    process.exit(0);
  }
  process.exit(1);
}
