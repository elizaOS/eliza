#!/usr/bin/env node
/**
 * View→action ratchet (#14369): every on-screen mutation in a BUILTIN view must
 * map to a registered agent action (its "chat twin"), so chat — and the coming
 * voice surface, which has no DOM to click — can always do what the button
 * does. A new local-only mutation (a control that changes state with no action
 * twin) fails this gate with the exact file/method to fix.
 *
 * How it works (all lexical, dependency-free — this runs in the develop-pr
 * lane-coverage job with no `bun install`):
 *
 *   1. Classify every `ElizaClient.prototype.<method>` in `packages/ui/src/api`
 *      by HTTP verb; POST/PUT/PATCH/DELETE (or a dynamic `method:`) marks the
 *      method as mutating. The typed client is the single write path for shell
 *      views, so its mutating surface IS the view-mutation vocabulary.
 *   2. Scan the whole first-party shell-view component tree
 *      (`packages/ui/src/components`) for calls to mutating client methods
 *      and for raw `fetch`/`client.fetch`/`client.rawRequest` calls with a
 *      mutating verb or dynamic `method` variable.
 *   3. Every discovered mutation site must resolve in the curated registry
 *      (`view-action-ratchet.registry.json`) to exactly one of:
 *        - `action`: the registered action id that is its chat twin,
 *        - `exempt`: a designed exclusion with a written reason (read-only
 *          diagnostics, OS/user-gesture flows, chat plumbing, wallet consent),
 *        - `gap`: a known missing twin carrying a tracking `issue` — the
 *          baseline. New gaps cannot be added silently; stale entries fail.
 *   4. Mapped action ids are validated against the REAL registered action
 *      surface (`packages/prompts/scripts/registered-action-inventory.js` —
 *      shared with the action-catalog generator) unioned with the canonical
 *      spec names, and `packages/docs/action-catalog.md` must list them — the
 *      drift that mis-filed #14365/#14366/#14367 ("action missing" when only
 *      the catalog was stale) fails here mechanically.
 *
 * Third-party plugin view bundles are out of scope by design — they may use
 * the generic `useAgentElement` bridge (see
 * `packages/agent/src/runtime/view-capability-audit.test.ts` for their gate).
 * First-party plugin-shipped views (wallet, task workbench) are covered by the
 * same plugin-view audit; this gate owns the shell-bundled builtin surface.
 */

import fs from "node:fs";
import path from "node:path";
import { collectRegisteredActionInventory } from "../prompts/scripts/registered-action-inventory.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const REGISTRY_PATH = path.join(
  import.meta.dirname,
  "view-action-ratchet.registry.json",
);
const CLIENT_API_DIR = "packages/ui/src/api";
// The entire first-party shell-view component tree, not a hand-picked subset:
// builtin views render their entry page under `components/pages` but compose
// mutating sections from siblings (`components/local-inference`,
// `components/connectors`, `components/custom-actions`, `components/transcripts`
// — the Live-meeting builtin view — etc.). Scanning only pages/settings/
// character let those sections' mutations pass the gate uncovered, so the
// "every builtin-view mutation has a chat twin" guarantee was silently false.
// Pure-presentational dirs (primitives, ui, shared) carry no client mutations,
// so scanning the whole tree adds coverage without noise. Third-party plugin
// view bundles live outside packages/ui and stay out of scope (see header).
const VIEW_ROOTS = ["packages/ui/src/components"];
const CATALOG_MD = "packages/docs/action-catalog.md";
const CANONICAL_SPEC_DIR = "packages/prompts/specs/actions";

const MUTATING_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const args = new Set(process.argv.slice(2));
const JSON_FLAG = args.has("--json");
const SELF_TEST = args.has("--self-test");

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node packages/scripts/view-action-ratchet.mjs [options]

Asserts every builtin-view on-screen mutation maps to a registered agent
action via packages/scripts/view-action-ratchet.registry.json. Fails on:
unmapped mutation sites, stale registry entries, mappings to unregistered
actions, and a stale packages/docs/action-catalog.md.

Options:
  --json        Machine-readable result.
  --self-test   Run the classifier/scanner self-test.
`);
  process.exit(0);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // error-policy:J3 a missing root yields an empty scan; the registry
    // staleness check below fails loudly if that ever silently empties.
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["__tests__", "__e2e__", "node_modules"].includes(entry.name)) {
        walk(full, out);
      }
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec|stories|e2e)\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Classify ElizaClient prototype methods by the HTTP verbs their bodies use.
 * A method with any mutating verb — or a dynamic `method:` expression that
 * cannot be proven read-only — counts as mutating. Exported for the self-test.
 */
export function classifyClientMethods(sources) {
  const verbsByMethod = new Map();
  for (const src of sources) {
    const decls = [...src.matchAll(/ElizaClient\.prototype\.(\w+)\s*=/g)];
    for (let i = 0; i < decls.length; i++) {
      const name = decls[i][1];
      const body = src.slice(
        decls[i].index,
        i + 1 < decls.length ? decls[i + 1].index : src.length,
      );
      const verbs = new Set(
        [
          ...body.matchAll(/method:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/g),
        ].map((m) => m[1]),
      );
      if (/method:\s*[A-Za-z_$[]/.test(body)) verbs.add("DYNAMIC");
      if (verbs.size === 0) verbs.add("GET");
      const existing = verbsByMethod.get(name) ?? new Set();
      for (const v of verbs) existing.add(v);
      verbsByMethod.set(name, existing);
    }
  }
  const mutating = new Set();
  for (const [name, verbs] of verbsByMethod) {
    if ([...verbs].some((v) => MUTATING_VERBS.has(v) || v === "DYNAMIC")) {
      mutating.add(name);
    }
  }
  return { verbsByMethod, mutating };
}

/** Span of one call's arguments: from the char after `(` to its matching `)`. */
function callArgsSpan(src, openParen) {
  let depth = 0;
  let inString = null;
  let escaped = false;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (!escaped && ch === inString) inString = null;
      escaped = !escaped && ch === "\\";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  return src.slice(openParen + 1);
}

/**
 * Stable key token for a raw request's first argument: a string/template
 * literal with `${…}` collapsed to `*`, or the identifier expression text.
 */
function collapseLiteralToken(value) {
  const trimmed = value.trimStart();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    let out = "";
    let escaped = false;
    for (let i = 1; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (!escaped && ch === quote) break;
      if (quote === "`" && ch === "$" && trimmed[i + 1] === "{") {
        let depth = 0;
        let j = i + 1;
        for (; j < trimmed.length; j++) {
          if (trimmed[j] === "{") depth++;
          if (trimmed[j] === "}") {
            depth--;
            if (depth === 0) break;
          }
        }
        out += "*";
        i = j;
        continue;
      }
      out += ch;
      escaped = !escaped && ch === "\\";
    }
    return out;
  }
  return null;
}

function pathTokensFromExpression(expression) {
  const tokens = [];
  for (const match of expression.matchAll(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g)) {
    const literal = match[0];
    if (!literal.includes("/api/")) continue;
    const token = collapseLiteralToken(literal);
    if (token) {
      tokens.push(token);
    }
  }
  return [...new Set(tokens)];
}

function resolvedIdentifierToken(src, beforeIndex, name) {
  const windowStart = Math.max(0, beforeIndex - 4000);
  const before = src.slice(windowStart, beforeIndex);
  const pattern = new RegExp(
    `\\b(?:const|let)\\s+${name}\\s*(?::[^=;]+)?=\\s*([\\s\\S]*?);`,
    "g",
  );
  let last = null;
  for (const match of before.matchAll(pattern)) last = match[1];
  if (!last) return null;
  const tokens = pathTokensFromExpression(last);
  return tokens.length > 0 ? tokens.join("|") : null;
}

function firstArgToken(argsSpan, src, beforeIndex) {
  const trimmed = argsSpan.trimStart();
  const literal = collapseLiteralToken(trimmed);
  if (literal !== null) return literal;
  const ident = trimmed.match(/^[A-Za-z_$][\w$.]*/);
  if (!ident) return "<expr>";
  if (!ident[0].includes(".")) {
    return resolvedIdentifierToken(src, beforeIndex, ident[0]) ?? ident[0];
  }
  return ident[0];
}

function rawRequestMethodToken(argsSpan) {
  const literal = argsSpan.match(/method:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/);
  if (literal) return literal[1];
  const dynamic = argsSpan.match(/method:\s*([A-Za-z_$][\w$]*)/);
  if (dynamic) return `DYNAMIC(${dynamic[1]})`;
  if (/(?:^|[{,])\s*method\s*(?:[,}])/.test(argsSpan)) {
    return "DYNAMIC(method)";
  }
  return null;
}

/** After `.fetch` / `.rawRequest`, skip optional generic args to find `(`. */
function openParenAfter(src, idx) {
  let i = idx;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === "<") {
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "<") depth++;
      if (src[i] === ">") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    while (i < src.length && /\s/.test(src[i])) i++;
  }
  return src[i] === "(" ? i : -1;
}

/**
 * Mutation sites in one builtin-view source file. Two shapes:
 *   { kind: "client", method }                — mutating typed-client call
 *   { kind: "raw", key: "<VERB> <pathToken>" } — raw fetch/rawRequest write
 * Exported for the self-test.
 */
export function scanViewSource(src, mutatingMethods) {
  const sites = [];
  const lineOf = (idx) => src.slice(0, idx).split("\n").length;

  for (const m of src.matchAll(/\.(\w+)\(/g)) {
    if (
      mutatingMethods.has(m[1]) &&
      m[1] !== "fetch" &&
      m[1] !== "rawRequest"
    ) {
      sites.push({ kind: "client", method: m[1], line: lineOf(m.index) });
    }
  }

  for (const m of src.matchAll(
    /(?:(?<![.\w])fetch|\.(?:fetch|rawRequest))\b/g,
  )) {
    const open = openParenAfter(src, m.index + m[0].length);
    if (open === -1) continue;
    const argsSpan = callArgsSpan(src, open);
    const verb = rawRequestMethodToken(argsSpan);
    if (!verb) continue;
    sites.push({
      kind: "raw",
      key: `${verb} ${firstArgToken(argsSpan, src, m.index)}`,
      line: lineOf(m.index),
    });
  }
  return sites;
}

function loadRegistry() {
  const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  for (const bucket of ["clientMethods", "rawSites"]) {
    if (typeof raw[bucket] !== "object" || raw[bucket] === null) {
      throw new Error(`[view-action-ratchet] registry is missing "${bucket}"`);
    }
    for (const [key, entry] of Object.entries(raw[bucket])) {
      const kinds = ["action", "exempt", "gap"].filter((k) => k in entry);
      if (kinds.length !== 1) {
        throw new Error(
          `[view-action-ratchet] registry entry "${key}" must have exactly one of action/exempt/gap`,
        );
      }
      if ("exempt" in entry && !entry.exempt) {
        throw new Error(
          `[view-action-ratchet] registry entry "${key}" exempt reason must be non-empty`,
        );
      }
      if ("gap" in entry && !/^#\d+$/.test(entry.gap.issue ?? "")) {
        throw new Error(
          `[view-action-ratchet] registry gap "${key}" must carry a tracking issue ("#NNNNN")`,
        );
      }
    }
  }
  return raw;
}

/** Canonical action names from the hand-maintained + generated prompt specs. */
function canonicalSpecNames() {
  const names = new Set();
  const dir = path.join(ROOT, CANONICAL_SPEC_DIR);
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const spec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const item of spec.actions ?? []) {
      if (typeof item.name === "string") names.add(item.name);
    }
  }
  return names;
}

function runSelfTest() {
  const clientSrc = `
    ElizaClient.prototype.listFiles = async function () {
      return this.fetch("/api/files");
    };
    ElizaClient.prototype.deleteFile = async function (fileName) {
      return this.fetch(\`/api/files/\${fileName}\`, { method: "DELETE" });
    };
    ElizaClient.prototype.dynamicCall = async function (method) {
      return this.fetch("/api/x", { method: methodVar });
    };
  `;
  const { mutating, verbsByMethod } = classifyClientMethods([clientSrc]);
  if (
    !mutating.has("deleteFile") ||
    !mutating.has("dynamicCall") ||
    mutating.has("listFiles") ||
    !verbsByMethod.get("listFiles")?.has("GET")
  ) {
    console.error(
      `[view-action-ratchet] self-test failed (classifier): ${JSON.stringify([...mutating])}`,
    );
    process.exit(1);
  }

  const viewSrc = `
    const x = await client.deleteFile(name);
    const y = await client.listFiles(); // read — not a site
    const method: "POST" | "DELETE" = action === "delete" ? "DELETE" : "POST";
    const path = action === "delete"
      ? \`/api/skills/curated/\${encodeURIComponent(name)}\`
      : \`/api/skills/curated/\${encodeURIComponent(name)}/\${action}\`;
    await client.fetch(path, { method });
    await client.rawRequest(\`/api/secrets/\${key}\`, { method: "PUT" });
    await client.fetch<{ ok: boolean }>("/api/browser-bridge/open", {
      method: "POST",
    });
    await fetch(WEBHOOK_URL, { method: "POST", body });
    await fetch("/api/read-only"); // GET — not a site
    // client.deleteFile( in a comment still counts lexically — acceptable:
  `;
  const sites = scanViewSource(viewSrc, mutating);
  const clientSites = sites.filter((s) => s.kind === "client");
  const rawKeys = sites.filter((s) => s.kind === "raw").map((s) => s.key);
  const wantRaw = [
    "DYNAMIC(method) /api/skills/curated/*|/api/skills/curated/*/*",
    "PUT /api/secrets/*",
    "POST /api/browser-bridge/open",
    "POST WEBHOOK_URL",
  ];
  if (
    clientSites.length !== 2 || // real call + the comment mention (lexical)
    clientSites.some((s) => s.method !== "deleteFile") ||
    wantRaw.some((k) => !rawKeys.includes(k)) ||
    rawKeys.length !== wantRaw.length
  ) {
    console.error(
      `[view-action-ratchet] self-test failed (scanner): ${JSON.stringify(sites)}`,
    );
    process.exit(1);
  }

  // Integration pins against the real tree: the gap-closing twins from
  // #14364-#14367 must be visible to the inventory, and the real scan must
  // still see the canonical FilesView delete — if either pin breaks, the
  // extraction rules (not the views) regressed.
  const inventory = new Set(
    collectRegisteredActionInventory(ROOT).map((i) => i.name),
  );
  for (const pin of ["DOCUMENT", "MEMORY", "FILES", "SETTINGS", "BACKGROUND"]) {
    if (!inventory.has(pin)) {
      console.error(
        `[view-action-ratchet] self-test failed: inventory lost pinned action ${pin}`,
      );
      process.exit(1);
    }
  }
  const realScan = collectMutationSites();
  if (!realScan.some((s) => s.kind === "client" && s.method === "deleteFile")) {
    console.error(
      "[view-action-ratchet] self-test failed: real scan no longer sees FilesView deleteFile",
    );
    process.exit(1);
  }
  for (const key of [
    "DYNAMIC(method) /api/skills/curated/*|/api/skills/curated/*/*",
    "POST */api/lifeops/occurrences/*/complete",
    "DELETE /api/secrets/logins/*/*",
  ]) {
    if (!realScan.some((s) => s.kind === "raw" && s.key === key)) {
      console.error(
        `[view-action-ratchet] self-test failed: real scan no longer sees raw key ${key}`,
      );
      process.exit(1);
    }
  }
  console.log("[view-action-ratchet] self-test passed");
}

function collectMutationSites() {
  const apiSources = walk(path.join(ROOT, CLIENT_API_DIR)).map((f) =>
    fs.readFileSync(f, "utf8"),
  );
  const { mutating } = classifyClientMethods(apiSources);
  const sites = [];
  for (const rootRel of VIEW_ROOTS) {
    for (const file of walk(path.join(ROOT, rootRel))) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const src = fs.readFileSync(file, "utf8");
      for (const site of scanViewSource(src, mutating)) {
        sites.push({ ...site, file: rel });
      }
    }
  }
  return sites;
}

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);
}

const registry = loadRegistry();
const sites = collectMutationSites();

const inventoryNames = new Set(
  collectRegisteredActionInventory(ROOT).map((i) => i.name),
);
const registeredNames = new Set([...inventoryNames, ...canonicalSpecNames()]);
const catalogText = fs.readFileSync(path.join(ROOT, CATALOG_MD), "utf8");

const failures = [];
const gaps = [];
const seenClientMethods = new Set();
const seenRawKeys = new Set();
const mappedActions = new Map(); // action -> example site

for (const site of sites) {
  const key = site.kind === "client" ? site.method : site.key;
  const entry =
    site.kind === "client"
      ? registry.clientMethods[key]
      : registry.rawSites[key];
  (site.kind === "client" ? seenClientMethods : seenRawKeys).add(key);

  if (!entry) {
    failures.push(
      `${site.file}:${site.line} — unmapped builtin-view mutation ${site.kind === "client" ? `client.${key}()` : `raw request "${key}"`}.\n` +
        `    Every builtin-view mutation needs a chat twin. Either map it to its registered action in\n` +
        `    packages/scripts/view-action-ratchet.registry.json ({ "action": "<ACTION_ID>" }), add a designed\n` +
        `    exemption with a reason, or — only with a tracking issue — record it as a gap.`,
    );
    continue;
  }
  if (entry.action) {
    mappedActions.set(entry.action, `${site.file}:${site.line}`);
  }
  if (entry.gap) {
    gaps.push({
      key,
      issue: entry.gap.issue,
      site: `${site.file}:${site.line}`,
    });
  }
}

// Stale registry entries ratchet the baseline down: an entry whose mutation
// site disappeared must be deleted so the registry never grows dead weight.
for (const key of Object.keys(registry.clientMethods)) {
  if (!seenClientMethods.has(key)) {
    failures.push(
      `registry entry clientMethods["${key}"] matches no scanned mutation site — remove it (the control was deleted or renamed).`,
    );
  }
}
for (const key of Object.keys(registry.rawSites)) {
  if (!seenRawKeys.has(key)) {
    failures.push(
      `registry entry rawSites["${key}"] matches no scanned mutation site — remove it (the request was deleted or its path changed).`,
    );
  }
}

// Mapped actions must exist in code AND in the generated catalog — the
// #14365/#14366/#14367 drift class (real action, stale catalog) fails here.
for (const [action, exampleSite] of mappedActions) {
  if (!registeredNames.has(action)) {
    failures.push(
      `registry maps ${exampleSite} to action "${action}", but no registered action with that id exists ` +
        `(checked Action declarations under packages/core, packages/agent, plugins/* and the canonical specs).`,
    );
  } else if (!new RegExp(`\\b${action}\\b`).test(catalogText)) {
    failures.push(
      `action "${action}" (twin of ${exampleSite}) is registered in code but missing from ${CATALOG_MD} — ` +
        `regenerate it: bun run --cwd packages/prompts build:action-docs`,
    );
  }
}

// Catalog freshness for the whole inventory, not just mapped ids: every
// registered action id must appear in the catalog markdown, so "the catalog
// says it does not exist" can never again be true of a registered action.
const missingFromCatalog = [...inventoryNames].filter(
  (name) => !new RegExp(`\\b${name}\\b`).test(catalogText),
);
if (missingFromCatalog.length > 0) {
  failures.push(
    `${CATALOG_MD} is stale — ${missingFromCatalog.length} registered action(s) missing: ` +
      `${missingFromCatalog.slice(0, 12).join(", ")}${missingFromCatalog.length > 12 ? ", …" : ""}.\n` +
      `    Regenerate it: bun run --cwd packages/prompts build:action-docs`,
  );
}

const summary = {
  ok: failures.length === 0,
  sites: sites.length,
  files: new Set(sites.map((s) => s.file)).size,
  mappedActions: [...mappedActions.keys()].sort(),
  gaps,
  failures,
};

if (JSON_FLAG) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `[view-action-ratchet] ${summary.sites} mutation site(s) across ${summary.files} builtin-view file(s); ` +
      `${summary.mappedActions.length} action twin(s); ${gaps.length} baselined gap(s); registered actions: ${registeredNames.size}`,
  );
  for (const gap of gaps) {
    console.log(
      `[view-action-ratchet]   gap ${gap.key} (${gap.issue}) at ${gap.site}`,
    );
  }
  if (failures.length > 0) {
    console.error(
      `[view-action-ratchet] FAIL — ${failures.length} violation(s):`,
    );
    for (const failure of failures) console.error(`  - ${failure}`);
  } else {
    console.log(
      "[view-action-ratchet] every builtin-view mutation maps to a registered action (or a documented exemption/gap)",
    );
  }
}

if (failures.length > 0) process.exit(1);
