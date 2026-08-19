/**
 * Verifies line-ending-safe SKILL.md frontmatter parsing directly and through
 * the deterministic in-memory storage loader used by runtime discovery.
 */
import { describe, expect, it } from "vitest";
import { parseFrontmatter, validateFrontmatter } from "./parser.ts";
import { loadSkillFromStorage, MemorySkillStore } from "./storage.ts";

describe("parseFrontmatter", () => {
  const lf = [
    "---",
    "name: my-skill",
    "description: A clear description here.",
    "---",
    "Body text",
  ].join("\n");

  const crlf = lf.replace(/\n/g, "\r\n");

  it("parses LF frontmatter", () => {
    const result = parseFrontmatter(lf);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe("my-skill");
    expect(result.body.trim()).toBe("Body text");
  });

  it("parses CRLF frontmatter", () => {
    const result = parseFrontmatter(crlf);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe("my-skill");
    expect(result.body.trim()).toBe("Body text");
  });

  it("loads a CRLF skill through the storage discovery boundary", async () => {
    const storage = new MemorySkillStore();
    await storage.initialize();
    await storage.loadFromContent("my-skill", crlf);

    const skill = await loadSkillFromStorage(storage, "my-skill");

    expect(skill).toMatchObject({
      slug: "my-skill",
      name: "my-skill",
      description: "A clear description here.",
      content: crlf,
    });
  });

  it("returns null frontmatter when block is missing", () => {
    const result = parseFrontmatter("# just a body");
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe("# just a body");
  });

  it("handles mixed LF/CRLF in one document", () => {
    const mixed = "---\r\nname: mixed\r\ndescription: desc\r\n---\n\nBody\r\nhere";
    const result = parseFrontmatter(mixed);
    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter?.name).toBe("mixed");
    expect(result.body.trim()).toBe("Body\r\nhere");
  });

  it("validates parsed frontmatter through validateFrontmatter for CRLF content", () => {
    const result = validateFrontmatter(
      parseFrontmatter(crlf).frontmatter ?? null,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
