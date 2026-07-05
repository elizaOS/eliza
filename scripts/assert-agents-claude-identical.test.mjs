import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldCheckGuideFile } from "./assert-agents-claude-identical.mjs";

describe("assert-agents-claude-identical guide filtering", () => {
  it("checks authored guide pairs", () => {
    assert.equal(shouldCheckGuideFile("AGENTS.md"), true);
    assert.equal(shouldCheckGuideFile("CLAUDE.md"), true);
    assert.equal(shouldCheckGuideFile("packages/app/AGENTS.md"), true);
    assert.equal(shouldCheckGuideFile("plugins/plugin-openai/CLAUDE.md"), true);
  });

  it("excludes fixture, test, and archived sample trees", () => {
    assert.equal(
      shouldCheckGuideFile(
        "packages/import-conversations/src/parsers/fixtures/openclaw-home/AGENTS.md",
      ),
      false,
    );
    assert.equal(
      shouldCheckGuideFile(
        "packages/elizaos/src/migrate/__tests__/fixtures/oc-home/CLAUDE.md",
      ),
      false,
    );
    assert.equal(
      shouldCheckGuideFile(
        "packages/benchmarks/openclaw-benchmark/.archived/opencode_setup/AGENTS.md",
      ),
      false,
    );
  });
});
