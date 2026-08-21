#!/usr/bin/env node
/**
 * Walks `cloud/api/` looking for `route.ts` / `route.tsx` files and emits
 * `src/_router.generated.ts` — one import + one `app.route()` per leaf.
 *
 * Path mapping mirrors Next.js App Router:
 *   api/foo/route.ts            -> /api/foo
 *   api/foo/[id]/route.ts       -> /api/foo/:id
 *   api/foo/[...slug]/route.ts  -> /api/foo/:*{.+}
 *   api/foo/[[...slug]]/route.ts -> /api/foo and /api/foo/:*{.+}
 *   api/(group)/foo/route.ts    -> /api/foo   (group segments dropped)
 *
 * Only leaves whose source is Hono-shaped are mounted — the rest are still
 * Next-shaped and would crash at import time. Hono-shaped means the file
 * imports from "hono" directly or exports a known shared Hono app factory.
 * Unmounted routes fall through to the global 404 handler. A summary is
 * printed at the end.
 *
 * Re-run after adding/removing/converting any route file. Idempotent.
 */

import { promises as fs } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
const OUT_FILE = resolve(__dirname, "_router.generated.ts");
const SCRIPT_PATH = fileURLToPath(import.meta.url);

export async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        continue;
      }
      yield* walk(full);
    } else if (
      entry.isFile() &&
      (entry.name === "route.ts" || entry.name === "route.tsx")
    ) {
      yield full;
    }
  }
}

export function shouldSkipDirectory(name) {
  if (name === "src" || name === "node_modules") return true;
  return name.startsWith(".") && name !== ".well-known";
}

function joinHttpPath(segments) {
  return segments.join("/").replace(/\/+/g, "/");
}

export function fileToHttpPaths(filePath, apiRoot = API_ROOT) {
  const rel = relative(apiRoot, filePath).replace(/\\/g, "/");
  const segments = rel.split("/").slice(0, -1);
  const out = ["/api"];
  for (const seg of segments) {
    if (seg.startsWith("(") && seg.endsWith(")")) continue;
    if (seg.startsWith("[[...") && seg.endsWith("]]")) {
      return [joinHttpPath(out), joinHttpPath([...out, ":*{.+}"])];
    }
    if (seg.startsWith("[...") && seg.endsWith("]")) {
      out.push(":*{.+}");
      continue;
    }
    if (seg.startsWith("[") && seg.endsWith("]")) {
      out.push(`:${seg.slice(1, -1)}`);
      continue;
    }
    out.push(seg);
  }
  return [joinHttpPath(out)];
}

export function importIdent(filePath, apiRoot = API_ROOT) {
  const rel = relative(apiRoot, filePath)
    .replace(/\\/g, "/")
    .replace(/\.tsx?$/, "");
  return (
    "_route_" +
    rel
      .replace(/\//g, "_")
      .replace(/\[\[\.\.\.([^\]]+)\]\]/g, "optional_splat_$1")
      .replace(/\[\.\.\.([^\]]+)\]/g, "splat_$1")
      .replace(/\[([^\]]+)\]/g, "p_$1")
      .replace(/\(([^)]+)\)/g, "g_$1")
      .replace(/[^a-zA-Z0-9_]/g, "_")
  );
}

export function importPath(filePath) {
  const rel = relative(__dirname, filePath)
    .replace(/\\/g, "/")
    .replace(/\.tsx?$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// Match `from "hono"` / `from 'hono'` as an actual ES import token, not a
// substring inside a comment or string. Anchored at start-of-line (allowing
// leading whitespace) so a sentence in a JSDoc block does not trigger.
export const HONO_IMPORT_RE =
  /^\s*(?:import|export)\b[^;]*\bfrom\s*['"]hono['"]/m;
export const HONO_APP_FACTORY_RE =
  /^\s*import\b[^;]*\bcreateMcpsTransportApp\b[^;]*\bfrom\s*['"]@\/api-app\/lib\/mcp\/mcps-transport-gateway['"]/m;

export function isHonoRouteSource(code) {
  return HONO_IMPORT_RE.test(code) || HONO_APP_FACTORY_RE.test(code);
}

export async function isHonoConverted(filePath) {
  const code = await fs.readFile(filePath, "utf8");
  return isHonoRouteSource(code);
}

/**
 * Shard key for a mount path or request pathname. Mirrors
 * `routeShardKey` in `src/router-shards.ts` (the runtime copy) — the two are
 * kept in lockstep by `src/router-shards.test.ts`. `null` means the path has
 * no literal shard-determining segment; such mounts go into every shard.
 */
export function routeShardKey(path) {
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "api") return null;
  const first = segments[1];
  if (!first || first.startsWith(":") || first.includes("*")) return null;
  if (first === "v1") {
    const second = segments[2];
    if (!second || second.startsWith(":") || second.includes("*")) return null;
    return `v1/${second}`;
  }
  return first;
}

function segmentRank(segment) {
  if (segment.startsWith(":") && segment.includes("{.+}")) return 2;
  if (segment.startsWith(":")) return 1;
  return 0;
}

export function compareMountPaths(a, b) {
  const aSegments = a.path.split("/").filter(Boolean);
  const bSegments = b.path.split("/").filter(Boolean);
  const max = Math.max(aSegments.length, bSegments.length);

  for (let i = 0; i < max; i++) {
    const aSegment = aSegments[i];
    const bSegment = bSegments[i];
    if (aSegment === undefined) return 1;
    if (bSegment === undefined) return -1;

    const rankDiff = segmentRank(aSegment) - segmentRank(bSegment);
    if (rankDiff !== 0) return rankDiff;

    if (aSegment !== bSegment) return aSegment.localeCompare(bSegment);
  }

  return a.path.localeCompare(b.path);
}

export async function collectRouteEntries(apiRoot = API_ROOT) {
  const files = [];
  for await (const f of walk(apiRoot)) files.push(f);
  files.sort();

  const seen = new Map();
  const entries = [];
  const unmountedFiles = [];
  let unconverted = 0;
  for (const f of files) {
    const paths = fileToHttpPaths(f, apiRoot);
    for (const path of paths) {
      if (seen.has(path)) {
        console.warn(
          `[codegen] duplicate route path ${path} from ${f} and ${seen.get(path)}`,
        );
      }
      seen.set(path, f);
    }

    const converted = await isHonoConverted(f);
    if (!converted) {
      unconverted++;
      unmountedFiles.push(f);
      continue;
    }

    const ident = importIdent(f, apiRoot);
    const importSource = importPath(f);
    for (const path of paths) {
      entries.push({ path, ident, import: importSource });
    }
  }

  entries.sort(compareMountPaths);
  return { files, entries, unconverted, unmountedFiles };
}

export async function generateRouter() {
  const { entries, unconverted, unmountedFiles } = await collectRouteEntries();
  const shardKeys = [
    ...new Set(
      entries
        .map((entry) => routeShardKey(entry.path))
        .filter((key) => key !== null),
    ),
  ].sort();

  const banner = [
    "/**",
    " * AUTO-GENERATED by src/_generate-router.mjs - do not edit by hand.",
    " * Re-run `bun run codegen` after adding or removing a route.ts file.",
    " *",
    ` * ${entries.length} routes mounted across ${shardKeys.length} lazy shards,`,
    ` * ${unconverted} skipped (still Next-shaped). Route modules are imported`,
    " * dynamically so a request only evaluates the shard that can match its",
    " * path (issue #22550); a null-shard mount goes into every shard app.",
    " */",
    "",
    "/* eslint-disable */",
    "// biome-ignore-all assist/source/organizeImports: generated imports are ordered by route codegen.",
    "",
    'import type { Hono } from "hono";',
    'import type { AppEnv } from "@/types/cloud-worker-env";',
    "",
  ].join("\n");

  const mounts = entries.map((entry) => mountEntry(entry)).join("\n");

  const body = [
    banner,
    "export interface GeneratedRouteMount {",
    "  readonly path: string;",
    "  readonly shard: string | null;",
    "  readonly load: () => Promise<{ readonly default: Hono<AppEnv> }>;",
    "}",
    "",
    "export const ROUTE_MOUNTS: readonly GeneratedRouteMount[] = [",
    mounts,
    "];",
    "",
    "export const ROUTE_SHARD_KEYS: readonly string[] = [",
    shardKeys.map((key) => `  ${JSON.stringify(key)},`).join("\n"),
    "];",
    "",
    "async function mountSelected(",
    "  app: Hono<AppEnv>,",
    "  mounts: readonly GeneratedRouteMount[],",
    "): Promise<void> {",
    "  const modules = await Promise.all(mounts.map((mount) => mount.load()));",
    "  mounts.forEach((mount, index) => {",
    "    app.route(mount.path, modules[index].default);",
    "  });",
    "}",
    "",
    "/** Mount only the routes that can match paths in `shard` (plus shared mounts). */",
    "export async function mountShardRoutes(",
    "  app: Hono<AppEnv>,",
    "  shard: string | null,",
    "): Promise<void> {",
    "  return mountSelected(",
    "    app,",
    "    ROUTE_MOUNTS.filter(",
    "      (mount) => mount.shard === null || mount.shard === shard,",
    "    ),",
    "  );",
    "}",
    "",
    "/** Mount the complete generated route tree (tests, dev server, cron fallback). */",
    "export async function mountRoutes(app: Hono<AppEnv>): Promise<void> {",
    "  return mountSelected(app, ROUTE_MOUNTS);",
    "}",
    "",
  ].join("\n");

  await fs.writeFile(OUT_FILE, body, "utf8");
  console.log(
    `[codegen] wrote ${OUT_FILE} (${entries.length} mounted, ${shardKeys.length} shards, ${unconverted} unconverted)`,
  );
  if (unconverted > 0) {
    console.error(
      '[codegen] Unmounted route.ts files (add `from "hono"` import or delete):\n',
      unmountedFiles.join("\n"),
    );
    process.exit(1);
  }
}

/**
 * Emit the `load` property pre-wrapped the way Biome's 80-column formatter
 * would. Without this the generated file is reformatted by `bun run lint`,
 * so `codegen` and `lint` would fight each other in CI.
 */
function loadLines(importSource) {
  const source = JSON.stringify(importSource);
  const single = `    load: () => import(${source}),`;
  if (single.length <= 80) return [single];

  const wrapped = `      import(${source}),`;
  if (wrapped.length <= 80) return ["    load: () =>", wrapped];

  return ["    load: () =>", "      import(", `        ${source}`, "      ),"];
}

function mountEntry(entry) {
  const shard = routeShardKey(entry.path);
  return [
    "  {",
    `    path: ${JSON.stringify(entry.path)},`,
    `    shard: ${shard === null ? "null" : JSON.stringify(shard)},`,
    ...loadLines(entry.import),
    "  },",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  generateRouter().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
