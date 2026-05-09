#!/usr/bin/env bun

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { build } from "bun";

const ROOT = resolve(dirname(import.meta.path));
const DIST = join(ROOT, "dist");

if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true, force: true });
}
mkdirSync(DIST, { recursive: true });
mkdirSync(join(DIST, "node"), { recursive: true });
mkdirSync(join(DIST, "browser"), { recursive: true });
mkdirSync(join(DIST, "cjs"), { recursive: true });
mkdirSync(join(DIST, "drizzle"), { recursive: true });

const nodeExternals = [
  "dotenv",
  "@reflink/reflink",
  "@node-llama-cpp",
  "agentkeepalive",
  "uuid",
  "@elizaos/core",
  "@electric-sql/pglite",
  "zod",
  "fs",
  "path",
  "postgres",
  "pg",
  "pg-native",
  "libpq",
  "drizzle-orm",
  "drizzle-orm/pg-core",
  "drizzle-orm/pglite",
  "drizzle-orm/neon-http",
];

console.log("Building Node.js ESM bundle...");
await build({
  entrypoints: [join(ROOT, "index.ts")],
  outdir: join(DIST, "node"),
  target: "node",
  format: "esm",
  splitting: false,
  sourcemap: "linked",
  minify: false,
  external: nodeExternals,
  naming: {
    entry: "index.node.js",
  },
});

console.log("Building Browser ESM bundle...");
await build({
  entrypoints: [join(ROOT, "index.browser.ts")],
  outdir: join(DIST, "browser"),
  target: "browser",
  format: "esm",
  splitting: false,
  sourcemap: "linked",
  minify: false,
  external: [
    "@elizaos/core",
    "@electric-sql/pglite",
    "@electric-sql/pglite/vector",
    "@electric-sql/pglite/contrib/fuzzystrmatch",
    "drizzle-orm",
    "drizzle-orm/pglite",
  ],
  naming: {
    entry: "index.browser.js",
  },
});

console.log("Building CJS bundle...");
await build({
  entrypoints: [join(ROOT, "index.ts")],
  outdir: join(DIST, "cjs"),
  target: "node",
  format: "cjs",
  splitting: false,
  sourcemap: "linked",
  minify: false,
  external: nodeExternals,
  naming: {
    entry: "index.node.cjs",
  },
});

console.log("Generating TypeScript declarations...");
{
  const { $ } = await import("bun");
  await $`tsc --noCheck --project tsconfig.build.node.json`.quiet();
}

// Ensure declaration entry points
const reexportNode = `export * from '../index.node.js';\nexport { default } from '../index.node.js';\n`;
const reexportBrowser = `export * from '../index.browser.js';\nexport { default } from '../index.browser.js';\n`;
const reexportRoot = `export * from './index.node.js';\nexport { default } from './index.node.js';\nexport * from './schema/index.js';\nexport type { DrizzleDatabase } from './types.js';\n`;
const reexportRootRuntime = `export * from './node/index.node.js';\nexport { default } from './node/index.node.js';\n`;

await writeFile(join(DIST, "node", "index.d.ts"), reexportNode);
await writeFile(join(DIST, "node", "index.node.d.ts"), reexportNode);
await writeFile(join(DIST, "browser", "index.d.ts"), reexportBrowser);
await writeFile(join(DIST, "browser", "index.browser.d.ts"), reexportBrowser);
await writeFile(join(DIST, "cjs", "index.d.ts"), reexportNode);
await writeFile(join(DIST, "cjs", "index.node.d.cts"), reexportNode);
await writeFile(join(DIST, "index.d.ts"), reexportRoot);
await writeFile(join(DIST, "index.js"), reexportRootRuntime);
await writeFile(
  join(DIST, "drizzle", "index.d.ts"),
  `export { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, type SQL, sql } from 'drizzle-orm';\n`
);
await writeFile(
  join(DIST, "drizzle", "index.js"),
  `export { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';\n`
);
await appendFile(
  join(DIST, "index.node.d.ts"),
  `\nexport * from './schema/index.js';\nexport type { DrizzleDatabase } from './types.js';\n`
);

console.log("Build complete!");
