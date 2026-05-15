/**
 * Frontend × Worker gap analysis.
 *
 * For every API path the frontend (cloud/apps/frontend, apps/homepage,
 * cloud/packages/ui, cloud/packages/sdk) references, classify the current
 * Worker capability:
 *
 *   - hono-real  → Worker can serve this with a real implementation.
 *   - hono-stub  → Worker route exists but returns 501 not_yet_migrated.
 *                  Production today still works because the Next.js app at
 *                  cloud/app/api/ serves it.
 *   - next-only  → No Hono peer at this path. Production works today via
 *                  Next.js but the Worker would 404.
 *   - unknown    → Path doesn't match any handler in either tree (probably
 *                  noise from a partial grep, or a path computed at runtime).
 *   - agent-runtime-api → Path targets a self-hosted Eliza agent (baseUrl),
 *                  not the Cloud Worker (e.g. /api/agent/*, /api/wallet/* from
 *                  homepage CloudApiClient); excluded from Worker coverage.
 *
 * Output: writes FRONTEND_GAPS.md alongside this script.
 *
 *   node apps/api/test/_frontend-gaps.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
const CLOUD_ROOT = resolve(API_ROOT, "..", "..");
const ROOT = resolve(CLOUD_ROOT, "..", "..");
const OUTPUT = join(__dirname, "FRONTEND_GAPS.md");

const FRONTEND_DIRS = [
  join(CLOUD_ROOT, "apps", "frontend", "src"),
  join(ROOT, "apps", "homepage", "src"),
  join(CLOUD_ROOT, "packages", "ui", "src"),
  join(CLOUD_ROOT, "packages", "sdk", "src"),
];

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts") || e.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const PATH_RE = /['"`](\/api\/[A-Za-z0-9_/-]+)/g;

const referencedPaths = new Map();
for (const dir of FRONTEND_DIRS) {
  for (const f of walk(dir)) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(PATH_RE)) {
      const path = m[1].replace(/\/+$/, "");
      if (!referencedPaths.has(path)) referencedPaths.set(path, new Set());
      referencedPaths.get(path).add(relative(ROOT, f));
    }
  }
}

// Map mounted Hono routes (paths from the codegen) → handler file.
const routerSrc = readFileSync(join(API_ROOT, "src", "_router.generated.ts"), "utf8");
const honoRoutes = new Map();
for (const m of routerSrc.matchAll(/app\.route\("([^"]+)"\s*,\s*(\w+)\)/g)) {
  honoRoutes.set(m[1], m[2]);
}
// Build regex per Hono route for matching.
function honoToRegex(route) {
  const escaped = route.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const wildcarded = escaped.replace(/:([^/]+)/g, "[^/?#]+").replace(/\\\*/g, ".*");
  return new RegExp(`^${wildcarded}(/[^?]*)?(\\?.*)?$`);
}

// Determine if a Hono route file is a stub (Worker returns 501 for node-only paths).
const STUB_RE =
  /not_yet_migrated|Stubbed at 501|501 on the Worker|501 stub|returns 501 until|not Workers-compatible|NOT_IMPLEMENTED|"reason"\s*:\s*"[^"]*not yet[^"]*"/i;
const honoStubFiles = new Set();
const honoRealFiles = new Set();
function walkApi(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "test" || e === "src" || e.startsWith("_smoke-")) continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkApi(p));
    else if (e === "route.ts") out.push(p);
  }
  return out;
}
for (const f of walkApi(API_ROOT)) {
  const text = readFileSync(f, "utf8");
  if (!/from "hono"/.test(text)) continue;
  if (STUB_RE.test(text)) honoStubFiles.add(f);
  else honoRealFiles.add(f);
}

// Resolve a Hono route pattern → route.ts path on disk (matches codegen layout).
function resolveHonoFile(route) {
  const stripped = route.startsWith("/api/") ? route.slice(5) : route;
  const segments = [];
  for (const seg of stripped.split("/")) {
    if (!seg) continue;
    if (seg.startsWith(":") && (seg.includes("{.+}") || seg.includes("*"))) {
      segments.push("[...path]");
      continue;
    }
    if (seg.startsWith(":")) {
      const param = seg.slice(1).split("{")[0];
      if (param === "*") {
        segments.push("[...path]");
        continue;
      }
      segments.push(`[${param}]`);
      continue;
    }
    segments.push(seg);
  }
  return join(API_ROOT, ...segments, "route.ts");
}

function routeStaticPrefix(route) {
  const parts = [];
  for (const seg of route.split("/")) {
    if (!seg) continue;
    if (seg.startsWith(":") || seg.includes("*")) break;
    parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

function normalizeReferencePath(refPath) {
  if (refPath === "/api/openapi") {
    return "/api/openapi.json";
  }
  return refPath;
}

/** Paths used only against an agent's connection.url (Agent/runtime), not CLOUD_BASE. */
function isAgentRuntimeApiPath(refPath) {
  const r = refPath.replace(/\/+$/, "") || "/";
  const prefixes = [
    "/api/agent",
    "/api/wallet",
    "/api/status",
    "/api/metrics",
    "/api/logs",
    "/api/billing",
  ];
  for (const p of prefixes) {
    if (r === p || r.startsWith(`${p}/`)) return true;
  }
  return false;
}

function classifyByStaticPrefix(refPath) {
  const r = refPath.replace(/\/+$/, "") || "/";
  let exampleRoute = null;
  let realFile = null;
  let stubFile = null;

  for (const route of honoRoutes.keys()) {
    const sp = routeStaticPrefix(route);
    const covers = sp === r || sp.startsWith(r + "/") || r.startsWith(sp + "/");
    if (!covers) continue;

    const file = resolveHonoFile(route);
    if (!existsSync(file)) continue;

    exampleRoute ??= route;
    const rel = relative(API_ROOT, file);
    if (honoStubFiles.has(file)) {
      stubFile ??= rel;
    } else {
      realFile ??= rel;
    }
  }

  if (realFile) {
    return { kind: "hono-real", route: exampleRoute, file: realFile };
  }
  if (stubFile) {
    return { kind: "hono-stub", route: exampleRoute, file: stubFile };
  }
  return null;
}

// Also detect Next-only handlers in the apps/api tree (route.ts files that
// don't import from "hono"). These would be served by the legacy Next.js
// app — never by the Worker.
const nextOnlyByPath = new Map();
for (const f of walkApi(API_ROOT)) {
  const text = readFileSync(f, "utf8");
  if (/from "hono"/.test(text)) continue;
  const rel = relative(API_ROOT, f);
  // Convert e.g. v1/eliza/agents/[agentId]/pairing-token/route.ts
  // → /api/v1/eliza/agents/:agentId/pairing-token
  const segments = rel
    .replace(/\/route\.ts$/, "")
    .split("/")
    .map((s) =>
      s.startsWith("[") && s.endsWith("]") ? `:${s.slice(1, -1).replace(/^\.\.\./, "")}` : s,
    );
  const path = `/api/${segments.join("/")}`;
  nextOnlyByPath.set(path, f);
}

function classify(refPathRaw) {
  const refPath = normalizeReferencePath(refPathRaw);

  for (const [route] of honoRoutes) {
    if (honoToRegex(route).test(refPath)) {
      const file = resolveHonoFile(route);
      if (honoStubFiles.has(file)) {
        return { kind: "hono-stub", route, file: relative(API_ROOT, file) };
      }
      if (honoRealFiles.has(file)) {
        return { kind: "hono-real", route, file: relative(API_ROOT, file) };
      }
      return { kind: "hono-real", route, file: relative(API_ROOT, file) };
    }
  }

  const byPrefix = classifyByStaticPrefix(refPath);
  if (byPrefix) {
    return byPrefix;
  }

  // Next-only fallback — match against next-only paths similarly.
  for (const [nextPath, file] of nextOnlyByPath) {
    const re = (() => {
      const escaped = nextPath.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const wildcarded = escaped.replace(/:([^/]+)/g, "[^/?#]+");
      return new RegExp(`^${wildcarded}(/[^?]*)?(\\?.*)?$`);
    })();
    if (re.test(refPath)) {
      return { kind: "next-only", route: nextPath, file: relative(API_ROOT, file) };
    }
  }
  if (isAgentRuntimeApiPath(refPath)) {
    return { kind: "agent-runtime-api", route: null, file: null };
  }
  return { kind: "unknown", route: null, file: null };
}

const buckets = {
  "hono-real": [],
  "hono-stub": [],
  "next-only": [],
  "agent-runtime-api": [],
  unknown: [],
};
for (const [path, callerSet] of [...referencedPaths.entries()].sort()) {
  const c = classify(path);
  buckets[c.kind].push({ path, callers: [...callerSet], ...c });
}

const lines = [];
lines.push("# Frontend × Worker gap analysis");
lines.push("");
lines.push("Auto-generated. Re-run with `node apps/api/test/_frontend-gaps.mjs`.");
lines.push("");
lines.push(
  "For each `/api/*` path referenced anywhere in the frontend code (frontend " +
    "app, homepage, ui package, sdk package), classify what the Hono Worker " +
    "would do today.",
);
lines.push("");
lines.push("| Bucket | Count | Worker behavior |");
lines.push("| --- | ---: | --- |");
lines.push(`| hono-real | ${buckets["hono-real"].length} | Worker serves this for real. |`);
lines.push(
  `| hono-stub | ${buckets["hono-stub"].length} | Worker returns 501; live Next.js handler still serves it. |`,
);
lines.push(
  `| next-only | ${buckets["next-only"].length} | Worker has no peer; only the live Next.js handler serves it. |`,
);
lines.push(
  `| unknown   | ${buckets.unknown.length} | No Worker/Next handler matched (grep noise or dynamic path). |`,
);
lines.push(
  `| agent-runtime-api | ${buckets["agent-runtime-api"].length} | Agent \`connection.url\` (not Cloud Worker). |`,
);
lines.push("");

for (const bucket of ["hono-stub", "next-only", "agent-runtime-api", "unknown", "hono-real"]) {
  lines.push(`## ${bucket} (${buckets[bucket].length})`);
  lines.push("");
  if (bucket === "hono-real") {
    lines.push("_(elided — these already work)_");
    lines.push("");
    continue;
  }
  for (const e of buckets[bucket]) {
    const handler = e.file ? ` → \`${e.file}\`` : "";
    lines.push(`- \`${e.path}\`${handler}`);
    if (e.callers.length <= 3) {
      lines.push(`  - callers: ${e.callers.map((c) => `\`${c}\``).join(", ")}`);
    } else {
      lines.push(`  - callers: ${e.callers.length} files`);
    }
  }
  lines.push("");
}

writeFileSync(OUTPUT, lines.join("\n"));
console.log(
  JSON.stringify({
    "hono-real": buckets["hono-real"].length,
    "hono-stub": buckets["hono-stub"].length,
    "next-only": buckets["next-only"].length,
    "agent-runtime-api": buckets["agent-runtime-api"].length,
    unknown: buckets.unknown.length,
  }),
);
console.log(`Wrote ${OUTPUT}`);
