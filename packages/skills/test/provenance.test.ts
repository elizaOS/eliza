import assert from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  parseFrontmatter,
  resolveSkillProvenance,
  serializeSkillFile,
} from "../src/frontmatter.js";
import { loadSkills, loadSkillsFromDir } from "../src/loader.js";
import {
  clearSkillsDirCache,
  getCuratedActiveDir,
  getProposedSkillsDir,
  promoteSkill,
} from "../src/resolver.js";
import type { SkillFrontmatter } from "../src/types.js";

function withCuratedTempDir<T>(callback: (stateDir: string) => T): T {
  const stateDir = mkdtempSync(join(tmpdir(), "skills-curated-"));
  const previousState = process.env.ELIZA_STATE_DIR;
  process.env.ELIZA_STATE_DIR = stateDir;
  clearSkillsDirCache();
  try {
    return callback(stateDir);
  } finally {
    if (previousState === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = previousState;
    }
    clearSkillsDirCache();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

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

describe("curated namespace", () => {
  it("exposes active and proposed dirs under ELIZA_STATE_DIR", () => {
    withCuratedTempDir((stateDir) => {
      assert.strictEqual(
        getCuratedActiveDir(),
        join(stateDir, "skills", "curated", "active"),
      );
      assert.strictEqual(
        getProposedSkillsDir(),
        join(stateDir, "skills", "curated", "proposed"),
      );
    });
  });

  it("loads active skills but not proposed skills", () => {
    withCuratedTempDir(() => {
      const activeDir = getCuratedActiveDir();
      const proposedDir = getProposedSkillsDir();
      mkdirSync(join(activeDir, "active-skill"), { recursive: true });
      mkdirSync(join(proposedDir, "proposed-skill"), { recursive: true });
      writeFileSync(
        join(activeDir, "active-skill", "SKILL.md"),
        `---\nname: active-skill\ndescription: An active learned skill\nprovenance:\n  source: agent-generated\n  createdAt: 2025-01-01T00:00:00Z\n  refinedCount: 0\n---\nbody\n`,
      );
      writeFileSync(
        join(proposedDir, "proposed-skill", "SKILL.md"),
        `---\nname: proposed-skill\ndescription: A proposed skill\nprovenance:\n  source: agent-generated\n  createdAt: 2025-01-01T00:00:00Z\n  refinedCount: 0\n---\nbody\n`,
      );

      const { skills } = loadSkills({
        includeDefaults: true,
        bundledSkillsDir: undefined,
      });
      const activeMatch = skills.find((s) => s.name === "active-skill");
      const proposedMatch = skills.find((s) => s.name === "proposed-skill");
      assert.ok(activeMatch, "active skill should be loaded");
      assert.strictEqual(activeMatch?.source, "curated");
      assert.strictEqual(activeMatch?.provenance?.source, "agent-generated");
      assert.strictEqual(
        proposedMatch,
        undefined,
        "proposed skill must not be loaded",
      );
    });
  });

  it("promotes a proposed skill into the active directory", () => {
    withCuratedTempDir(() => {
      const proposedDir = getProposedSkillsDir();
      mkdirSync(join(proposedDir, "promote-me"), { recursive: true });
      writeFileSync(
        join(proposedDir, "promote-me", "SKILL.md"),
        `---\nname: promote-me\ndescription: stage me\nprovenance:\n  source: agent-generated\n  createdAt: 2025-01-01T00:00:00Z\n  refinedCount: 0\n---\nbody\n`,
      );

      const dest = promoteSkill("promote-me");
      assert.strictEqual(dest, join(getCuratedActiveDir(), "promote-me"));
      const moved = readFileSync(join(dest, "SKILL.md"), "utf-8");
      assert.match(moved, /name: promote-me/);

      const { skills } = loadSkillsFromDir({
        dir: getCuratedActiveDir(),
        source: "curated",
      });
      assert.ok(skills.find((s) => s.name === "promote-me"));
    });
  });

  it("rejects invalid skill names when promoting", () => {
    withCuratedTempDir(() => {
      assert.throws(() => promoteSkill("../escape"), /Invalid skill name/);
    });
  });
});
