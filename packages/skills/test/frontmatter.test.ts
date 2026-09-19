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

  for (const [label, yaml, expected] of [
    [
      "literal block",
      `description: |\n  ${"[".repeat(40)}`,
      { description: `${"[".repeat(40)}\n` },
    ],
    [
      "inline comment",
      `name: example # ${"{".repeat(40)}`,
      { name: "example" },
    ],
    [
      "plain scalar",
      `description: Read ${"[".repeat(40)} literal markers`,
      { description: `Read ${"[".repeat(40)} literal markers` },
    ],
    [
      "indented scalar",
      `description:\n${" ".repeat(80)}valid scalar`,
      { description: "valid scalar" },
    ],
  ] as const) {
    it(`preserves complete skill metadata and body containing ${label}`, () => {
      const body = `# Complete body 🟠\n${"full instruction\n".repeat(100)}Final instruction`;
      const result = parseFrontmatter(`---\n${yaml}\n---\n${body}`);
      assert.deepStrictEqual(result.frontmatter, expected);
      assert.equal(result.body, body);
    });
  }

  it("rejects malformed YAML before composing a deeply nested tail", () => {
    const malformed = `---\nkey: ]\nvalue: ${"[".repeat(10_000)}leaf${"]".repeat(10_000)}\n---\nComplete body`;
    assert.throws(
      () => parseFrontmatter(malformed),
      (error: unknown) => {
        assert.ok(error instanceof ElizaError);
        assert.equal(error.code, INVALID_SKILL_FRONTMATTER_YAML);
        assert.deepStrictEqual(error.context, {
          parser: "yaml",
          reason: "invalid-yaml",
        });
        return true;
      },
    );
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

  it("rejects a typo'd ---- separator instead of swallowing frontmatter into the body", () => {
    const content =
      '---\ndescription: "A skill"\nname: my-skill\n----\nversion: 2\n---\nBody';
    assert.throws(
      () => parseFrontmatter(content),
      (error: unknown) => {
        assert.ok(error instanceof ElizaError);
        assert.equal(error.code, INVALID_SKILL_FRONTMATTER_YAML);
        return true;
      },
    );
  });

  it("preserves a dashes rule inside the body after a valid closer", () => {
    const result = parseFrontmatter(
      "---\nname: ok\n---\nRules\n----\nMore rules",
    );
    assert.deepStrictEqual(result.frontmatter, { name: "ok" });
    assert.equal(result.body, "Rules\n----\nMore rules");
  });

  it("parses quoted scalars whose indented continuation contains ---", () => {
    const result = parseFrontmatter(
      '---\ndescription: "alpha\n  --- beta\n  gamma"\nname: quoted-skill\n---\nBody',
    );
    assert.deepStrictEqual(result.frontmatter, {
      description: "alpha --- beta gamma",
      name: "quoted-skill",
    });
    assert.equal(result.body, "Body");
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

  for (const [label, yaml] of [
    ["scalar", '"just a string scalar"'],
    ["array", "- item1\n- item2"],
    ["Set", "!!set\n? alpha\n? beta"],
    ["Map", "!!omap\n- alpha: 1\n- beta: 2"],
  ]) {
    it(`returns empty frontmatter for a YAML ${label} root and preserves the body`, () => {
      const result = parseFrontmatter(`---\n${yaml}\n---\nBody content`);
      assert.deepStrictEqual(result.frontmatter, {});
      assert.strictEqual(result.body, "Body content");
    });
  }
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
  it("resolves required environment variables independently", () => {
    assert.deepStrictEqual(
      resolveSkillMetadata({ "required-env": ["API_KEY"] }),
      {
        requiredEnv: ["API_KEY"],
      },
    );
  });

  it("resolves all runtime requirements from parsed frontmatter", () => {
    const { frontmatter } = parseFrontmatter(`---
primary-env: node
required-os: [macos, linux]
required-bins: [git, node]
required-env: [API_KEY, SECRET]
---
Body`);
    assert.deepStrictEqual(resolveSkillMetadata(frontmatter), {
      primaryEnv: "node",
      requiredOs: ["macos", "linux"],
      requiredBins: ["git", "node"],
      requiredEnv: ["API_KEY", "SECRET"],
    });
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
