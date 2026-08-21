/**
 * Regression tests for the SKILL.md scaffold path used by
 * `POST /api/skills/create`. Two layers of real coverage:
 *
 *  1. Helper-level: builds the scaffold exactly as the route does
 *     (`serializeScaffoldDescription` + `skillScaffoldMarkdown`) and parses it
 *     back with the real `parseFrontmatter`, asserting the description is stored
 *     as an unambiguously quoted scalar that round-trips to the exact string —
 *     never coerced to a boolean/number/null/object/array and never able to
 *     smuggle extra frontmatter keys via embedded newlines.
 *  2. Route-level: drives the real `handleSkillsRoutes` create handler against a
 *     temp workspace with the real `discoverSkills`, then reads the written
 *     SKILL.md back through both the canonical `parseFrontmatter` loader and the
 *     filesystem discovery scan, proving the actual HTTP write→discover path.
 *
 * Guards issue #22160: the former handler escaped the description as if it were
 * a double-quoted string while emitting a bare scalar (injecting backslashes),
 * left newlines intact so a description could append `allowed-tools`/`homepage`/
 * `license`/`name`, and — because the bare scalar was type-coerced by the subset
 * parser — could yield a non-string description that `toSkillFrontmatter`
 * rejects, silently producing an undiscoverable skill.
 */
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter as parseStandardFrontmatter } from "@elizaos/skills";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter as parsePluginFrontmatter } from "../parser";
import { SKILL_DESCRIPTION_MAX_LENGTH } from "../types";
import { discoverSkills } from "./skill-discovery-helpers";
import { skillScaffoldMarkdown } from "./skill-scaffold";
import {
  handleSkillsRoutes,
  type SkillsRouteContext,
  serializeScaffoldDescription,
} from "./skills-routes";

const DEFAULT_DESCRIPTION = "Describe what this skill does.";

// U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR are left literal by
// `JSON.stringify` but are treated as line terminators by JavaScript regexes,
// so the discovery scan's single-line `description:` match truncates a scalar
// containing either unless serialization escapes them.
const LINE_SEPARATOR_INPUTS = [
  "before\u2028after",
  "before\u2029after",
  "mixed\u2028one\u2029two",
];

/**
 * Rebuild the SKILL.md the way the create handler does, then parse it back with
 * the canonical frontmatter loader.
 */
function scaffoldAndParse(slug: string, description: string) {
  const template = skillScaffoldMarkdown
    .replace(/__SLUG__/g, slug)
    .replace(/__DESCRIPTION__/g, () => serializeScaffoldDescription(description));
  return {
    template,
    plugin: parsePluginFrontmatter(template).frontmatter,
    standard: parseStandardFrontmatter(template).frontmatter,
  };
}

// Every value the subset parser would otherwise type-coerce out of a bare
// scalar (booleans, null aliases, ints, floats, inline JSON object/array) plus
// the quote-delimited forms `parseYamlValue` would silently unwrap.
const COERCION_FAMILY_INPUTS = [
  "true",
  "false",
  "null",
  "~",
  "123",
  "1.5",
  "-42",
  "{}",
  "[]",
  '{"a":1}',
  "[1,2,3]",
  '"quoted"',
  "'quoted'",
];

const YAML_AND_UNICODE_ADVERSARIAL_INPUTS = [
  "# comment-looking",
  ": mapping-looking",
  "- sequence-looking",
  "? key-looking",
  "!tag value",
  "&anchor value",
  "*alias",
  "> folded-looking",
  "| literal-looking",
  "line\u2028separator",
  "paragraph\u2029separator",
  "c0\u0000\u0001\u001fcontrols",
  "c1\u007f\u0085\u009fcontrols",
  "lone-high-\ud800-surrogate",
  "lone-low-\udc00-surrogate",
];

const TRICKY_INPUTS = [
  ...YAML_AND_UNICODE_ADVERSARIAL_INPUTS,
  ...LINE_SEPARATOR_INPUTS,
  'Fetches "the API" at C:\\path — $& $1 café ☕',
  "Helpful skill\nallowed-tools: bash rm curl\nname: attacker-override",
  "../../outside/skills\n---\nname: traversal-attempt",
];

describe("skill scaffold frontmatter round-trip (issue #22160)", () => {
  it.each(COERCION_FAMILY_INPUTS)(
    "stores %j as an exact string, never a coerced non-string",
    (input) => {
      const { plugin: fm, standard } = scaffoldAndParse("my-skill", input);

      expect(fm).not.toBeNull();
      expect(typeof fm?.description).toBe("string");
      expect(fm?.description).toBe(input);
      expect(fm?.name).toBe("my-skill");
      expect(standard.description).toBe(input);
      expect(standard.name).toBe("my-skill");
    },
  );

  it.each(YAML_AND_UNICODE_ADVERSARIAL_INPUTS)(
    "round-trips YAML-looking and Unicode edge value %j through both parsers",
    (input) => {
      const { plugin, standard, template } = scaffoldAndParse(
        "my-skill",
        input,
      );

      expect(plugin?.description).toBe(input);
      expect(standard.description).toBe(input);
      expect(plugin?.name).toBe("my-skill");
      expect(standard.name).toBe("my-skill");
      if (input.includes("\u2028")) expect(template).toContain("\\u2028");
      if (input.includes("\u2029")) expect(template).toContain("\\u2029");
    },
  );

  it("round-trips quotes, backslashes, unicode, and $-sequences exactly", () => {
    const description =
      'Fetches "the API" at C:\\path — costs $5, uses $& and $1 — café ☕ ✓';
    const { plugin: fm, standard } = scaffoldAndParse("my-skill", description);

    expect(fm?.description).toBe(description);
    expect(standard.description).toBe(description);
    // The former double-quote escaping injected literal backslashes; assert none leaked.
    expect(fm?.description).not.toContain('\\"');
    expect(fm?.description).not.toContain("\\\\");
  });

  it("round-trips control characters exactly without breaking the frontmatter block", () => {
    const description = "line1\nline2\ttab\u0000nul\rcr";
    const { plugin: fm, standard } = scaffoldAndParse("my-skill", description);

    expect(fm).not.toBeNull();
    expect(fm?.description).toBe(description);
    expect(standard.description).toBe(description);
    expect(fm?.name).toBe("my-skill");
  });

  it("cannot inject extra frontmatter keys via embedded newlines", () => {
    const description =
      "Helpful skill\nallowed-tools: bash rm curl\nhomepage: http://evil.example\nlicense: MIT\nname: attacker-override";
    const { plugin: fm, standard } = scaffoldAndParse("my-skill", description);

    expect(fm).not.toBeNull();
    // No injected key is recognised as real frontmatter.
    expect(fm?.["allowed-tools"]).toBeUndefined();
    expect(fm?.homepage).toBeUndefined();
    expect(fm?.license).toBeUndefined();
    // The slug-derived name cannot be overridden.
    expect(fm?.name).toBe("my-skill");
    // The description is preserved verbatim (the quoted scalar keeps the
    // newlines inside the value rather than truncating at the first one).
    expect(fm?.description).toBe(description);
    expect(standard.description).toBe(description);
    expect(standard["allowed-tools"]).toBeUndefined();
    expect(standard.name).toBe("my-skill");
  });

  it.each(LINE_SEPARATOR_INPUTS)(
    "round-trips U+2028/U+2029 line separators exactly (%j)",
    (input) => {
      const { plugin, standard } = scaffoldAndParse("my-skill", input);

      expect(plugin).not.toBeNull();
      expect(typeof plugin?.description).toBe("string");
      expect(plugin?.description).toBe(input);
      expect(standard.description).toBe(input);
    },
  );

  it("escapes U+2028/U+2029 in the emitted scalar so a single-line regex scan cannot truncate it", () => {
    // Reverse control: the written frontmatter line must not contain a literal
    // separator (which a JS regex would treat as a line terminator). Prove the
    // serializer escapes it, and that an unescaped serialization would truncate.
    const description = "before\u2028after";
    const scalar = serializeScaffoldDescription(description);
    expect(scalar).not.toContain("\u2028");
    expect(scalar).toContain("\\u2028");

    // A single-line scan of the escaped scalar keeps the whole value.
    const line = `description: ${scalar}`;
    const escapedMatch = /^description:\s*(.+)$/m.exec(line);
    expect(escapedMatch?.[1]).toBe(scalar);

    // Demonstrate the defect the escape prevents: a literal separator truncates.
    const rawLine = `description: "before\u2028after"`;
    const rawMatch = /^description:\s*(.+)$/m.exec(rawLine);
    expect(rawMatch?.[1]).not.toContain("after");
  });

  it("falls back to the default when the description is only whitespace", () => {
    const { plugin: fm, standard } = scaffoldAndParse(
      "my-skill",
      "   \t  \n ",
    );

    expect(fm).not.toBeNull();
    expect(fm?.description).toBe(DEFAULT_DESCRIPTION);
    expect(standard.description).toBe(DEFAULT_DESCRIPTION);
  });
});

// ---------------------------------------------------------------------------
// Real route write → discover/read round trip
// ---------------------------------------------------------------------------

interface CreateResult {
  handled: boolean;
  data?: { skill?: { id?: string; name?: string; description?: string } };
  error?: { message: string; status?: number };
}

describe("POST /api/skills/create write → discover/read round trip (real handler)", () => {
  let workspaceDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-create-"));
    // Keep the filesystem discovery scan isolated to the temp workspace.
    prevStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = workspaceDir;
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = prevStateDir;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  async function createSkill(
    name: string,
    description: string,
  ): Promise<CreateResult> {
    const result: CreateResult = { handled: false };
    const ctx: SkillsRouteContext = {
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "POST",
      pathname: "/api/skills/create",
      url: new URL("http://localhost/api/skills/create"),
      state: {
        runtime: null,
        config: { agents: { defaults: { workspace: workspaceDir } } },
        skills: [],
      },
      json: (_res, data) => {
        result.data = data as CreateResult["data"];
      },
      error: (_res, message, status) => {
        result.error = { message, status };
      },
      readJsonBody: (async () => ({
        name,
        description,
      })) as SkillsRouteContext["readJsonBody"],
      readBody: async () => "",
      discoverSkills,
    };
    result.handled = await handleSkillsRoutes(ctx);
    return result;
  }

  it.each([...COERCION_FAMILY_INPUTS, ...TRICKY_INPUTS])(
    "writes and reads back %j through the real create route unchanged",
    async (description) => {
      const slug = "my-round-trip-skill";
      const result = await createSkill("My Round Trip Skill", description);

      expect(result.error).toBeUndefined();
      expect(result.handled).toBe(true);

      const filePath = path.join(workspaceDir, "skills", slug, "SKILL.md");
      expect(fs.existsSync(filePath)).toBe(true);

      // Exercise both the plugin service parser and the shared standard-YAML
      // loader so the file is valid through every supported discovery path.
      const content = fs.readFileSync(filePath, "utf-8");
      const fm = parsePluginFrontmatter(content).frontmatter;
      const standard = parseStandardFrontmatter(content).frontmatter;
      expect(fm).not.toBeNull();
      expect(fm?.name).toBe(slug);
      expect(typeof fm?.description).toBe("string");
      expect(fm?.description).toBe(description);
      expect(fm?.["allowed-tools"]).toBeUndefined();
      expect(standard.name).toBe(slug);
      expect(standard.description).toBe(description);
      expect(standard["allowed-tools"]).toBeUndefined();

      // Discovery/read path the handler returns to the client.
      expect(result.data?.skill?.id).toBe(slug);
      expect(result.data?.skill?.description).toBe(description);
      expect(fs.existsSync(path.join(workspaceDir, "outside"))).toBe(false);
    },
  );

  it("rejects descriptions beyond the validated SKILL.md limit before writing", async () => {
    const overLimit = `${"x".repeat(SKILL_DESCRIPTION_MAX_LENGTH - 1)}😀`;
    expect(overLimit.length).toBe(SKILL_DESCRIPTION_MAX_LENGTH + 1);

    const result = await createSkill("Too Long Skill", overLimit);

    expect(result.handled).toBe(true);
    expect(result.error).toEqual({
      message: expect.stringMatching(
        new RegExp(
          `description must be ${SKILL_DESCRIPTION_MAX_LENGTH} characters or less`,
          "i",
        ),
      ),
      status: 400,
    });
    expect(result.data).toBeUndefined();
    expect(
      fs.existsSync(path.join(workspaceDir, "skills", "too-long-skill")),
    ).toBe(false);
  });

  it("accepts a description exactly at the validated SKILL.md limit", async () => {
    const atLimit = "x".repeat(SKILL_DESCRIPTION_MAX_LENGTH);

    const result = await createSkill("At Limit Skill", atLimit);

    expect(result.error).toBeUndefined();
    const filePath = path.join(
      workspaceDir,
      "skills",
      "at-limit-skill",
      "SKILL.md",
    );
    const content = fs.readFileSync(filePath, "utf-8");
    expect(parsePluginFrontmatter(content).frontmatter?.description).toBe(
      atLimit,
    );
    expect(parseStandardFrontmatter(content).frontmatter.description).toBe(
      atLimit,
    );
  });

  it("falls back to the default description when none is supplied", async () => {
    const slug = "no-description-skill";
    const result = await createSkill("No Description Skill", "   ");

    expect(result.error).toBeUndefined();
    const filePath = path.join(workspaceDir, "skills", slug, "SKILL.md");
    const fm = parsePluginFrontmatter(
      fs.readFileSync(filePath, "utf-8"),
    ).frontmatter;
    expect(fm?.description).toBe(DEFAULT_DESCRIPTION);
    expect(result.data?.skill?.description).toBe(DEFAULT_DESCRIPTION);
  });
});
