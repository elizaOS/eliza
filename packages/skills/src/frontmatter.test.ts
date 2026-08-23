/**
 * Unit tests for YAML frontmatter parsing, stripping, serialization, and metadata resolution.
 */

import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  INVALID_SKILL_FRONTMATTER_YAML,
  parseFrontmatter,
  resolveSkillInvocationPolicy,
  resolveSkillMetadata,
  resolveSkillProvenance,
  serializeSkillFile,
  stripFrontmatter,
} from "./frontmatter.js";
import type { SkillFrontmatter } from "./types.js";

describe("skills frontmatter", () => {
  it("parses valid YAML frontmatter and extracts body", () => {
    const content = `---
name: web-search
description: Search the web
required-os:
  - linux
  - macos
---

# Web Search Skill

Instructions go here.`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("web-search");
    expect(frontmatter.description).toBe("Search the web");
    expect(body).toBe("# Web Search Skill\n\nInstructions go here.");
  });

  it("handles documents without frontmatter", () => {
    const rawMarkdown = "# Plain Markdown\n\nNo frontmatter here.";
    const { frontmatter, body } = parseFrontmatter(rawMarkdown);
    expect(frontmatter).toEqual({});
    expect(body).toBe(rawMarkdown);

    expect(stripFrontmatter(rawMarkdown)).toBe(rawMarkdown);
  });

  it("throws ElizaError with INVALID_SKILL_FRONTMATTER_YAML on malformed YAML", () => {
    const invalidContent = `---
name: [unclosed list
---

Body content`;

    expect(() => parseFrontmatter(invalidContent)).toThrowError(ElizaError);
    try {
      parseFrontmatter(invalidContent);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ElizaError);
      expect((err as ElizaError).code).toBe(INVALID_SKILL_FRONTMATTER_YAML);
    }
  });

  it("resolves skill metadata supporting kebab-case and snake_case keys", () => {
    const metaKebab = resolveSkillMetadata({
      "primary-env": "BASH",
      "required-os": ["MacOS", "LINUX"],
      "required-bins": ["curl", "jq"],
      "required-env": ["API_KEY"],
    });

    expect(metaKebab.primaryEnv).toBe("BASH");
    expect(metaKebab.requiredOs).toEqual(["macos", "linux"]);
    expect(metaKebab.requiredBins).toEqual(["curl", "jq"]);
    expect(metaKebab.requiredEnv).toEqual(["API_KEY"]);

    const metaSnake = resolveSkillMetadata({
      primary_env: "NODE",
      required_os: ["WINDOWS"],
      required_bins: ["node"],
      required_env: ["PORT"],
    });

    expect(metaSnake.primaryEnv).toBe("NODE");
    expect(metaSnake.requiredOs).toEqual(["windows"]);
    expect(metaSnake.requiredBins).toEqual(["node"]);
    expect(metaSnake.requiredEnv).toEqual(["PORT"]);
  });

  it("resolves invocation policy flags", () => {
    const policy = resolveSkillInvocationPolicy({
      "disable-model-invocation": true,
      "user-invocable": false,
    });

    expect(policy.disableModelInvocation).toBe(true);
    expect(policy.userInvocable).toBe(false);
  });

  it("resolves skill provenance correctly and clamps values", () => {
    const prov = resolveSkillProvenance({
      provenance: {
        source: "agent-generated",
        createdAt: "2026-08-01T00:00:00Z",
        refinedCount: 3.8,
        derivedFromTrajectory: "traj-123",
        lastEvalScore: 0.95,
      },
    });

    expect(prov).toEqual({
      source: "agent-generated",
      createdAt: "2026-08-01T00:00:00Z",
      refinedCount: 3,
      derivedFromTrajectory: "traj-123",
      lastEvalScore: 0.95,
    });

    // Invalid provenance yields undefined
    expect(
      resolveSkillProvenance({
        provenance: {
          source: "invalid-source",
          createdAt: "now",
        } as unknown as SkillFrontmatter["provenance"],
      }),
    ).toBeUndefined();
  });

  it("serializes frontmatter and body into valid skill file format", () => {
    const serialized = serializeSkillFile(
      { name: "test-skill", description: "A test" },
      "Body paragraph.",
    );

    expect(serialized.startsWith("---\n")).toBe(true);
    expect(serialized).toContain("name: test-skill");
    expect(serialized).toContain("description: A test");
    expect(serialized.endsWith("\n\nBody paragraph.")).toBe(true);
  });
});
