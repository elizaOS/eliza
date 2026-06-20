/**
 * View-bundle import guard.
 *
 * A plugin view bundle is built with `@elizaos/ui`, `react`, etc. left as
 * *external* bare imports (see `view-bundle-vite.config.ts`). At runtime the
 * shell's `DynamicViewLoader` does NOT load those bare specifiers directly —
 * the agent's bundle route rewrites each one into a
 * `globalThis.__ELIZA_DYNAMIC_VIEW_IMPORT__("<specifier>")` call, resolved by
 * the loader's `HOST_EXTERNAL_IMPORTERS` map so the view shares the host's
 * singletons.
 *
 * That rewrite is an EXACT-STRING match against the map's keys. The Vite build,
 * however, externalises by PREFIX (`@elizaos/ui` and anything under it). The two
 * therefore disagree: a view that imports an `@elizaos/ui/<subpath>` the loader
 * does not list is externalised by the build but never rewritten by the loader,
 * so the browser receives a bare `import … from "@elizaos/ui/<subpath>"` it
 * cannot resolve and the view fails to load with "Failed to resolve module
 * specifier".
 *
 * This guard closes that gap: it reads the loader's map (the single source of
 * truth) and asserts every bare import in every built view bundle is one the
 * loader can rewrite. Run at the end of `build-views.mjs` so a drift fails the
 * build instead of shipping a view that silently won't load.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOADER_PATH = path.join(
  repoRoot,
  "packages/ui/src/components/views/DynamicViewLoader.tsx",
);

/**
 * Extract the keys of the `HOST_EXTERNAL_IMPORTERS` object literal from the
 * loader source. The keys ARE the contract the agent's bundle route rewrites
 * against, so reading them directly keeps this guard from drifting from the
 * loader. Keys are collected only at the top level of the object (depth 1) so
 * nested thunk bodies (e.g. the `react/jsx-dev-runtime` block) are ignored.
 */
export async function getHostExternalSpecifiers() {
  const source = await fs.readFile(LOADER_PATH, "utf8");
  const marker = "const HOST_EXTERNAL_IMPORTERS";
  const declStart = source.indexOf(marker);
  if (declStart === -1) {
    throw new Error(
      `[view-bundle-guard] could not find HOST_EXTERNAL_IMPORTERS in ${path.relative(repoRoot, LOADER_PATH)}`,
    );
  }
  const braceStart = source.indexOf("{", declStart);
  if (braceStart === -1) {
    throw new Error("[view-bundle-guard] malformed HOST_EXTERNAL_IMPORTERS literal");
  }

  const specifiers = new Set();
  let depth = 0;
  let i = braceStart;
  // Walk the object literal character by character, tracking brace depth and
  // skipping string/template/comment spans so braces inside them don't shift
  // the depth. Collect property keys that sit directly at depth 1.
  let atKeyPosition = true; // true when the next token could be a property key
  while (i < source.length) {
    const ch = source[i];

    // Skip line + block comments.
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    // Skip string / template literals.
    if (ch === '"' || ch === "'" || ch === "`") {
      // A quoted property key at depth 1 is what we want to capture.
      const quote = ch;
      let j = i + 1;
      let value = "";
      while (j < source.length) {
        if (source[j] === "\\") {
          value += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (source[j] === quote) break;
        value += source[j];
        j += 1;
      }
      const after = source.slice(j + 1).match(/^\s*:/);
      if (depth === 1 && atKeyPosition && after) {
        specifiers.add(value);
      }
      i = j + 1;
      atKeyPosition = false;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      atKeyPosition = depth === 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) break; // end of HOST_EXTERNAL_IMPORTERS
      i += 1;
      continue;
    }
    if (ch === ",") {
      atKeyPosition = depth === 1;
      i += 1;
      continue;
    }

    // Bare-identifier property key at depth 1 (e.g. `react:`, `three:`).
    if (depth === 1 && atKeyPosition && /[A-Za-z_$]/.test(ch)) {
      const rest = source.slice(i);
      const m = rest.match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (m) {
        specifiers.add(m[1]);
        i += m[0].length;
        atKeyPosition = false;
        continue;
      }
    }

    if (!/\s/.test(ch)) atKeyPosition = false;
    i += 1;
  }

  if (specifiers.size === 0) {
    throw new Error("[view-bundle-guard] extracted zero host-external specifiers — parser broke");
  }
  return specifiers;
}

/** Pull the bare (non-relative) module specifiers a built bundle imports. */
function bareImportSpecifiers(source) {
  const out = new Set();
  for (const line of source.split("\n")) {
    const t = line.trimStart();
    if (!t.startsWith("import") && !t.startsWith("export")) continue;
    const m =
      t.match(/\bfrom\s*["']([^"']+)["']/) || t.match(/^import\s*["']([^"']+)["']/);
    if (!m) continue;
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    out.add(spec);
  }
  return out;
}

async function listBuiltBundles() {
  const pluginsDir = path.join(repoRoot, "plugins");
  const names = await fs.readdir(pluginsDir).catch(() => []);
  const bundles = [];
  for (const name of names) {
    const bundle = path.join(pluginsDir, name, "dist/views/bundle.js");
    try {
      await fs.access(bundle);
      bundles.push({ name, bundle });
    } catch {
      // not built — nothing to validate
    }
  }
  return bundles;
}

/**
 * Validate every built view bundle. Returns a list of violations
 * `{ plugin, specifier }`; empty when every bundle is loadable.
 */
export async function validateViewBundles() {
  const allowed = await getHostExternalSpecifiers();
  const bundles = await listBuiltBundles();
  const violations = [];
  for (const { name, bundle } of bundles) {
    const source = await fs.readFile(bundle, "utf8");
    for (const spec of bareImportSpecifiers(source)) {
      if (!allowed.has(spec)) violations.push({ plugin: name, specifier: spec });
    }
  }
  return { violations, bundleCount: bundles.length, allowedCount: allowed.size };
}

// CLI entry: `bun packages/scripts/view-bundle-import-guard.mjs`
if (import.meta.main || process.argv[1] === fileURLToPath(import.meta.url)) {
  const { violations, bundleCount, allowedCount } = await validateViewBundles();
  if (violations.length === 0) {
    console.log(
      `[view-bundle-guard] OK — ${bundleCount} bundle(s) import only host-external specifiers (${allowedCount} allowed).`,
    );
    process.exit(0);
  }
  console.error(
    `[view-bundle-guard] ${violations.length} un-loadable import(s) found.\n` +
      "These specifiers are externalised by the view build but NOT rewritable by\n" +
      "DynamicViewLoader, so the view fails to load in the browser. Import them from\n" +
      "a specifier the loader's HOST_EXTERNAL_IMPORTERS map already provides (e.g. the\n" +
      "`@elizaos/ui/components` barrel) instead of a deep subpath.\n",
  );
  for (const v of violations) {
    console.error(`  ✗ ${v.plugin}: ${v.specifier}`);
  }
  process.exit(1);
}
