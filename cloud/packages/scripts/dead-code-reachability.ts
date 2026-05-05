/**
 * Static reachability audit: BFS from real entry points (Next route files,
 * config, package.json script targets, service mains). No Knip.
 *
 * Run: bun run packages/scripts/dead-code-reachability.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

const NEXT_ROUTE_BASENAMES = new Set([
  "page",
  "layout",
  "route",
  "loading",
  "error",
  "template",
  "default",
  "not-found",
  "global-error",
  "opengraph-image",
  "twitter-image",
  "icon",
  "apple-icon",
  "sitemap",
  "robots",
  "manifest",
]);

/** Do not list generic names like "build" — App Router uses segments e.g. app/.../build/page.tsx */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".next-build",
  ".next-dev",
  ".next-analyze",
  "dist",
  "coverage",
  "out",
]);

function walkDirs(
  dir: string,
  pred: (abs: string, rel: string) => boolean,
  acc: string[] = [],
): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    const rel = toRepoRelative(abs);
    if (st.isDirectory()) walkDirs(abs, pred, acc);
    else if (pred(abs, rel)) acc.push(abs);
  }
  return acc;
}

function toRepoRelative(abs: string): string {
  return relative(ROOT, abs).replaceAll("\\", "/");
}

function isCandidateSource(abs: string, rel: string): boolean {
  if (!/\.(tsx?|mts|cts)$/.test(abs)) return false;
  if (rel.includes("/node_modules/")) return false;
  if (rel.endsWith(".d.ts")) return false;
  if (rel.includes("__tests__/")) return false;
  if (rel.includes(".stories.")) return false;
  if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) return false;
  return true;
}

function collectCandidates(): string[] {
  const acc: string[] = [];
  const roots = [
    join(ROOT, "app"),
    join(ROOT, "packages/lib"),
    join(ROOT, "packages/db"),
    join(ROOT, "packages/ui/src"),
    join(ROOT, "packages/scripts"),
    join(ROOT, "packages/types"),
    join(ROOT, "services/agent-server/src"),
    join(ROOT, "services/operator"),
    join(ROOT, "packages/services/gateway-discord/src"),
    join(ROOT, "packages/services/gateway-webhook"),
  ];
  for (const r of roots) walkDirs(r, isCandidateSource, acc);
  for (const f of ["drizzle.config.ts"]) {
    const p = join(ROOT, f);
    if (existsSync(p)) acc.push(p);
  }
  return [...new Set(acc)].sort();
}

function isNextAppEntry(abs: string): boolean {
  const rel = toRepoRelative(abs);
  if (!rel.startsWith("app/")) return false;
  const base = abs.replace(/\.(tsx?|mts|cts)$/, "");
  const name = basename(base);
  return NEXT_ROUTE_BASENAMES.has(name);
}

function walkAppRouteFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walkAppRouteFiles(abs, out);
    else if (isNextAppEntry(abs)) out.push(abs);
  }
}

function collectRootEntries(): string[] {
  const entries: string[] = [];
  walkAppRouteFiles(join(ROOT, "app"), entries);
  for (const f of ["drizzle.config.ts"]) {
    const p = join(ROOT, f);
    if (existsSync(p)) entries.push(p);
  }
  const pkgPath = join(ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scriptStr = JSON.stringify(pkg.scripts ?? {});
  const re = /(?:^|[\s'"`])((?:packages\/scripts\/|scripts\/)[^\s'"`]+\.(?:ts|tsx))(?:\s|$|['"`])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scriptStr)) !== null) {
    const p = join(ROOT, m[1]);
    if (existsSync(p)) entries.push(p);
  }
  entries.push(join(ROOT, "packages/ui/src/index.ts"));
  entries.push(join(ROOT, "services/agent-server/src/index.ts"));
  entries.push(join(ROOT, "packages/services/gateway-discord/src/index.ts"));
  const pepr = join(ROOT, "services/operator/pepr.ts");
  if (existsSync(pepr)) entries.push(pepr);
  const gwMain = join(ROOT, "packages/services/gateway-webhook/src/index.ts");
  if (existsSync(gwMain)) entries.push(gwMain);
  return [...new Set(entries)];
}

function mapSpecifierToPath(fromFile: string, spec: string): string | null {
  const trimmed = spec.trim();
  const isSupportedWorkspaceAlias =
    trimmed === "@elizaos/cloud-ui" || trimmed.startsWith("@elizaos/cloud-ui/");
  if (
    trimmed.startsWith("node:") ||
    trimmed === "react" ||
    trimmed === "react-dom" ||
    trimmed === "next" ||
    trimmed.startsWith("next/")
  ) {
    return null;
  }
  if (!trimmed.startsWith(".") && !trimmed.startsWith("@/") && !isSupportedWorkspaceAlias) {
    return null;
  }
  if (trimmed === "@elizaos/cloud-ui") {
    return join(ROOT, "packages/ui/src/index.ts");
  }
  if (trimmed.startsWith("@elizaos/cloud-ui/")) {
    return join(ROOT, "packages/ui/src", trimmed.slice("@elizaos/cloud-ui/".length));
  }
  if (trimmed.startsWith("@/lib/")) {
    return join(ROOT, "packages/lib", trimmed.slice("@/lib/".length));
  }
  if (trimmed.startsWith("@/db/")) {
    return join(ROOT, "packages/db", trimmed.slice("@/db/".length));
  }
  if (trimmed.startsWith("@/tests/")) {
    return join(ROOT, "packages/tests", trimmed.slice("@/tests/".length));
  }
  if (trimmed.startsWith("@/types/")) {
    return join(ROOT, "packages/types", trimmed.slice("@/types/".length));
  }
  if (trimmed.startsWith("@/components/")) {
    return join(ROOT, "packages/ui/src/components", trimmed.slice("@/components/".length));
  }
  if (trimmed.startsWith("@/")) {
    return join(ROOT, trimmed.slice(2));
  }
  if (trimmed.startsWith(".")) {
    return normalize(resolve(dirname(fromFile), trimmed));
  }
  return null;
}

function tryResolveFile(basePath: string): string | null {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.mts`,
    `${basePath}.cts`,
    join(basePath, "index.ts"),
    join(basePath, "index.tsx"),
    join(basePath, "index.mts"),
    join(basePath, "index.cts"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Path-like specifiers only (relative, @/, @elizaos/). Skips bare npm packages. */
const RE_FROM = /\bfrom\s+['"]((?:\.{1,2}\/|@\/|@elizaos\/)[^'"]+)['"]/g;
/** Side-effect: import "@/foo"; (no named binding / no "from") */
const RE_IMPORT_SIDE = /(?:^|[;\n])\s*import\s+['"]((?:\.{1,2}\/|@\/|@elizaos\/)[^'"]+)['"]\s*;?/gm;
const RE_IMPORT_CALL = /import\s*\(\s*['"]((?:\.{1,2}\/|@\/|@elizaos\/)[^'"]+)['"]\s*\)/g;
const RE_EXPORT_STAR = /export\s+\*\s+from\s+['"]((?:\.{1,2}\/|@\/|@elizaos\/)[^'"]+)['"]/g;
const RE_EXPORT_NAMED = /export\s*\{[^}]+\}\s+from\s+['"]((?:\.{1,2}\/|@\/|@elizaos\/)[^'"]+)['"]/g;
const RE_EXPORT_NAMED_TYPE =
  /export\s+type\s+\{[^}]+\}\s+from\s+['"]((?:\.{1,2}\/|@\/|@elizaos\/)[^'"]+)['"]/g;

function extractSpecifiers(source: string): string[] {
  const out: string[] = [];
  const run = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.push(m[1]);
  };
  run(RE_FROM);
  run(RE_IMPORT_SIDE);
  run(RE_IMPORT_CALL);
  run(RE_EXPORT_STAR);
  run(RE_EXPORT_NAMED);
  run(RE_EXPORT_NAMED_TYPE);
  return out;
}

function bfs(entries: string[]): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const e of entries) {
    const r = existsSync(e) && statSync(e).isFile() ? e : tryResolveFile(e);
    if (r) {
      visited.add(r);
      queue.push(r);
    }
  }
  while (queue.length > 0) {
    const file = queue.pop()!;
    try {
      const source = readFileSync(file, "utf8");
      for (const spec of extractSpecifiers(source)) {
        const mapped = mapSpecifierToPath(file, spec);
        if (!mapped) continue;
        const resolved = tryResolveFile(mapped);
        if (!resolved) continue;
        if (!visited.has(resolved)) {
          visited.add(resolved);
          queue.push(resolved);
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return visited;
}

function walkMatch(dir: string, match: (abs: string, rel: string) => boolean, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    const rel = toRepoRelative(abs);
    if (st.isDirectory()) walkMatch(abs, match, out);
    else if (match(abs, rel)) out.push(abs);
  }
}

function collectTestEntries(): string[] {
  const entries: string[] = [];
  walkMatch(
    join(ROOT, "packages/tests"),
    (abs, rel) => rel.endsWith(".test.ts") || rel.endsWith(".test.tsx"),
    entries,
  );
  walkMatch(
    join(ROOT, "packages/lib"),
    (abs, rel) => rel.endsWith(".test.ts") || (rel.includes("__tests__/") && abs.endsWith(".ts")),
    entries,
  );
  walkMatch(
    join(ROOT, "packages/services"),
    (abs, rel) => rel.endsWith(".test.ts") || rel.includes("/tests/"),
    entries,
  );
  walkMatch(
    join(ROOT, "app"),
    (abs, rel) => rel.endsWith(".test.ts") || rel.includes("__tests__/"),
    entries,
  );
  const preload = join(ROOT, "packages/tests/load-env.ts");
  if (existsSync(preload)) entries.push(preload);
  const preloadE2e = join(ROOT, "packages/tests/e2e/preload.ts");
  if (existsSync(preloadE2e)) entries.push(preloadE2e);
  return [...new Set(entries)];
}

function main(): void {
  const candidates = new Set(collectCandidates());
  const prodEntries = collectRootEntries();
  const prodReach = bfs(prodEntries);
  const prodDead = [...candidates].filter((c) => !prodReach.has(c)).sort();

  const testEntries = [...prodEntries, ...collectTestEntries()];
  const testReach = bfs(testEntries);
  const testOnlyDead = [...candidates].filter((c) => !testReach.has(c)).sort();

  const appNonRouteDead = prodDead.filter((p) => {
    const rel = toRepoRelative(p);
    return rel.startsWith("app/") && !isNextAppEntry(p);
  });

  console.log("=== Dead code reachability audit (static import graph) ===\n");
  console.log(`Root: ${ROOT}`);
  console.log(
    `Production entry points: ${prodEntries.length} (Next route files + configs + script refs + UI barrel + services)`,
  );
  console.log(`Candidate source files in scope: ${candidates.size}\n`);

  console.log("--- Limits ---");
  console.log(
    "Dynamic import(string), require(variable), next/dynamic with variables, and runtime-only loads are not traced.",
  );
  console.log("Barrels: export * / export {} from in visited files ARE followed.\n");

  console.log(`--- A) Unreachable from production graph (${prodDead.length} files) ---`);
  for (const p of prodDead) console.log(relative(ROOT, p));

  console.log(
    `\n--- B) App segments: non-route TS/TSX unreachable from prod (${appNonRouteDead.length}) ---`,
  );
  for (const p of appNonRouteDead) console.log(relative(ROOT, p));

  console.log(
    `\n--- C) Still unreachable when adding test files as entries (${testOnlyDead.length}) ---`,
  );
  for (const p of testOnlyDead) console.log(relative(ROOT, p));
}

main();
