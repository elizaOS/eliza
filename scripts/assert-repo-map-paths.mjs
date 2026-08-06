#!/usr/bin/env node
/**
 * Asserts the repository guide documents every top-level root with a purpose
 * and category so agents and humans share one ownership map.
 *
 * Reads root `AGENTS.md` (the authoritative map). Fails when a required path
 * string is missing, when dual-root ownership wording is incomplete, or when
 * the map omits the category vocabulary used by the organization contract.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUIDE = join(ROOT, "AGENTS.md");

/** Top-level OBJECTIVE paths that must appear in the repository map. */
export const REQUIRED_MAP_PATHS = [
  ".eliza",
  ".elizadb",
  ".elizaos",
  ".github",
  ".logs",
  ".smithers",
  ".turbo",
  ".well-known",
  "dna",
  "hedge",
  "hedge-dna",
  "knowledge",
  "my-project",
  "node_modules",
  "packages",
  "patches",
  "plugins",
  "scripts",
  "skills",
  "upstreams",
  ".biomeignore",
  ".dockerignore",
  ".env",
  ".env.clawd",
  ".env.test.example",
  ".gitattributes",
  ".gitignore",
  ".gitleaks.toml",
  ".gitleaksignore",
  ".gitmodules",
  ".madgerc",
  ".nvmrc",
  "AGENTS.md",
  "biome.json",
  "bun.lock",
  "bunfig.live.toml",
  "bunfig.toml",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "knip.json",
  "lerna.json",
  "LICENSE",
  "package.json",
  "plugins.json",
  "README.md",
  "tsconfig.base.json",
  "tsconfig.build.template.json",
  "tsconfig.json",
  "turbo.json",
  "vitest.config.ts",
  "WINDOWS.md",
];

/** Category vocabulary the map must use (acceptance criterion 1). */
export const REQUIRED_CATEGORIES = [
  "maintained source",
  "tooling/CI",
  "local runtime state",
  "agent/local content",
  "generated/cache",
  "third-party/vendor",
];

/** Dual-root ownership phrases that must name the canonical consumer. */
export const REQUIRED_OWNERSHIP_MARKERS = [
  "packages/skills",
  "packages/scripts",
  "packages vs plugins",
  "upstreams",
];

/**
 * Extract the repository map section from the guide body.
 * @param {string} guide
 * @returns {string}
 */
export function extractRepositoryMapSection(guide) {
  const start = guide.indexOf("## Repository map");
  if (start < 0) {
    throw new Error("AGENTS.md is missing ## Repository map");
  }
  const rest = guide.slice(start);
  const next = rest.search(/\n## (?!Repository map)/);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * @param {string} [guideText]
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function assertRepoMapPaths(guideText) {
  const guide = guideText ?? readFileSync(GUIDE, "utf8");
  const map = extractRepositoryMapSection(guide);
  const errors = [];

  for (const path of REQUIRED_MAP_PATHS) {
    // Paths appear as `.eliza/`, `packages/`, or bare `AGENTS.md` in the map.
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(^|[\\s\`'"(])${escaped}(/|\\b|[\\s\`'")])`,
      "m",
    );
    if (!pattern.test(map)) {
      errors.push(`repository map missing path: ${path}`);
    }
  }

  for (const category of REQUIRED_CATEGORIES) {
    if (!map.toLowerCase().includes(category.toLowerCase())) {
      errors.push(`repository map missing category: ${category}`);
    }
  }

  for (const marker of REQUIRED_OWNERSHIP_MARKERS) {
    if (!map.toLowerCase().includes(marker.toLowerCase())) {
      errors.push(`repository map missing ownership marker: ${marker}`);
    }
  }

  // Canonical dual-root consumers must be explicit.
  if (!/packages\/skills\/.*canonical|canonical.*packages\/skills/i.test(map)) {
    if (!map.includes("packages/skills/") || !/canonical/i.test(map)) {
      errors.push(
        "skills dual-root must name packages/skills as canonical shipped skills",
      );
    }
  }
  if (
    !map.includes("packages/scripts/") ||
    !/canonical monorepo automation|Canonical monorepo automation/i.test(map)
  ) {
    errors.push(
      "scripts dual-root must name packages/scripts as canonical monorepo automation",
    );
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function main() {
  const result = assertRepoMapPaths();
  if (!result.ok) {
    for (const error of result.errors) {
      console.error(error);
    }
    process.exit(1);
  }
  console.log(
    `repository map ok: ${REQUIRED_MAP_PATHS.length} paths, ${REQUIRED_CATEGORIES.length} categories`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
