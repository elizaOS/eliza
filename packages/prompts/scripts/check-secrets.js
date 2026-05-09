#!/usr/bin/env node
/**
 * Secret/credential scanner for prompt templates.
 *
 * This is intentionally conservative: it only fails on patterns that strongly
 * resemble real credentials (or private key material) to avoid false positives.
 *
 * Wave 1 of the prompt migration moved every prompt body from a sibling
 * `.txt` file to a TypeScript template-literal export. The scanner now walks
 * those TS prompt-source locations directly.
 *
 * Scans:
 * - packages/prompts/src/**\/*.ts
 * - packages/core/src/prompts.ts and packages/core/src/services/message.ts
 * - plugins/* TS modules whose path matches `prompts.ts`,
 *   `prompts/<name>.ts`, or `templates.ts`
 *
 * Generated mirrors and test files are skipped.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROMPTS_PKG_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PROMPTS_PKG_DIR, "..", "..");

// Roots under which to look for prompt-bearing TS files.
const PROMPT_SCAN_TS_ROOTS = [
  "packages/prompts/src",
  "packages/core/src",
  "plugins",
];

// Always include these high-traffic prompt modules even if they don't match
// the heuristic file-name patterns above.
const PROMPT_SCAN_FILES = [
  "packages/core/src/prompts.ts",
  "packages/core/src/services/message.ts",
];

const PROMPT_SCAN_FILE_PATTERNS = [
  /(^|\/)prompts?\.ts$/,
  /(^|\/)prompts\/[^/]+\.ts$/,
  /(^|\/)templates?\.ts$/,
];

const TEST_SOURCE_PATH_PATTERN =
  /(^|\/)(__tests__|tests?|e2e)(\/|$)|\.(test|spec)\.tsx?$/;

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".turbo",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "generated",
]);

/**
 * @param {string} root
 * @param {(absPath: string, relPath: string) => boolean} predicate
 * @returns {Promise<string[]>}
 */
async function walkFiles(root, predicate) {
  /** @type {string[]} */
  const out = [];

  /** @param {string} current */
  async function walk(current) {
    /** @type {Awaited<ReturnType<typeof fs.readdir>>} */
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(REPO_ROOT, full);
      if (predicate(full, rel)) out.push(full);
    }
  }

  await walk(root);
  return out;
}

/**
 * @returns {Promise<string[]>}
 */
async function listPromptTsFiles() {
  /** @type {Set<string>} */
  const set = new Set();
  for (const file of PROMPT_SCAN_FILES) {
    set.add(path.join(REPO_ROOT, file));
  }
  for (const root of PROMPT_SCAN_TS_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    const files = await walkFiles(absRoot, (_abs, rel) => {
      if (!rel.endsWith(".ts") && !rel.endsWith(".tsx")) return false;
      if (TEST_SOURCE_PATH_PATTERN.test(rel)) return false;
      if (/(^|\/)generated\//.test(rel)) return false;
      return PROMPT_SCAN_FILE_PATTERNS.some((p) => p.test(rel));
    });
    for (const f of files) set.add(f);
  }
  return [...set].sort();
}

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {{errors: string[], warnings: string[]}}
 */
function scanContent(filePath, content) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const lines = content.split(/\r?\n/);

  /** @type {Array<{name: string, re: RegExp, severity: "error" | "warning"}>} */
  const rules = [
    {
      name: "Private key material",
      re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
      severity: "error",
    },
    { name: "GitHub token", re: /\bghp_[A-Za-z0-9]{20,}\b/, severity: "error" },
    {
      name: "GitHub fine-grained token",
      re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
      severity: "error",
    },
    {
      name: "Slack token",
      re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
      severity: "error",
    },
    {
      name: "AWS access key id",
      re: /\bAKIA[0-9A-Z]{16}\b/,
      severity: "error",
    },
    {
      name: "Google API key",
      re: /\bAIza[0-9A-Za-z\-_]{30,}\b/,
      severity: "error",
    },
    {
      name: "OpenAI-style key",
      re: /\bsk-[A-Za-z0-9]{20,}\b/,
      severity: "error",
    },
    {
      name: "Anthropic-style key",
      re: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/,
      severity: "error",
    },
    {
      name: "Generic credential assignment (review)",
      re: /\b[A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*["']?[^"'\s]{8,}/,
      severity: "warning",
    },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of rules) {
      if (rule.re.test(line)) {
        const msg = `${filePath}:${i + 1}  ${rule.name}: ${line.trim()}`;
        if (rule.severity === "error") errors.push(msg);
        else warnings.push(msg);
      }
    }
  }

  return { errors, warnings };
}

async function main() {
  const allFiles = await listPromptTsFiles();

  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  for (const file of allFiles) {
    let content;
    try {
      content = await fs.readFile(file, "utf-8");
    } catch {
      continue;
    }
    const result = scanContent(file, content);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  if (warnings.length > 0) {
    console.warn("\nPrompt secret scan warnings (review recommended):\n");
    for (const w of warnings) {
      console.warn(`- ${w}`);
    }
  }

  if (errors.length > 0) {
    console.error("\nPrompt secret scan errors (must fix):\n");
    for (const e of errors) {
      console.error(`- ${e}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
