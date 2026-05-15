#!/usr/bin/env node
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

async function findWorkspaceRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    try {
      const raw = await readFile(path.join(current, "package.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.workspaces) {
        return current;
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return process.cwd();
    }
    current = parent;
  }
}

const workspaceRoot = await findWorkspaceRoot(process.cwd());
const packageDir = process.argv[2]
  ? path.resolve(workspaceRoot, process.argv[2])
  : process.cwd();
const distDir = path.join(packageDir, "dist");

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      yield entryPath;
    }
  }
}

function hasKnownExtension(specifier) {
  return /\.[cm]?[jt]sx?$/.test(specifier) || specifier.endsWith(".json");
}

async function resolveRelativeSpecifier(fromFile, specifier) {
  if (
    !specifier.startsWith("./") &&
    !specifier.startsWith("../") &&
    !specifier.startsWith("/")
  ) {
    return specifier;
  }
  if (hasKnownExtension(specifier)) {
    return specifier;
  }

  const resolved = path.resolve(path.dirname(fromFile), specifier);
  if (await exists(`${resolved}.js`)) {
    return `${specifier}.js`;
  }
  if (await exists(path.join(resolved, "index.js"))) {
    return `${specifier}/index.js`;
  }
  return specifier;
}

async function rewriteFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const importPattern =
    /(\b(?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+)(["']\)?)/g;

  let changed = false;
  let output = "";
  let lastIndex = 0;
  for (const match of source.matchAll(importPattern)) {
    const [full, prefix, specifier, suffix] = match;
    const replacement = await resolveRelativeSpecifier(filePath, specifier);
    output += source.slice(lastIndex, match.index);
    output += `${prefix}${replacement}${suffix}`;
    lastIndex = match.index + full.length;
    if (replacement !== specifier) {
      changed = true;
    }
  }
  output += source.slice(lastIndex);

  if (changed) {
    await writeFile(filePath, output, "utf8");
  }
  return changed;
}

if (!(await exists(distDir))) {
  console.log(`[rewrite-dist-relative-imports] skipped missing ${distDir}`);
  process.exit(0);
}

let rewritten = 0;
for await (const filePath of walk(distDir)) {
  if (await rewriteFile(filePath)) {
    rewritten += 1;
  }
}

console.log(`[rewrite-dist-relative-imports] rewrote ${rewritten} file(s)`);
