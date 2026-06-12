#!/usr/bin/env bun

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { copyDir } from "./safe-copy-dir.ts";

const PACKAGE_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");
const DIST_DIR = path.join(PACKAGE_DIR, "dist");

function resolveBin(name: string): string {
  const local = path.join(REPO_ROOT, "node_modules", ".bin", name);
  if (process.platform === "win32") {
    const winLocal = `${local}.cmd`;
    if (fs.existsSync(winLocal)) return winLocal;
    if (fs.existsSync(local)) return local;
    const winRepo = path.join(REPO_ROOT, "node_modules", ".bin", `${name}.cmd`);
    if (fs.existsSync(winRepo)) return winRepo;
  } else if (fs.existsSync(local)) {
    return local;
  }
  return name;
}
const LEGACY_TEMPLATE_SOURCE_DIR = path.resolve(PACKAGE_DIR, "..", "templates");
const TEMPLATE_DIR = path.join(PACKAGE_DIR, "templates");
const MANIFEST_PATH = path.join(PACKAGE_DIR, "templates-manifest.json");
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

function readExistingManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function manifestPayloadMatches(
  manifest: unknown,
  payload: { version: string; repoUrl: string; templates: unknown[] },
): manifest is { generatedAt?: string } {
  if (!manifest || typeof manifest !== "object") return false;
  const candidate = manifest as {
    version?: unknown;
    repoUrl?: unknown;
    templates?: unknown;
  };
  return (
    candidate.version === payload.version &&
    candidate.repoUrl === payload.repoUrl &&
    JSON.stringify(candidate.templates) === JSON.stringify(payload.templates)
  );
}

function prepareTemplates(): void {
  const sourceDir = resolveTemplateSourceDir();
  if (path.resolve(sourceDir) !== path.resolve(TEMPLATE_DIR)) {
    fs.rmSync(TEMPLATE_DIR, { force: true, recursive: true });
    copyDir(sourceDir, TEMPLATE_DIR);
  }
  const payload = {
    version: "1.0.0",
    repoUrl: "https://github.com/elizaos/eliza",
    templates: loadTemplateDefinitions(TEMPLATE_DIR),
  };
  const existingManifest = readExistingManifest();
  const manifest = {
    ...payload,
    generatedAt:
      manifestPayloadMatches(existingManifest, payload) &&
      typeof existingManifest.generatedAt === "string"
        ? existingManifest.generatedAt
        : new Date().toISOString(),
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  execSync(`${resolveBin("biome")} format --write ${MANIFEST_PATH}`, {
    cwd: PACKAGE_DIR,
    stdio: "inherit",
  });
}

function buildTypescript(): void {
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }
  execSync(`${resolveBin("tsc")} -p tsconfig.json`, {
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
