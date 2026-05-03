/**
 * Coverage audit — cross-references the Hono router (apps/api/src/_router.generated.ts)
 * against e2e tests living at cloud/packages/tests/e2e/.
 *
 * Run from repo root or anywhere — paths are resolved relative to this file.
 * Output: writes COVERAGE.md next to itself.
 *
 *   node apps/api/test/_audit-coverage.mjs
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
const CLOUD_ROOT = resolve(API_ROOT, "..", "..");
const ROUTER = join(API_ROOT, "src", "_router.generated.ts");
const E2E_ROOTS = [join(CLOUD_ROOT, "packages", "tests", "e2e"), join(API_ROOT, "test", "e2e")];
const OUTPUT = join(__dirname, "COVERAGE.md");

const routerSrc = readFileSync(ROUTER, "utf8");
const routes = [];
for (const m of routerSrc.matchAll(/app\.route\(\s*"([^"]+)"/g)) routes.push(m[1]);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const testFiles = E2E_ROOTS.flatMap(walk);
const tests = testFiles.map((p) => ({ path: p, text: readFileSync(p, "utf8") }));

function honoToRegex(route) {
  const source = route
    .split("/")
    .map((segment, index) => {
      if (index === 0) return "";
      if (segment.startsWith(":") && segment.includes("{.+}")) return ".+";
      if (segment.startsWith(":")) return "[^/?#]+";
      return segment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${source}(/[^"]*)?(\\?[^"]*)?$`);
}

/**
 * Static prefix of a route — everything up to (but not including) the first
 * `:param` segment. Used as a loose match so template literals like
 * `\`/api/mcps/${provider}/mcp\`` count toward coverage.
 *
 *   /api/mcps/airtable/:transport       → /api/mcps/airtable/
 *   /api/v1/agents/:agentId/logs        → /api/v1/agents/
 *   /api/health                          → /api/health
 */
function staticPrefix(route) {
  const colonIdx = route.indexOf("/:");
  if (colonIdx === -1) return route;
  return route.slice(0, colonIdx + 1);
}

function localPath(p) {
  return p.split("/apps/api/test/e2e/")[1] ?? p.split("/packages/tests/e2e/")[1] ?? p;
}

const covered = [];
const uncovered = [];
for (const route of routes) {
  const re = honoToRegex(route);
  const prefix = staticPrefix(route);
  const isPrefixUseful = prefix.length > "/api/".length + 1;
  const hits = new Set();
  for (const t of tests) {
    let matched = false;
    for (const m of t.text.matchAll(/"(\/api\/[^"]+)"/g)) {
      if (re.test(m[1])) {
        hits.add(localPath(t.path));
        matched = true;
        break;
      }
    }
    // Fallback: route's static prefix appears anywhere (template literals,
    // dynamic URL builders). Skip too-generic prefixes like `/api/`.
    if (!matched && isPrefixUseful && t.text.includes(prefix)) {
      hits.add(localPath(t.path));
      matched = true;
    }
    // Loop-coverage fallback: tests that iterate over a provider/segment list
    // — e.g. `for (const provider of [...]) ` /api/mcps/${provider}/${tr}` `.
    // Recognize coverage when the parent prefix appears AND the route's first
    // `:`-bearing segment value (the literal between the last static segment
    // and `:`) is referenced as a quoted token.
    if (!matched) {
      const firstColonAt = route.indexOf("/:");
      if (firstColonAt !== -1) {
        const before = route.slice(0, firstColonAt);
        const lastSlash = before.lastIndexOf("/");
        const parent = before.slice(0, lastSlash + 1);
        const segment = before.slice(lastSlash + 1);
        if (
          parent.length > "/api/".length + 1 &&
          segment.length > 0 &&
          t.text.includes(parent) &&
          new RegExp(`["'\`]${segment}["'\`]`).test(t.text)
        ) {
          hits.add(localPath(t.path));
        }
      }
    }
  }
  if (hits.size > 0) covered.push({ route, files: [...hits] });
  else uncovered.push(route);
}

const lines = [];
lines.push("# Hono Worker Route Coverage Audit");
lines.push("");
lines.push("Auto-generated. Re-run with `node apps/api/test/_audit-coverage.mjs`.");
lines.push("");
lines.push(`- Mounted routes: **${routes.length}**`);
lines.push(
  `- Covered (path appears in at least one Next-targeted e2e test): **${covered.length}**`,
);
lines.push(`- Uncovered: **${uncovered.length}**`);
lines.push("");
lines.push(
  '> Note: "covered" here means the path appears in a test file under ' +
    "`cloud/packages/tests/e2e/`. Those tests target the legacy Next.js app, not " +
    "the Hono Worker built from `apps/api/`. Even covered routes need a Worker-" +
    "targeted run to confirm the migrated implementation works end-to-end.",
);
lines.push("");
lines.push(`## Uncovered (${uncovered.length})`);
lines.push("");
for (const r of uncovered) lines.push(`- \`${r}\``);
lines.push("");
lines.push(`## Covered (${covered.length})`);
lines.push("");
for (const c of covered) lines.push(`- \`${c.route}\` — ${c.files.join(", ")}`);
lines.push("");

writeFileSync(OUTPUT, lines.join("\n"));
console.log(
  `Mounted: ${routes.length}, Covered: ${covered.length}, Uncovered: ${uncovered.length}`,
);
console.log(`Wrote ${OUTPUT}`);
