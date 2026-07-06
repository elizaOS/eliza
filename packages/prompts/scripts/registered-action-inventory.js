/**
 * Static scanner for the REAL registered action surface: every `Action`
 * definition in `packages/core/src`, `packages/agent/src`, and `plugins/*\/src`,
 * plus the view-scoped actions declared on `BUILTIN_VIEWS`. Unlike the
 * canonical spec pipeline (`generate-plugin-action-spec.js`, which deliberately
 * drops self-describing plugin actions so `action-docs.ts` stays a curated
 * prompt catalog), this collector drops NOTHING — it answers "which action ids
 * exist in code", not "which actions should the model be taught up front".
 *
 * Two consumers share it so there is exactly one extraction rule set:
 * `generate-action-docs.js` renders the inventory into the "Registered runtime
 * actions" section of `packages/docs/action-catalog.md`, and the view→action
 * ratchet (`packages/scripts/view-action-ratchet.mjs`) validates that every
 * builtin-view mutation maps to one of these ids and that the catalog has not
 * drifted from source. Issues #14365/#14366/#14367 were mis-filed as "action
 * missing" precisely because the catalog omitted registered actions — this
 * scanner is what makes that class of drift mechanically visible (#14369).
 *
 * Detection is lexical (no TS compiler dependency, usable from dependency-free
 * CI audits): an action is a `const X: Action = {...}` or
 * `function f(...): Action { return {...} }` declaration whose top-level `name`
 * resolves to an UPPER_SNAKE string literal (directly or via a same-file
 * `const NAME = "..."`). Names outside UPPER_SNAKE are ignored on purpose —
 * every registered runtime action id follows that convention, and it filters
 * example-dialogue `name:` fields and parameter descriptors.
 */
import fs from "node:fs";
import path from "node:path";

const SKIP_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "__tests__",
  "__mocks__",
  "__fixtures__",
  "test",
  "tests",
  "generated",
  "vendor",
]);

const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;

function isSourceFile(name) {
  if (!/\.(ts|tsx)$/.test(name) || name.endsWith(".d.ts")) return false;
  return !/\.(test|spec|stories|e2e|fixture|mock)\.(ts|tsx)$/.test(name);
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // error-policy:J3 a listed root may not exist in a partial checkout; the
    // caller validates the collected inventory against pinned known actions.
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR_SEGMENTS.has(entry.name)) walk(full, out);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** `const ACTION_NAME = "X"`-style same-file string constants. */
function collectStringConsts(src) {
  const consts = new Map();
  for (const m of src.matchAll(
    /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+)?=\s*"([^"\n]*)"/g,
  )) {
    consts.set(m[1], m[2]);
  }
  return consts;
}

/**
 * Return the value span of the top-level `name` property of the object literal
 * starting at `braceStart`, tracking nesting so a nested object's `name:` (a
 * parameter descriptor, an example turn) is never mistaken for the action id.
 */
function topLevelNameToken(src, braceStart) {
  let depth = 0;
  let i = braceStart;
  let inString = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1] ?? "";
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (!escaped && ch === inString) inString = null;
      escaped = !escaped && ch === "\\";
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i++;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return null; // object closed without a top-level name
      i++;
      continue;
    }
    if (depth === 1 && ch === "n" && /\bname\s*:/y.test(src.slice(i, i + 8))) {
      // Only accept `name:` in property position (start of object or after a
      // comma) so identifiers like `entityName:` never match.
      const before = src.slice(braceStart, i).trimEnd();
      const prev = before[before.length - 1];
      if (prev === "{" || prev === ",") {
        const rest = src.slice(i);
        const lit = rest.match(/^name\s*:\s*"([^"\n]*)"/);
        if (lit) return { kind: "literal", value: lit[1] };
        const ident = rest.match(/^name\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
        if (ident) return { kind: "ident", value: ident[1] };
        return null;
      }
    }
    i++;
  }
  return null;
}

const ACTION_DECL_PATTERNS = [
  // const x: Action = { ... }   (optional intersection type suffix)
  /\b(?:export\s+)?const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*Action(?:\s*&\s*\{[\s\S]*?\})?\s*=\s*\{/g,
  // function f(...): Action { ... return { ... } }
  /\b(?:export\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\)\s*:\s*Action\s*\{[\s\S]*?\breturn\s+\{/g,
];

// const x: Action = someFactory("NAME") — alias factories pass the id as the
// first argument (e.g. createViewsAliasAction("CLOSE_ALL_VIEWS")).
const ACTION_FACTORY_PATTERN =
  /\b(?:export\s+)?const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*Action(?:\s*&\s*\{[\s\S]*?\})?\s*=\s*[A-Za-z_$][A-Za-z0-9_$.]*\(\s*"([A-Z][A-Z0-9_]*)"/g;

/**
 * Action ids declared in one source file (UPPER_SNAKE names only). Not covered
 * on purpose: the core response actions (REPLY/NONE/IGNORE/…) take
 * `name: spec.name` from the canonical spec, so they are already guaranteed to
 * be in the catalog's canonical section — consumers must union this inventory
 * with the canonical spec names.
 */
export function extractActionNames(src) {
  const names = new Set();
  if (!src.includes(": Action") && !src.includes(":Action")) return names;
  const consts = collectStringConsts(src);
  for (const pattern of ACTION_DECL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of src.matchAll(pattern)) {
      const braceStart = m.index + m[0].lastIndexOf("{");
      const token = topLevelNameToken(src, braceStart);
      if (!token) continue;
      const value =
        token.kind === "literal" ? token.value : consts.get(token.value);
      if (value && UPPER_SNAKE.test(value)) names.add(value);
    }
  }
  ACTION_FACTORY_PATTERN.lastIndex = 0;
  for (const m of src.matchAll(ACTION_FACTORY_PATTERN)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * View-scoped actions (`BUILTIN_VIEWS[*].scopedActions[*].name`) register as
 * real runtime actions while their view is foreground, so they belong in the
 * inventory even though they are not `: Action` declarations.
 */
function extractScopedActionNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/\bname:\s*"(VIEW_[A-Z0-9_]+)"/g)) {
    names.add(m[1]);
  }
  return names;
}

const SCAN_ROOTS = ["packages/core/src", "packages/agent/src", "plugins"];
const SCOPED_ACTION_FILE = "packages/agent/src/api/builtin-views.ts";

/**
 * Scan the repo for every registered action id.
 * @param {string} repoRoot absolute path to the monorepo root
 * @returns {{ name: string, files: string[] }[]} sorted by name
 */
export function collectRegisteredActionInventory(repoRoot) {
  /** @type {Map<string, Set<string>>} */
  const byName = new Map();
  const record = (name, relFile) => {
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(relFile);
  };

  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(repoRoot, root), [])) {
      const rel = path.relative(repoRoot, file).split(path.sep).join("/");
      // Only plugin/package *source* trees carry registrations.
      if (root === "plugins" && !/^plugins\/[^/]+\/src\//.test(rel)) continue;
      const src = fs.readFileSync(file, "utf8");
      for (const name of extractActionNames(src)) record(name, rel);
    }
  }

  const scopedFile = path.join(repoRoot, SCOPED_ACTION_FILE);
  if (fs.existsSync(scopedFile)) {
    const src = fs.readFileSync(scopedFile, "utf8");
    for (const name of extractScopedActionNames(src)) {
      record(name, SCOPED_ACTION_FILE);
    }
  }

  return [...byName.entries()]
    .map(([name, files]) => ({ name, files: [...files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
