/**
 * Deterministic unit coverage for parseFrontmatter and skill frontmatter
 * resolvers: valid blocks, absent/empty/malformed YAML, non-object and
 * non-plain collection roots, CRLF, and metadata/policy extraction.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { ElizaError } from "@elizaos/core";
import {
  INVALID_SKILL_FRONTMATTER_YAML,
  parseFrontmatter,
  resolveSkillInvocationPolicy,
  resolveSkillMetadata,
  resolveSkillProvenance,
  serializeSkillFile,
  stripFrontmatter,
} from "../src/frontmatter.js";
import type { SkillFrontmatter } from "../src/types.js";

describe("parseFrontmatter", () => {
  it("parses valid YAML frontmatter", () => {
    const content = `---
name: test-skill
description: A test skill
---
# Body content`;
    const result = parseFrontmatter<SkillFrontmatter>(content);
    assert.strictEqual(result.frontmatter.name, "test-skill");
    assert.strictEqual(result.frontmatter.description, "A test skill");
    assert.strictEqual(result.body, "# Body content");
  });

  it("returns empty frontmatter when none present", () => {
    const content = "# Just a body";
    const result = parseFrontmatter(content);
    assert.deepStrictEqual(result.frontmatter, {});
    assert.strictEqual(result.body, "# Just a body");
  });

  it("handles empty frontmatter block", () => {
    const content = `---
---
Body`;
    const result = parseFrontmatter(content);
    assert.deepStrictEqual(result.frontmatter, {});
    assert.strictEqual(result.body, "Body");
  });

  it("handles opening delimiter with trailing whitespace", () => {
    const content =
      "---   \nname: test-trailing\ndescription: Test\n--- \nBody";
    const result = parseFrontmatter<SkillFrontmatter>(content);
    assert.strictEqual(result.frontmatter.name, "test-trailing");
    assert.strictEqual(result.frontmatter.description, "Test");
    assert.strictEqual(result.body, "Body");
  });

  it("does not treat non-delimiter prefix strings as frontmatter", () => {
    const content = "---not-a-delimiter\nname: test\n---\nBody";
    const result = parseFrontmatter(content);
    assert.deepStrictEqual(result.frontmatter, {});
    assert.strictEqual(result.body, content);
  });

  it("handles Windows-style line endings (CRLF)", () => {
    const content = "---\r\nname: test\r\n---\r\nBody";
    const result = parseFrontmatter<SkillFrontmatter>(content);
    assert.strictEqual(result.frontmatter.name, "test");
    assert.strictEqual(result.body, "Body");
  });

  it("handles content without closing frontmatter delimiter", () => {
    const content = "---\nname: test\nno closing";
    const result = parseFrontmatter(content);
    assert.deepStrictEqual(result.frontmatter, {});
  });

  it("parses complex frontmatter with arrays", () => {
    const content = `---
name: complex-skill
description: A complex skill
required-os:
  - macos
  - linux
required-bins:
  - git
  - node
---
Body`;
    const result = parseFrontmatter<SkillFrontmatter>(content);
    assert.deepStrictEqual(result.frontmatter["required-os"], [
      "macos",
      "linux",
    ]);
    assert.deepStrictEqual(result.frontmatter["required-bins"], [
      "git",
      "node",
    ]);
  });

  it("parses boolean frontmatter values", () => {
    const content = `---
name: bool-skill
description: Boolean test
disable-model-invocation: true
user-invocable: false
---
Body`;
    const result = parseFrontmatter<SkillFrontmatter>(content);
    assert.strictEqual(result.frontmatter["disable-model-invocation"], true);
    assert.strictEqual(result.frontmatter["user-invocable"], false);
  });

  it("throws a typed error for malformed YAML and preserves the parser cause", () => {
    const content = `---
invalid: : : yaml syntax error
---
Body content`;
    assert.throws(
      () => parseFrontmatter(content),
      (error: unknown) => {
        assert.ok(error instanceof ElizaError);
        assert.strictEqual(error.code, INVALID_SKILL_FRONTMATTER_YAML);
        assert.strictEqual(
          error.message,
          "Skill frontmatter contains invalid YAML",
        );
        assert.ok(error.cause instanceof Error);
        return true;
      },
    );
  });

  it("returns empty frontmatter for non-object YAML frontmatter blocks", () => {
    const scalarContent = `---
"just a string scalar"
---
Body content`;
    const scalarResult = parseFrontmatter(scalarContent);
    assert.deepStrictEqual(scalarResult.frontmatter, {});
    assert.strictEqual(scalarResult.body, "Body content");

    const arrayContent = `---
- item1
- item2
---
Body content`;
    const arrayResult = parseFrontmatter(arrayContent);
    assert.deepStrictEqual(arrayResult.frontmatter, {});
    assert.strictEqual(arrayResult.body, "Body content");
  });

  it("returns empty frontmatter for YAML Set and Map collection roots", () => {
    const setContent = `---
!!set
? alpha
? beta
---
Body content`;
    const setResult = parseFrontmatter(setContent);
    assert.deepStrictEqual(setResult.frontmatter, {});
    assert.strictEqual(setResult.body, "Body content");
    assert.ok(!(setResult.frontmatter instanceof Set));

    const omapContent = `---
!!omap
- alpha: 1
- beta: 2
---
Body content`;
    const omapResult = parseFrontmatter(omapContent);
    assert.deepStrictEqual(omapResult.frontmatter, {});
    assert.strictEqual(omapResult.body, "Body content");
    assert.ok(!(omapResult.frontmatter instanceof Map));
  });

  it("accepts plain and null-prototype-equivalent mapping roots", () => {
    const content = `---
name: plain-skill
description: mapping root
---
Body`;
    const result = parseFrontmatter<SkillFrontmatter>(content);
    assert.strictEqual(result.frontmatter.name, "plain-skill");
    assert.strictEqual(result.frontmatter.description, "mapping root");
    assert.strictEqual(result.body, "Body");
  });
});

describe("stripFrontmatter", () => {
  it("strips frontmatter and returns body", () => {
    const content = `---
name: test
---
Body content here`;
    const body = stripFrontmatter(content);
    assert.strictEqual(body, "Body content here");
  });

  it("returns content unchanged when no frontmatter", () => {
    const content = "No frontmatter here";
    assert.strictEqual(stripFrontmatter(content), content);
  });

  it("returns empty string for frontmatter-only content", () => {
    const content = `---
name: test
---`;
    const body = stripFrontmatter(content);
    assert.strictEqual(body, "");
  });

  it("does not hide malformed YAML while stripping frontmatter", () => {
    assert.throws(
      () => stripFrontmatter("---\ninvalid: : : yaml syntax error\n---\nBody"),
      (error: unknown) =>
        error instanceof ElizaError &&
        error.code === INVALID_SKILL_FRONTMATTER_YAML,
    );
  });
});

describe("resolveSkillMetadata", () => {
  it("resolves primary environment", () => {
    const metadata = resolveSkillMetadata({ "primary-env": "node" });
    assert.strictEqual(metadata.primaryEnv, "node");
  });

  it("resolves required OS", () => {
    const metadata = resolveSkillMetadata({
      "required-os": ["macos", "linux"],
    });
    assert.deepStrictEqual(metadata.requiredOs, ["macos", "linux"]);
  });

  it("resolves required binaries", () => {
    const metadata = resolveSkillMetadata({
      "required-bins": ["git", "node"],
    });
    assert.deepStrictEqual(metadata.requiredBins, ["git", "node"]);
  });

  it("resolves required environment variables", () => {
    const metadata = resolveSkillMetadata({
      "required-env": ["API_KEY", "SECRET"],
    });
    assert.deepStrictEqual(metadata.requiredEnv, ["API_KEY", "SECRET"]);
  });

  it("returns empty metadata for empty frontmatter", () => {
    const metadata = resolveSkillMetadata({});
    assert.strictEqual(metadata.primaryEnv, undefined);
    assert.strictEqual(metadata.requiredOs, undefined);
    assert.strictEqual(metadata.requiredBins, undefined);
    assert.strictEqual(metadata.requiredEnv, undefined);
  });

  it("filters non-string values from arrays", () => {
    const rawFrontmatter: Record<string, unknown> = {
      "required-os": ["macos", 42, "linux"],
    };
    const metadata = resolveSkillMetadata(rawFrontmatter);
    assert.deepStrictEqual(metadata.requiredOs, ["macos", "linux"]);
  });

  it("filters empty strings from arrays", () => {
    const rawFrontmatter: Record<string, unknown> = {
      "required-bins": [" git ", " ", "node"],
    };
    const metadata = resolveSkillMetadata(rawFrontmatter);
    assert.deepStrictEqual(metadata.requiredBins, ["git", "node"]);
  });

  it("omits requirement arrays when every value is invalid or blank", () => {
    const metadata = resolveSkillMetadata({
      "required-os": [42, " "],
      "required-bins": [false, ""],
      "required-env": [null, "\t"],
    } as Record<string, unknown>);

    assert.strictEqual(metadata.requiredOs, undefined);
    assert.strictEqual(metadata.requiredBins, undefined);
    assert.strictEqual(metadata.requiredEnv, undefined);
  });

  it("trims whitespace from string values", () => {
    const metadata = resolveSkillMetadata({ "primary-env": "  node  " });
    assert.strictEqual(metadata.primaryEnv, "node");
  });

  it("ignores empty primary-env after trimming", () => {
    const metadata = resolveSkillMetadata({ "primary-env": "   " });
    assert.strictEqual(metadata.primaryEnv, undefined);
  });
});

describe("resolveSkillInvocationPolicy", () => {
  it("resolves disable-model-invocation when true", () => {
    const policy = resolveSkillInvocationPolicy({
      "disable-model-invocation": true,
    });
    assert.strictEqual(policy.disableModelInvocation, true);
  });

  it("resolves user-invocable when false", () => {
    const policy = resolveSkillInvocationPolicy({
      "user-invocable": false,
    });
    assert.strictEqual(policy.userInvocable, false);
  });

  it("returns empty policy for empty frontmatter", () => {
    const policy = resolveSkillInvocationPolicy({});
    assert.strictEqual(policy.disableModelInvocation, undefined);
    assert.strictEqual(policy.userInvocable, undefined);
  });

  it("does not set disableModelInvocation for non-true values", () => {
    const policy = resolveSkillInvocationPolicy({
      "disable-model-invocation": false,
    });
    assert.strictEqual(policy.disableModelInvocation, undefined);
  });

  it("does not set userInvocable when not false", () => {
    const policy = resolveSkillInvocationPolicy({
      "user-invocable": true,
    });
    assert.strictEqual(policy.userInvocable, undefined);
  });
});

describe("resolveSkillProvenance", () => {
  it("returns undefined when provenance is absent or not a record", () => {
    assert.strictEqual(resolveSkillProvenance({}), undefined);
    assert.strictEqual(
      resolveSkillProvenance({
        provenance: null,
      } as unknown as SkillFrontmatter),
      undefined,
    );
    assert.strictEqual(
      resolveSkillProvenance({
        provenance: "human",
      } as unknown as SkillFrontmatter),
      undefined,
    );
    assert.strictEqual(
      resolveSkillProvenance({
        provenance: 123,
      } as unknown as SkillFrontmatter),
      undefined,
    );
  });

  it("returns undefined for unrecognized source values", () => {
    const frontmatter = {
      provenance: {
        source: "unknown-generator",
        createdAt: "2026-08-25T00:00:00Z",
      },
    } as unknown as SkillFrontmatter;
    assert.strictEqual(resolveSkillProvenance(frontmatter), undefined);
  });

  it("returns undefined when createdAt is missing or not a string", () => {
    assert.strictEqual(
      resolveSkillProvenance({
        provenance: { source: "human" },
      } as unknown as SkillFrontmatter),
      undefined,
    );
    assert.strictEqual(
      resolveSkillProvenance({
        provenance: { source: "human", createdAt: 12345 },
      } as unknown as SkillFrontmatter),
      undefined,
    );
  });

  it("resolves valid human provenance with default zero refinedCount", () => {
    const result = resolveSkillProvenance({
      provenance: {
        source: "human",
        createdAt: "2026-08-25T10:00:00Z",
      },
    } as unknown as SkillFrontmatter);

    assert.deepStrictEqual(result, {
      source: "human",
      createdAt: "2026-08-25T10:00:00Z",
      refinedCount: 0,
    });
  });

  it("resolves agent-generated provenance with trajectory and clamped score", () => {
    const result = resolveSkillProvenance({
      provenance: {
        source: "agent-generated",
        createdAt: "2026-08-25T11:00:00Z",
        derivedFromTrajectory: "traj-uuid-12345",
        lastEvalScore: 0.95,
      },
    } as unknown as SkillFrontmatter);

    assert.deepStrictEqual(result, {
      source: "agent-generated",
      createdAt: "2026-08-25T11:00:00Z",
      refinedCount: 0,
      derivedFromTrajectory: "traj-uuid-12345",
      lastEvalScore: 0.95,
    });
  });

  it("floor-clamps refinedCount and bounds lastEvalScore between 0 and 1", () => {
    const resultOver = resolveSkillProvenance({
      provenance: {
        source: "agent-refined",
        createdAt: "2026-08-25T12:00:00Z",
        refinedCount: 3.7,
        lastEvalScore: 1.45,
      },
    } as unknown as SkillFrontmatter);

    assert.deepStrictEqual(resultOver, {
      source: "agent-refined",
      createdAt: "2026-08-25T12:00:00Z",
      refinedCount: 3,
      lastEvalScore: 1.0,
    });

    const resultUnder = resolveSkillProvenance({
      provenance: {
        source: "agent-refined",
        createdAt: "2026-08-25T12:00:00Z",
        refinedCount: -2,
        lastEvalScore: -0.5,
      },
    } as unknown as SkillFrontmatter);

    assert.deepStrictEqual(resultUnder, {
      source: "agent-refined",
      createdAt: "2026-08-25T12:00:00Z",
      refinedCount: 0,
      lastEvalScore: 0.0,
    });
  });
});

describe("serializeSkillFile", () => {
  it("serializes frontmatter block and body with yaml fences", () => {
    const serialized = serializeSkillFile(
      {
        name: "test-serialize",
        description: "A serialized skill",
      },
      "# Test Skill Body\n\nInstructions here.",
    );

    assert.ok(serialized.startsWith("---\n"));
    assert.ok(serialized.includes("name: test-serialize\n"));
    assert.ok(serialized.includes("description: A serialized skill\n"));
    assert.ok(
      serialized.endsWith("\n---\n\n# Test Skill Body\n\nInstructions here."),
    );

    const parsed = parseFrontmatter<SkillFrontmatter>(serialized);
    assert.strictEqual(parsed.frontmatter.name, "test-serialize");
    assert.strictEqual(parsed.frontmatter.description, "A serialized skill");
    assert.strictEqual(parsed.body, "# Test Skill Body\n\nInstructions here.");
  });

  it("trims excess leading newlines from the body", () => {
    const serialized = serializeSkillFile(
      {
        name: "trim-test",
        description: "Trims body newlines",
      },
      "\n\n\n# Trimmed Heading\nContent",
    );

    assert.ok(serialized.includes("---\n\n# Trimmed Heading\nContent"));
  });
});
