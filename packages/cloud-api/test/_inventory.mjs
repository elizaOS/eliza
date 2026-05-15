/**
 * Per-route inventory of cloud/apps/api/.
 *
 * Categorizes every route.ts file into:
 *   - hono-real:   Hono-shaped route AND does NOT return a 501
 *                  "Not implemented on Workers" / "not_yet_migrated" body.
 *   - hono-stub:   Hono-shaped route AND returns the migration stub.
 *   - next-only:   is not Hono-shaped (Next-shaped App Router handler);
 *                  no Hono peer at the same path. Won't run on the Worker.
 *   - dead-next:   is not Hono-shaped; a Hono peer exists at the same
 *                  path. Dead code in the Worker tree — should be removed once
 *                  the Hono peer reaches parity.
 *
 * Output: writes INVENTORY.md alongside this script.
 *
 *   node apps/api/test/_inventory.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectRouteEntries,
  fileToHttpPaths,
  isHonoRouteSource,
} from "../src/_generate-router.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, "..");
const ROUTER = join(API_ROOT, "src", "_router.generated.ts");
const OUTPUT = join(__dirname, "INVENTORY.md");

const STUB_RE = /not_yet_migrated|Not implemented on Workers/;
const routerSrc = readFileSync(ROUTER, "utf8");
const generatedRoutes = [...routerSrc.matchAll(/app\.route\(\s*"([^"]+)"/g)].map((m) => m[1]);
const { files, entries } = await collectRouteEntries(API_ROOT);
const expectedMountedRoutes = entries.map((entry) => entry.path);

const inventory = files.map((p) => {
  const text = readFileSync(p, "utf8");
  const isHono = isHonoRouteSource(text);
  const isStub = STUB_RE.test(text);
  let kind;
  if (isHono) kind = isStub ? "hono-stub" : "hono-real";
  else kind = "next"; // refined below
  return {
    path: p,
    rel: relative(API_ROOT, p),
    kind,
    isStub,
    httpPaths: fileToHttpPaths(p, API_ROOT),
  };
});

// Detect dead-next: a non-Hono file at the same directory as a Hono peer.
// In practice, the migration places Hono handlers next to Next ones in the
// same directory tree, so a dead-next is a directory containing both shapes.
const dirHasHono = new Map();
for (const f of inventory) {
  const dir = dirname(f.path);
  if (f.kind === "hono-real" || f.kind === "hono-stub") dirHasHono.set(dir, true);
}
for (const f of inventory) {
  if (f.kind === "next") {
    f.kind = dirHasHono.get(dirname(f.path)) ? "dead-next" : "next-only";
  }
}

const counts = inventory.reduce(
  (acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  },
  { "hono-real": 0, "hono-stub": 0, "next-only": 0, "dead-next": 0 },
);

const grouped = {
  "hono-real": [],
  "hono-stub": [],
  "next-only": [],
  "dead-next": [],
};
for (const f of inventory.sort((a, b) => a.rel.localeCompare(b.rel))) {
  grouped[f.kind].push(f.rel);
}

const generatedSet = new Set(generatedRoutes);
const expectedSet = new Set(expectedMountedRoutes);
const missingFromGenerated = expectedMountedRoutes.filter((path) => !generatedSet.has(path));
const staleGenerated = generatedRoutes.filter((path) => !expectedSet.has(path));
const orderMatches =
  generatedRoutes.length === expectedMountedRoutes.length &&
  generatedRoutes.every((path, index) => path === expectedMountedRoutes[index]);

const lines = [];
lines.push("# `apps/api/` route inventory");
lines.push("");
lines.push("Auto-generated. Re-run with `node apps/api/test/_inventory.mjs`.");
lines.push("");
lines.push(`Total \`route.ts\` / \`route.tsx\` files: **${inventory.length}**`);
lines.push(`Generated mounted routes: **${generatedRoutes.length}**`);
lines.push(`Expected mounted routes from current generator: **${expectedMountedRoutes.length}**`);
lines.push(`Generated order matches generator: **${orderMatches ? "yes" : "no"}**`);
lines.push("");
lines.push("| Bucket | Count | Meaning |");
lines.push("| --- | ---: | --- |");
lines.push(
  `| hono-real | ${counts["hono-real"]} | Hono handler with a real implementation; mounted by codegen. |`,
);
lines.push(
  `| hono-stub | ${counts["hono-stub"]} | Hono handler returning \`501 not_yet_migrated\` / "Not implemented on Workers". Mounted, but does nothing. |`,
);
lines.push(
  `| next-only | ${counts["next-only"]} | Next-shaped handler with no Hono peer. Dead code on the Worker — never served from \`apps/api/\`. The live Next.js app at \`cloud/app/api/\` is what serves these in production. |`,
);
lines.push(
  `| dead-next | ${counts["dead-next"]} | Next-shaped handler at the same path as a Hono one. Pure dead code in \`apps/api/\` — delete once the Hono peer reaches parity. |`,
);
lines.push("");
lines.push("## Generated router parity");
lines.push("");
if (missingFromGenerated.length === 0 && staleGenerated.length === 0 && orderMatches) {
  lines.push("Generated router is in sync with the current generator and route tree.");
} else {
  lines.push("Generated router is stale. Re-run `node apps/api/src/_generate-router.mjs`.");
}
lines.push("");
lines.push(`### Missing from generated (${missingFromGenerated.length})`);
lines.push("");
for (const route of missingFromGenerated) lines.push(`- \`${route}\``);
lines.push("");
lines.push(`### Stale generated routes (${staleGenerated.length})`);
lines.push("");
for (const route of staleGenerated) lines.push(`- \`${route}\``);
lines.push("");
for (const bucket of ["hono-stub", "dead-next", "next-only", "hono-real"]) {
  lines.push(`## ${bucket} (${grouped[bucket].length})`);
  lines.push("");
  for (const r of grouped[bucket]) lines.push(`- \`${r}\``);
  lines.push("");
}

writeFileSync(OUTPUT, lines.join("\n"));
console.log(JSON.stringify(counts));
console.log(`Wrote ${OUTPUT}`);
