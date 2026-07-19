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

describe("disabled advisory workflow stubs", () => {
  it("preserves the required check-producing job IDs", async () => {
    for (const [file, job] of WORKFLOWS) {
      assert.deepEqual(topLevelJobIds(await workflow(file)), [job], file);
    }
  });

  it("does not invoke Anthropic actions or require Anthropic credentials", async () => {
    for (const [file] of WORKFLOWS) {
      const source = await workflow(file);
      assert.doesNotMatch(source, /anthropics\//i, file);
      assert.doesNotMatch(source, /ANTHROPIC_API_KEY/i, file);
      assert.doesNotMatch(source, /actions\/checkout/i, file);
    }
  });

  it("runs on ready-for-review and updated PR heads", async () => {
    for (const [file] of WORKFLOWS) {
      const source = await workflow(file);
      assert.match(source, /types:\s*\[[^\]]*ready_for_review[^\]]*\]/, file);
      assert.match(source, /types:\s*\[[^\]]*synchronize[^\]]*\]/, file);
    }
  });
});
