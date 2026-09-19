/**
 * Tests for resolveSkillProvenance and serializeSkillFile: parsing a full
 * provenance block, clamping `lastEvalScore` into [0, 1], and rejecting entries
 * with an invalid source or missing `createdAt`. Deterministic.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  parseFrontmatter,
  resolveSkillProvenance,
  serializeSkillFile,
} from "../src/frontmatter.js";
import type { SkillFrontmatter } from "../src/types.js";

describe("resolveSkillProvenance", () => {
  it("parses a complete provenance block", () => {
    const provenance = resolveSkillProvenance({
      provenance: {
        source: "agent-generated",
        derivedFromTrajectory: "abc-123",
        createdAt: "2025-01-01T00:00:00Z",
        refinedCount: 2,
        lastEvalScore: 0.75,
      },
    } as SkillFrontmatter);
    assert.strictEqual(provenance?.source, "agent-generated");
    assert.strictEqual(provenance?.derivedFromTrajectory, "abc-123");
    assert.strictEqual(provenance?.refinedCount, 2);
    assert.strictEqual(provenance?.lastEvalScore, 0.75);
  });

  it("clamps lastEvalScore into [0, 1]", () => {
    const provenance = resolveSkillProvenance({
      provenance: {
        source: "agent-refined",
        createdAt: "2025-01-01T00:00:00Z",
        refinedCount: 1,
        lastEvalScore: 1.7,
      },
    } as SkillFrontmatter);
    assert.strictEqual(provenance?.lastEvalScore, 1);
  });

  it("returns undefined for invalid source", () => {
    const provenance = resolveSkillProvenance({
      provenance: { source: "alien", createdAt: "2025-01-01T00:00:00Z" },
    } as SkillFrontmatter);
    assert.strictEqual(provenance, undefined);
  });

  it("returns undefined when block is missing createdAt", () => {
    const provenance = resolveSkillProvenance({
      provenance: { source: "human" },
    } as SkillFrontmatter);
    assert.strictEqual(provenance, undefined);
  });
});

describe("serializeSkillFile", () => {
  it("produces a frontmatter-prefixed markdown file", () => {
    const text = serializeSkillFile(
      {
        name: "demo",
        description: "demo skill",
        provenance: {
          source: "agent-generated",
          createdAt: "2025-01-01T00:00:00Z",
          refinedCount: 0,
        },
      },
      "## body\n",
    );
    const parsed = parseFrontmatter<SkillFrontmatter>(text);
    assert.strictEqual(parsed.frontmatter.name, "demo");
    assert.strictEqual(
      (parsed.frontmatter.provenance as { source: string }).source,
      "agent-generated",
    );
    assert.match(parsed.body, /## body/);
  });
});
