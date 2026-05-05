#!/usr/bin/env node
/**
 * Moves plugins/<name>/typescript/* into plugins/<name>/ and removes typescript/.
 * Merges package.json: inner (publishable) wins; copies build:prompts, test:e2e, test:live from root wrapper when missing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = path.join(ROOT, "plugins");

/** Remove one `../` segment when it prefixes a chain to monorepo dirs */
const PATH_FIX_RE =
  /\.\.\/(?=(?:(?:\.\.\/)+)(?:packages\/|node_modules(?:\/|$)|prompts(?:\/|`|'|"|$|\*)))/g;

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".turbo"]);

function walkFix(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (SKIP_DIRS.has(ent.name)) continue;
    if (ent.isDirectory()) walkFix(full);
    else fixOneFile(full);
  }
}

function fixOneFile(full) {
  const ext = path.extname(full);
  const ok = [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".mjs",
    ".js",
    ".md",
    ".yaml",
    ".yml",
  ].includes(ext);
  if (!ok) return;
  let s = fs.readFileSync(full, "utf8");
  const orig = s;
  s = s.replace(PATH_FIX_RE, "");
  if (s !== orig) fs.writeFileSync(full, s);
}

/** Strip `typescript/` path segment fixes + cd typescript (package.json only). */
function fixPackageJsonScripts(pkgPath) {
  let s = fs.readFileSync(pkgPath, "utf8");
  const orig = s;
  s = s.replace(/"\.\/typescript\//g, '"./');
  s = s.replace(/'\.\/typescript\//g, "'./");
  s = s.replace(/cd typescript && /g, "");
  s = s.replace(/\bcd typescript\b(;|\s|$)/g, "$1");
  if (s !== orig) fs.writeFileSync(pkgPath, s);
}

function hoist(pluginRoot) {
  const tsDir = path.join(pluginRoot, "typescript");
  const innerPkgPath = path.join(tsDir, "package.json");
  const rootPkgPath = path.join(pluginRoot, "package.json");
  if (!fs.existsSync(innerPkgPath)) {
    console.warn(`skip (no typescript/package.json): ${pluginRoot}`);
    return;
  }

  const innerPkg = JSON.parse(fs.readFileSync(innerPkgPath, "utf8"));
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));

  innerPkg.scripts = innerPkg.scripts || {};
  const mergeKeys = ["build:prompts", "test:e2e", "test:live"];
  for (const k of mergeKeys) {
    if (rootPkg.scripts?.[k] != null && innerPkg.scripts[k] == null) {
      innerPkg.scripts[k] = rootPkg.scripts[k];
    }
  }

  for (const ent of fs.readdirSync(tsDir, { withFileTypes: true })) {
    if (ent.name === "package.json" || ent.name === "node_modules") continue;
    const src = path.join(tsDir, ent.name);
    const dest = path.join(pluginRoot, ent.name);
    fs.cpSync(src, dest, { recursive: true, force: true });
  }

  fs.rmSync(tsDir, { recursive: true, force: true });

  for (const [k, v] of Object.entries(innerPkg.scripts)) {
    if (typeof v !== "string") continue;
    innerPkg.scripts[k] = v
      .replace(/\.\/typescript\//g, "./")
      .replace(/([^"'\\/])typescript\/dist/g, "$1dist")
      .replace(/cd typescript && /g, "")
      .replace(/\bcd typescript\b(;|\s|$)/g, "$1")
      .trim();
  }

  if (
    innerPkg.scripts["build:prompts"] &&
    typeof innerPkg.scripts.build === "string" &&
    !innerPkg.scripts.build.includes("build:prompts")
  ) {
    innerPkg.scripts.build = `npm run build:prompts && ${innerPkg.scripts.build}`;
  }

  if (rootPkg.gitHead && !innerPkg.gitHead) innerPkg.gitHead = rootPkg.gitHead;

  const indent = "\t";
  fs.writeFileSync(rootPkgPath, `${JSON.stringify(innerPkg, null, indent)}\n`);

  fixPackageJsonScripts(rootPkgPath);
  walkFix(pluginRoot);
  console.log(`hoisted  ${path.relative(ROOT, pluginRoot)}`);
}

function main() {
  const names = fs.existsSync(PLUGINS) ? fs.readdirSync(PLUGINS).sort() : [];
  let n = 0;
  for (const name of names) {
    const pluginRoot = path.join(PLUGINS, name);
    if (!fs.statSync(pluginRoot).isDirectory()) continue;
    const tsPkg = path.join(pluginRoot, "typescript", "package.json");
    if (!fs.existsSync(tsPkg)) continue;
    hoist(pluginRoot);
    n++;
  }
  console.log(`Done. Hoisted ${n} plugins.`);
}

main();
