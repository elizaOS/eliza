#!/usr/bin/env node
/**
 * patch-tsup-dts.mjs
 *
 * tsup 8.5.1's rollup-plugin-dts integration hard-codes `baseUrl: "."` when
 * no explicit baseUrl is set. TypeScript 6.0 deprecated `baseUrl` and emits
 * TS5101 when it is injected unconditionally.
 *
 * On macOS, Rollup's native optional dependency can also fail code-signature
 * validation under newer Node runtimes. This repository pins Rollup to the WASM
 * package, so patch tsup's runtime Rollup requires to use that package directly.
 *
 * Bun may install multiple physical copies of tsup (workspace-root patch,
 * `.bun` cache trees, and per-package `node_modules/tsup`). Patch every copy's
 * `dist/rollup.js` so DTS builds stay compatible with TypeScript 6+ without
 * `ignoreDeprecations`.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

const BASE_URL_NEEDLE = 'baseUrl: compilerOptions.baseUrl || ".",';
const BASE_URL_REPLACEMENT =
  "// Patched: do not inject `baseUrl` (deprecated in TS 6.0). Preserve any\n" +
  "            // explicit user-set baseUrl from `compilerOptions` via the spread above.";

const ROLLUP_RUNTIME_REPLACEMENTS = [
  {
    needle: "var _rollup = require('rollup');",
    replacement: "var _rollup = require('@rollup/wasm-node');",
  },
  {
    needle: 'require("rollup")',
    replacement: 'require("@rollup/wasm-node")',
  },
];

const ROLLUP_RUNTIME_BLOCK =
  `async function runRollup(options) {\n` +
  `  const { rollup } = await Promise.resolve().then(() => _interopRequireWildcard(require("@rollup/wasm-node")));\n` +
  `  try {\n` +
  `    const start = Date.now();\n` +
  `    const getDuration = () => \`\${Date.now() - start}ms\`;\n` +
  `    logger.info("dts", "Build start");\n` +
  `    const bundle = await rollup(options.inputConfig);\n` +
  `    const results = await Promise.all(options.outputConfig.map(bundle.write));\n` +
  `    const outputs = results.flatMap((result) => result.output);\n` +
  `    logger.success("dts", \`\\u26A1\\uFE0F Build success in \${getDuration()}\`);\n` +
  `    _chunkVGC3FXLUjs.reportSize.call(void 0, \n` +
  `      logger,\n` +
  `      "dts",\n` +
  `      outputs.reduce((res, info) => {\n` +
  `        const name = _path2.default.relative(\n` +
  `          process.cwd(),\n` +
  `          _path2.default.join(options.outputConfig[0].dir || ".", info.fileName)\n` +
  `        );\n` +
  `        return {\n` +
  `          ...res,\n` +
  `          [name]: info.type === "chunk" ? info.code.length : info.source.length\n` +
  `        };\n` +
  `      }, {})\n` +
  `    );\n` +
  `  } catch (error) {\n` +
  `    _chunkJZ25TPTYjs.handleError.call(void 0, error);\n` +
  `    logger.error("dts", "Build error");\n` +
  `  }\n` +
  `}\n` +
  `async function watchRollup(options) {\n` +
  `  const { watch } = await Promise.resolve().then(() => _interopRequireWildcard(require("@rollup/wasm-node")));\n` +
  `  watch({\n` +
  `    ...options.inputConfig,\n` +
  `    plugins: options.inputConfig.plugins,\n` +
  `  }).on("event", (event) => {\n` +
  `    if (event.code === "START") {\n` +
  `      logger.info("dts", "Build start");\n` +
  `    } else if (event.code === "BUNDLE_END") {\n` +
  `      logger.success("dts", \`\\u26A1\\uFE0F Build success in \${event.duration}ms\`);\n` +
  `      _optionalChain([_worker_threads.parentPort, 'optionalAccess', _18 => _18.postMessage, 'call', _19 => _19("success")]);\n` +
  `    } else if (event.code === "ERROR") {\n` +
  `      logger.error("dts", "Build failed");\n` +
  `      _chunkJZ25TPTYjs.handleError.call(void 0, event.error);\n` +
  `    }\n` +
  `  });\n` +
  `}`;

/** @param {string} rollupPath */
function patchFile(rollupPath) {
  let src = readFileSync(rollupPath, "utf8");
  let next = src;

  next = next.replace(BASE_URL_NEEDLE, BASE_URL_REPLACEMENT);
  for (const { needle, replacement } of ROLLUP_RUNTIME_REPLACEMENTS) {
    next = next.replaceAll(needle, replacement);
  }
  next = next.replace(
    /async function runRollup\(options\) \{[\s\S]*?\nvar startRollup = async \(options\) => \{/,
    `${ROLLUP_RUNTIME_BLOCK}\nvar startRollup = async (options) => {`,
  );

  if (next === src) return false;
  writeFileSync(rollupPath, next, "utf8");
  return true;
}

/** Bun nests versioned installs under `node_modules/.bun/tsup@8.5.1+…`. */
function collectBunCacheTsupFiles() {
  const bunRoots = [
    join(repoRoot, "node_modules", ".bun"),
    join(repoRoot, "cloud", "node_modules", ".bun"),
  ];
  const out = [];
  for (const bunCacheDir of bunRoots) {
    if (!existsSync(bunCacheDir)) continue;
    for (const entry of readdirSync(bunCacheDir)) {
      if (!entry.startsWith("tsup@8.5.1")) continue;
      const tsupDist = join(bunCacheDir, entry, "node_modules", "tsup", "dist");
      pushIfExists(out, join(tsupDist, "index.js"));
      pushIfExists(out, join(tsupDist, "rollup.js"));
    }
  }
  return out;
}

function pushIfExists(out, filePath) {
  if (existsSync(filePath)) out.push(filePath);
}

function pushTsupDistFiles(out, tsupRoot) {
  pushIfExists(out, join(tsupRoot, "dist", "index.js"));
  pushIfExists(out, join(tsupRoot, "dist", "rollup.js"));
}

/**
 * Direct `node_modules/tsup` installs next to workspace packages (no `.bun`).
 */
function collectNestedWorkspaceTsupFiles() {
  const out = [];

  const pluginsDir = join(repoRoot, "plugins");
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir)) {
      pushTsupDistFiles(out, join(pluginsDir, name, "node_modules", "tsup"));
    }
  }

  const packagesDir = join(repoRoot, "packages");
  if (existsSync(packagesDir)) {
    for (const name of readdirSync(packagesDir)) {
      pushTsupDistFiles(out, join(packagesDir, name, "node_modules", "tsup"));
      if (name !== "examples") continue;
      const examplesRoot = join(packagesDir, "examples");
      for (const ex of readdirSync(examplesRoot)) {
        pushTsupDistFiles(out, join(examplesRoot, ex, "node_modules", "tsup"));
      }
    }
  }

  const cloudRoot = join(repoRoot, "cloud");
  if (existsSync(cloudRoot)) {
    for (const sub of ["apps", "packages", "services"]) {
      const sd = join(cloudRoot, sub);
      if (!existsSync(sd)) continue;
      for (const name of readdirSync(sd)) {
        pushTsupDistFiles(out, join(sd, name, "node_modules", "tsup"));
      }
    }
  }

  return out;
}

function collectRootTsupFiles() {
  const out = [];
  pushTsupDistFiles(out, join(repoRoot, "node_modules", "tsup"));
  pushTsupDistFiles(
    out,
    join(repoRoot, "node_modules", ".bun", "node_modules", "tsup"),
  );
  return out;
}

const targets = [
  ...collectRootTsupFiles(),
  ...collectBunCacheTsupFiles(),
  ...collectNestedWorkspaceTsupFiles(),
];

const seen = new Set();
let patched = 0;

for (const rollupPath of targets) {
  if (seen.has(rollupPath)) continue;
  seen.add(rollupPath);
  if (patchFile(rollupPath)) {
    console.log(`[patch-tsup-dts] Patched ${rollupPath}`);
    patched++;
  }
}

// Idempotent: silence when nothing to do (already patched or no tsup@8.5.1).
// Set VERBOSE=1 to confirm the script ran with no targets needing patches.
if (patched === 0 && process.env.VERBOSE) {
  console.log("[patch-tsup-dts] No unpatched tsup@8.5.1 DTS builds found.");
}
