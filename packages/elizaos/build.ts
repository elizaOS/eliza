#!/usr/bin/env bun

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const PACKAGE_DIR = import.meta.dir;
const DIST_DIR = path.join(PACKAGE_DIR, "dist");
const LEGACY_TEMPLATE_SOURCE_DIR = path.resolve(PACKAGE_DIR, "..", "templates");
const TEMPLATE_DIR = path.join(PACKAGE_DIR, "templates");
const MANIFEST_PATH = path.join(PACKAGE_DIR, "templates-manifest.json");
const SKIP_ENTRIES = new Set([
  ".DS_Store",
  ".git",
  ".turbo",
  ".vite",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
  }
}

function resolveTemplateSourceDir(): string {
  if (fs.existsSync(LEGACY_TEMPLATE_SOURCE_DIR)) {
    return LEGACY_TEMPLATE_SOURCE_DIR;
  }
  return TEMPLATE_DIR;
}

function loadTemplateDefinitions(sourceDir: string) {
  const templates = [];
  for (const entry of fs.readdirSync(sourceDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const metadataPath = path.join(sourceDir, entry.name, "template.json");
    if (!fs.existsSync(metadataPath)) continue;
    templates.push(JSON.parse(fs.readFileSync(metadataPath, "utf-8")));
  }
  templates.sort((a, b) => a.name.localeCompare(b.name));
  return templates;
}

function prepareTemplates(): void {
  const sourceDir = resolveTemplateSourceDir();
  if (path.resolve(sourceDir) !== path.resolve(TEMPLATE_DIR)) {
    fs.rmSync(TEMPLATE_DIR, { force: true, recursive: true });
    copyDir(sourceDir, TEMPLATE_DIR);
  }
  const manifest = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    repoUrl: "https://github.com/elizaos/eliza",
    templates: loadTemplateDefinitions(TEMPLATE_DIR),
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  execSync(`bunx --bun @biomejs/biome format --write ${MANIFEST_PATH}`, {
    cwd: PACKAGE_DIR,
    stdio: "inherit",
  });
}

function buildTypescript(): void {
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }
  execSync("bunx --bun tsc -p tsconfig.json", {
    cwd: PACKAGE_DIR,
    stdio: "inherit",
  });
}

function ensureCliShebang(): void {
  const cliPath = path.join(DIST_DIR, "cli.js");
  if (!fs.existsSync(cliPath)) return;
  let content = fs.readFileSync(cliPath, "utf-8");
  if (!content.startsWith("#!")) {
    content = `#!/usr/bin/env node\n${content}`;
    fs.writeFileSync(cliPath, content);
  }
  fs.chmodSync(cliPath, 0o755);
}

prepareTemplates();
buildTypescript();
ensureCliShebang();
