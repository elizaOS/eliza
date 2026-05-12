import assert from "node:assert";
import { describe, it } from "node:test";
import {
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
