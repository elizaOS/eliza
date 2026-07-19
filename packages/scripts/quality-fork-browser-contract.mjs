#!/usr/bin/env node
/**
 * Static contract for the fork-safe homepage browser smoke.
 *
 * Self-hosted Quality (Fork) runners provide browser system libraries but do
 * not provide passwordless sudo. Playwright must therefore install Chromium
 * without --with-deps, while the real homepage browser test remains mandatory.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const WORKFLOW_PATH = ".github/workflows/quality-fork.yml";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stepBody(workflow, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = workflow.match(
    new RegExp(
      `^\\s*- name: ${escaped}\\s*$([\\s\\S]*?)(?=^\\s*- (?:name|uses):|(?![\\s\\S]))`,
      "m",
    ),
  );
  assert(match, `${WORKFLOW_PATH}: missing required step "${name}"`);
  return match[0];
}

export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const workflow = readFileSync(resolve(repoRoot, WORKFLOW_PATH), "utf8");
  const install = stepBody(workflow, "Install homepage browser");
  const browserTest = stepBody(workflow, "Test homepage downloads");

  assert(
    /^\s*run:\s*\.\/node_modules\/\.bin\/playwright install chromium\s*$/m.test(
      install,
    ),
    `${WORKFLOW_PATH}: browser install must request Chromium without privileged dependency installation`,
  );
  assert(
    !install.includes("--with-deps"),
    `${WORKFLOW_PATH}: browser install must not use --with-deps on self-hosted runners`,
  );
  assert(
    /^\s*run:\s*bun run test:e2e\s*$/m.test(browserTest),
    `${WORKFLOW_PATH}: the real homepage browser test must remain enabled`,
  );
  assert(
    workflow.indexOf(install) < workflow.indexOf(browserTest),
    `${WORKFLOW_PATH}: Chromium must be installed before the homepage browser test`,
  );

  return { workflow: WORKFLOW_PATH };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runContract();
    console.log("quality fork browser contract passed");
  } catch (error) {
    console.error(`[quality-fork-browser-contract] FAIL ${error.message}`);
    process.exit(1);
  }
}
