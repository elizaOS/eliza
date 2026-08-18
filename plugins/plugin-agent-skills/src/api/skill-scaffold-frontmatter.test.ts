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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter } from "../parser";
import { discoverSkills } from "./skill-discovery-helpers";
import { skillScaffoldMarkdown } from "./skill-scaffold";
import {
  handleSkillsRoutes,
  type SkillsRouteContext,
  serializeScaffoldDescription,
} from "./skills-routes";

const DEFAULT_DESCRIPTION = "Describe what this skill does.";

/**
 * Rebuild the SKILL.md the way the create handler does, then parse it back with
 * the canonical frontmatter loader.
 */
function scaffoldAndParse(slug: string, description: string) {
  const template = skillScaffoldMarkdown
    .replace(/__SLUG__/g, slug)
    .replace(/__DESCRIPTION__/g, () => serializeScaffoldDescription(description));
  return parseFrontmatter(template).frontmatter;
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

describe("skill scaffold frontmatter round-trip (issue #22160)", () => {
  it.each(COERCION_FAMILY_INPUTS)(
    "stores %j as an exact string, never a coerced non-string",
    (input) => {
      const fm = scaffoldAndParse("my-skill", input);

      expect(fm).not.toBeNull();
      expect(typeof fm?.description).toBe("string");
      expect(fm?.description).toBe(input);
      expect(fm?.name).toBe("my-skill");
    },
  );

  it("round-trips quotes, backslashes, unicode, and $-sequences exactly", () => {
    const description =
      'Fetches "the API" at C:\\path — costs $5, uses $& and $1 — café ☕ ✓';
    const fm = scaffoldAndParse("my-skill", description);

    expect(fm?.description).toBe(description);
    // The former double-quote escaping injected literal backslashes; assert none leaked.
    expect(fm?.description).not.toContain('\\"');
    expect(fm?.description).not.toContain("\\\\");
  });

  it("round-trips control characters exactly without breaking the frontmatter block", () => {
    const description = "line1\nline2\ttab\u0000nul\rcr";
    const fm = scaffoldAndParse("my-skill", description);

    expect(fm).not.toBeNull();
    expect(fm?.description).toBe(description);
    expect(fm?.name).toBe("my-skill");
  });

  it("cannot inject extra frontmatter keys via embedded newlines", () => {
    const description =
      "Helpful skill\nallowed-tools: bash rm curl\nhomepage: http://evil.example\nlicense: MIT\nname: attacker-override";
    const fm = scaffoldAndParse("my-skill", description);

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
  });

  it("falls back to the default when the description is only whitespace", () => {
    const fm = scaffoldAndParse("my-skill", "   \t  \n ");

    expect(fm).not.toBeNull();
    expect(fm?.description).toBe(DEFAULT_DESCRIPTION);
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

  it.each([
    ...COERCION_FAMILY_INPUTS,
    'Fetches "the API" at C:\\path — $& $1 café ☕',
    "Helpful skill\nallowed-tools: bash rm curl\nname: attacker-override",
  ])(
    "writes and reads back %j through the real create route unchanged",
    async (description) => {
      const slug = "my-round-trip-skill";
      const result = await createSkill("My Round Trip Skill", description);

      expect(result.error).toBeUndefined();
      expect(result.handled).toBe(true);

      const filePath = path.join(workspaceDir, "skills", slug, "SKILL.md");
      expect(fs.existsSync(filePath)).toBe(true);

      // Canonical loader path (the one AgentSkillsService uses).
      const fm = parseFrontmatter(fs.readFileSync(filePath, "utf-8")).frontmatter;
      expect(fm).not.toBeNull();
      expect(fm?.name).toBe(slug);
      expect(typeof fm?.description).toBe("string");
      expect(fm?.description).toBe(description);
      expect(fm?.["allowed-tools"]).toBeUndefined();

      // Discovery/read path the handler returns to the client.
      expect(result.data?.skill?.id).toBe(slug);
      expect(result.data?.skill?.description).toBe(description);
    },
  );

  it("falls back to the default description when none is supplied", async () => {
    const slug = "no-description-skill";
    const result = await createSkill("No Description Skill", "   ");

    expect(result.error).toBeUndefined();
    const filePath = path.join(workspaceDir, "skills", slug, "SKILL.md");
    const fm = parseFrontmatter(fs.readFileSync(filePath, "utf-8")).frontmatter;
    expect(fm?.description).toBe(DEFAULT_DESCRIPTION);
    expect(result.data?.skill?.description).toBe(DEFAULT_DESCRIPTION);
  });
});
