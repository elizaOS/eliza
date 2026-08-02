/**
 * Protects the stable advisory-check job names and the trust boundaries around
 * the active deep review and retired automatic security review workflows.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const WORKFLOWS = [
  ["claude-code-review.yml", "claude-review"],
  ["claude-security-review.yml", "security"],
];

async function workflow(name) {
  return readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
}

function topLevelJobIds(source) {
  const lines = source.split("\n");
  const jobsLine = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(jobsLine, -1, "workflow must contain a top-level jobs mapping");

  const ids = [];
  for (const line of lines.slice(jobsLine + 1)) {
    if (/^[^ ]/.test(line) && line.trim()) break;
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

describe("advisory workflow contracts", () => {
  it("preserves the required check-producing job IDs", async () => {
    for (const [file, job] of WORKFLOWS) {
      assert.deepEqual(topLevelJobIds(await workflow(file)), [job], file);
    }
  });

  it("keeps the active deep review behind its trust boundary", async () => {
    const source = await workflow("claude-code-review.yml");
    assert.match(source, /IS_FORK:/);
    assert.match(source, /IS_DRAFT:/);
    assert.match(source, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/);
    assert.match(source, /uses: anthropics\/claude-code-action@[0-9a-f]{40}/);
    assert.match(source, /ANTHROPIC_API_KEY/);
    assert.match(source, /continue-on-error: true/);
  });

  it("keeps the retired automatic security review inert", async () => {
    const source = await workflow("claude-security-review.yml");
    assert.doesNotMatch(source, /anthropics\//i);
    assert.doesNotMatch(source, /ANTHROPIC_API_KEY/i);
    assert.doesNotMatch(source, /actions\/checkout/i);
    assert.match(source, /permissions:\s*\{\}/);
  });

  it("runs both checks on ready-for-review and updated PR heads", async () => {
    for (const [file] of WORKFLOWS) {
      const source = await workflow(file);
      assert.match(source, /types:\s*\[[^\]]*ready_for_review[^\]]*\]/, file);
      assert.match(source, /types:\s*\[[^\]]*synchronize[^\]]*\]/, file);
    }
  });
});
