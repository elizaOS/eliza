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

describe("parseFrontmatter YAML block sequences (issue #29157)", () => {
  // The exact "Otto Compatibility" install list documented in the plugin
  // README. Before the parser fix this collapsed into a single merged object
  // (both `id` fields dropped, item 0 overwritten by item 1), which then made
  // installSkillDependencies throw "installOptions is not iterable".
  const ottoListSkill = [
    "---",
    "name: gh-skill",
    "description: A skill that requires the GitHub CLI to operate correctly.",
    "metadata:",
    "  otto:",
    '    emoji: "\ud83d\udc19"',
    "    requires:",
    "      bins:",
    "        - gh",
    "    install:",
    "      - id: brew",
    "        kind: brew",
    "        formula: gh",
    '        bins: ["gh"]',
    '        label: "Install GitHub CLI (brew)"',
    "      - id: apt",
    "        kind: apt",
    "        package: gh",
    '        bins: ["gh"]',
    '        label: "Install GitHub CLI (apt)"',
    "---",
    "",
    "# GH Skill",
  ].join("\n");

  it("parses the README otto install list into a typed OttoInstallOption[]", () => {
    const otto = parseFrontmatter(ottoListSkill).frontmatter?.metadata?.otto;
    const install = otto?.install;

    expect(Array.isArray(install)).toBe(true);
    expect(install).toHaveLength(2);
    // Each item's first key (`id`) must survive, not be dropped/merged.
    expect(install?.[0]).toEqual({
      id: "brew",
      kind: "brew",
      formula: "gh",
      bins: ["gh"],
      label: "Install GitHub CLI (brew)",
    });
    expect(install?.[1]).toEqual({
      id: "apt",
      kind: "apt",
      package: "gh",
      bins: ["gh"],
      label: "Install GitHub CLI (apt)",
    });
  });

  it("parses a block-style scalar sequence (requires.bins) into an array", () => {
    const otto = parseFrontmatter(ottoListSkill).frontmatter?.metadata?.otto;
    expect(otto?.requires?.bins).toEqual(["gh"]);
    expect(otto?.emoji).toBe("\ud83d\udc19");
  });

  it("round-trips mixed block-list, nested-object, and scalar frontmatter", () => {
    const mixed = [
      "---",
      "name: mixed-skill",
      "description: Exercises lists alongside scalars and nested maps.",
      "license: MIT",
      "metadata:",
      "  otto:",
      "    requires:",
      "      bins:",
      "        - jq",
      "        - yq",
      "    install:",
      "      - id: brew",
      "        kind: brew",
      "        formula: jq",
      '        bins: ["jq"]',
      "---",
      "body",
    ].join("\n");
    const fm = parseFrontmatter(mixed).frontmatter;
    expect(fm?.name).toBe("mixed-skill");
    expect(fm?.license).toBe("MIT");
    expect(fm?.metadata?.otto?.requires?.bins).toEqual(["jq", "yq"]);
    expect(fm?.metadata?.otto?.install).toHaveLength(1);
    expect(fm?.metadata?.otto?.install?.[0]).toEqual({
      id: "brew",
      kind: "brew",
      formula: "jq",
      bins: ["jq"],
    });
  });

  it("regression: inline JSON array frontmatter still parses unchanged", () => {
    const inlineJson = [
      "---",
      "name: inline-skill",
      "description: Inline JSON install options must keep working after the fix.",
      "metadata:",
      "  otto:",
      '    install: [{"id":"brew","kind":"brew","formula":"gh","bins":["gh"]}]',
      "---",
      "body",
    ].join("\n");
    const install =
      parseFrontmatter(inlineJson).frontmatter?.metadata?.otto?.install;
    expect(Array.isArray(install)).toBe(true);
    expect(install).toEqual([
      { id: "brew", kind: "brew", formula: "gh", bins: ["gh"] },
    ]);
  });
});
