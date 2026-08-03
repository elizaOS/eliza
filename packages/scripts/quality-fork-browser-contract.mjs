#!/usr/bin/env node
/**
 * Static contract for the fork-safe homepage browser smoke.
 *
 * Fork validation installs Chromium without privileged dependency mutation,
 * runs the real homepage suite, and preserves exact failure artifacts through
 * a reviewed uploader so runner-specific failures remain diagnosable.
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
const UPLOAD_ARTIFACT_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

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
  const failureUpload = stepBody(
    workflow,
    "Upload homepage browser failure artifacts",
  );

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
    /^\s*run:\s*bun run test:e2e(?: --workers=[1-9]\d*)?\s*$/m.test(
      browserTest,
    ),
    `${WORKFLOW_PATH}: the real homepage browser test must remain enabled; only a positive worker cap is allowed`,
  );
  assert(
    workflow.indexOf(install) < workflow.indexOf(browserTest),
    `${WORKFLOW_PATH}: Chromium must be installed before the homepage browser test`,
  );
  assert(
    failureUpload.includes(`actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`),
    `${WORKFLOW_PATH}: browser failure artifacts must use the reviewed upload-artifact revision`,
  );
  assert(
    /if:\s*failure\(\)\s*&&\s*steps\.homepage-scope\.outputs\.run\s*==\s*'true'/.test(
      failureUpload,
    ),
    `${WORKFLOW_PATH}: browser artifacts must upload only after an in-scope failure`,
  );
  assert(
    workflow.indexOf(browserTest) < workflow.indexOf(failureUpload),
    `${WORKFLOW_PATH}: browser failure artifacts must upload after the browser test`,
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
