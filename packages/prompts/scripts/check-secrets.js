#!/usr/bin/env node
/**
 * Secret/credential scanner for prompt templates.
 *
 * This is intentionally conservative: it only fails on patterns that strongly
 * resemble real credentials (or private key material) to avoid false positives.
 *
 * Scans:
 * - all .txt files under packages/prompts/prompts/
 * - all .txt files under plugin prompt folders (if plugins/ exists)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROMPTS_PKG_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PROMPTS_PKG_DIR, "..", "..");

const PROMPTS_DIR = path.join(PROMPTS_PKG_DIR, "prompts");
const PLUGINS_DIR = path.join(REPO_ROOT, "plugins");

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listPromptTxtFiles(dir) {
  /** @type {string[]} */
  const out = [];

  /** @param {string} current */
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".txt")) {
        out.push(full);
      }
    }
  }

  try {
    await walk(dir);
  } catch (_e) {
    // Directory might not exist (e.g., plugins/ in minimal checkouts).
  }

  return out;
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
  const promptFiles = await listPromptTxtFiles(PROMPTS_DIR);

  /** @type {string[]} */
  let pluginPromptFiles = [];
  try {
    const pluginEntries = await fs.readdir(PLUGINS_DIR, {
      withFileTypes: true,
    });
    for (const entry of pluginEntries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(PLUGINS_DIR, entry.name, "prompts");
      const files = await listPromptTxtFiles(candidate);
      pluginPromptFiles = pluginPromptFiles.concat(files);
    }
  } catch {
    // plugins directory missing; ok.
  }

  const allFiles = [...promptFiles, ...pluginPromptFiles].sort();

  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  for (const file of allFiles) {
    const content = await fs.readFile(file, "utf-8");
    const result = scanContent(file, content);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  if (warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn("\nPrompt secret scan warnings (review recommended):\n");
    for (const w of warnings) {
      // eslint-disable-next-line no-console
      console.warn(`- ${w}`);
    }
  }

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error("\nPrompt secret scan errors (must fix):\n");
    for (const e of errors) {
      // eslint-disable-next-line no-console
      console.error(`- ${e}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(2);
});
