/**
 * Skill Precedence Tests
 *
 * Tests for skill loading precedence: workspace > managed > bundled.
 * Tests for skill override detection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Types
// ============================================================================

type SkillSource = "workspace" | "managed" | "bundled";

interface LoadedSkill {
  slug: string;
  name: string;
  description: string;
  version: string;
  content: string;
  path: string;
  source: SkillSource;
  bundledDir?: string;
  loadedAt: number;
}

interface SkillOverrideInfo {
  slug: string;
  activeSource: SkillSource;
  overriddenSources: SkillSource[];
  paths: Record<SkillSource, string | undefined>;
}

// ============================================================================
// Precedence Logic (for testing)
// ============================================================================

/**
 * Skill source precedence order (higher index = higher priority)
 */
const SOURCE_PRECEDENCE: SkillSource[] = ["bundled", "managed", "workspace"];

/**
 * Get the precedence level for a source (higher = more priority)
 */
function getSourcePrecedence(source: SkillSource): number {
  return SOURCE_PRECEDENCE.indexOf(source);
}

/**
 * Compare two skill sources, returns true if sourceA has higher precedence
 */
function hasHigherPrecedence(sourceA: SkillSource, sourceB: SkillSource): boolean {
  return getSourcePrecedence(sourceA) > getSourcePrecedence(sourceB);
}

/**
 * Skill loader that respects precedence
 */
class PrecedenceSkillLoader {
  private skills: Map<string, LoadedSkill> = new Map();
  private overrides: Map<string, SkillOverrideInfo> = new Map();

  /**
   * Load a skill with precedence checking
   */
  loadSkill(skill: LoadedSkill): boolean {
    const existing = this.skills.get(skill.slug);

    // Track override info
    let overrideInfo = this.overrides.get(skill.slug);
    if (!overrideInfo) {
      overrideInfo = {
        slug: skill.slug,
        activeSource: skill.source,
        overriddenSources: [],
        paths: { workspace: undefined, managed: undefined, bundled: undefined },
      };
      this.overrides.set(skill.slug, overrideInfo);
    }

    overrideInfo.paths[skill.source] = skill.path;

    if (existing) {
      if (hasHigherPrecedence(skill.source, existing.source)) {
        // New skill has higher precedence, override
        overrideInfo.overriddenSources.push(existing.source);
        overrideInfo.activeSource = skill.source;
        this.skills.set(skill.slug, skill);
        return true;
      } else {
        // Existing skill has higher or equal precedence, skip
        overrideInfo.overriddenSources.push(skill.source);
        return false;
      }
    }

    // No existing skill, just add
    this.skills.set(skill.slug, skill);
    return true;
  }

  /**
   * Get a loaded skill by slug
   */
  getSkill(slug: string): LoadedSkill | undefined {
    return this.skills.get(slug);
  }

  /**
   * Get all loaded skills
   */
  getAllSkills(): LoadedSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get override info for a skill
   */
  getOverrideInfo(slug: string): SkillOverrideInfo | undefined {
    return this.overrides.get(slug);
  }

  /**
   * Get all skills that are overriding others
   */
  getOverridingSkills(): SkillOverrideInfo[] {
    return Array.from(this.overrides.values()).filter(
      (info) => info.overriddenSources.length > 0
    );
  }

  /**
   * Check if a skill is from a specific source
   */
  isFromSource(slug: string, source: SkillSource): boolean {
    const skill = this.skills.get(slug);
    return skill?.source === source;
  }

  /**
   * Get skills by source
   */
  getSkillsBySource(source: SkillSource): LoadedSkill[] {
    return Array.from(this.skills.values()).filter((s) => s.source === source);
  }

  /**
   * Clear all loaded skills
   */
  clear(): void {
    this.skills.clear();
    this.overrides.clear();
  }
}

/**
 * Simulate skill discovery and loading with precedence
 */
function loadSkillsWithPrecedence(
  skillsBySource: {
    workspace?: LoadedSkill[];
    managed?: LoadedSkill[];
    bundled?: LoadedSkill[];
  },
  loadOrder: SkillSource[] = ["bundled", "managed", "workspace"]
): PrecedenceSkillLoader {
  const loader = new PrecedenceSkillLoader();

  // Load skills in specified order
  for (const source of loadOrder) {
    const skills = skillsBySource[source] || [];
    for (const skill of skills) {
      loader.loadSkill({ ...skill, source });
    }
  }

  return loader;
}

// ============================================================================
// Test Utilities
// ============================================================================

function createTestSkill(
  slug: string,
  source: SkillSource,
  version: string = "1.0.0"
): LoadedSkill {
  return {
    slug,
    name: `${slug} Skill`,
    description: `A ${source} skill called ${slug}`,
    version,
    content: `# ${slug}\nContent from ${source}`,
    path: `/test/${source}/${slug}`,
    source,
    bundledDir: source === "bundled" ? "/test/bundled" : undefined,
    loadedAt: Date.now(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Skill Precedence", () => {
  describe("Source Precedence Order", () => {
    it("should have correct precedence order", () => {
      expect(getSourcePrecedence("bundled")).toBe(0);
      expect(getSourcePrecedence("managed")).toBe(1);
      expect(getSourcePrecedence("workspace")).toBe(2);
    });

    it("should identify workspace as highest precedence", () => {
      expect(hasHigherPrecedence("workspace", "managed")).toBe(true);
      expect(hasHigherPrecedence("workspace", "bundled")).toBe(true);
    });

    it("should identify managed as higher than bundled", () => {
      expect(hasHigherPrecedence("managed", "bundled")).toBe(true);
    });

    it("should identify bundled as lowest precedence", () => {
      expect(hasHigherPrecedence("bundled", "managed")).toBe(false);
      expect(hasHigherPrecedence("bundled", "workspace")).toBe(false);
    });

    it("should return false for equal precedence", () => {
      expect(hasHigherPrecedence("workspace", "workspace")).toBe(false);
      expect(hasHigherPrecedence("managed", "managed")).toBe(false);
      expect(hasHigherPrecedence("bundled", "bundled")).toBe(false);
    });
  });

  describe("PrecedenceSkillLoader", () => {
    let loader: PrecedenceSkillLoader;

    beforeEach(() => {
      loader = new PrecedenceSkillLoader();
    });

    it("should load first skill of a slug", () => {
      const skill = createTestSkill("my-skill", "bundled");
      const loaded = loader.loadSkill(skill);

      expect(loaded).toBe(true);
      expect(loader.getSkill("my-skill")).toBeDefined();
      expect(loader.getSkill("my-skill")?.source).toBe("bundled");
    });

    it("should override bundled with managed", () => {
      const bundledSkill = createTestSkill("my-skill", "bundled");
      const managedSkill = createTestSkill("my-skill", "managed");

      loader.loadSkill(bundledSkill);
      const overridden = loader.loadSkill(managedSkill);

      expect(overridden).toBe(true);
      expect(loader.getSkill("my-skill")?.source).toBe("managed");
    });

    it("should override managed with workspace", () => {
      const managedSkill = createTestSkill("my-skill", "managed");
      const workspaceSkill = createTestSkill("my-skill", "workspace");

      loader.loadSkill(managedSkill);
      const overridden = loader.loadSkill(workspaceSkill);

      expect(overridden).toBe(true);
      expect(loader.getSkill("my-skill")?.source).toBe("workspace");
    });

    it("should override bundled with workspace", () => {
      const bundledSkill = createTestSkill("my-skill", "bundled");
      const workspaceSkill = createTestSkill("my-skill", "workspace");

      loader.loadSkill(bundledSkill);
      const overridden = loader.loadSkill(workspaceSkill);

      expect(overridden).toBe(true);
      expect(loader.getSkill("my-skill")?.source).toBe("workspace");
    });

    it("should not override workspace with managed", () => {
      const workspaceSkill = createTestSkill("my-skill", "workspace");
      const managedSkill = createTestSkill("my-skill", "managed");

      loader.loadSkill(workspaceSkill);
      const overridden = loader.loadSkill(managedSkill);

      expect(overridden).toBe(false);
      expect(loader.getSkill("my-skill")?.source).toBe("workspace");
    });

    it("should not override managed with bundled", () => {
      const managedSkill = createTestSkill("my-skill", "managed");
      const bundledSkill = createTestSkill("my-skill", "bundled");

      loader.loadSkill(managedSkill);
      const overridden = loader.loadSkill(bundledSkill);

      expect(overridden).toBe(false);
      expect(loader.getSkill("my-skill")?.source).toBe("managed");
    });

    it("should not override workspace with bundled", () => {
      const workspaceSkill = createTestSkill("my-skill", "workspace");
      const bundledSkill = createTestSkill("my-skill", "bundled");

      loader.loadSkill(workspaceSkill);
      const overridden = loader.loadSkill(bundledSkill);

      expect(overridden).toBe(false);
      expect(loader.getSkill("my-skill")?.source).toBe("workspace");
    });

    it("should track override info", () => {
      const bundledSkill = createTestSkill("my-skill", "bundled");
      const managedSkill = createTestSkill("my-skill", "managed");
      const workspaceSkill = createTestSkill("my-skill", "workspace");

      loader.loadSkill(bundledSkill);
      loader.loadSkill(managedSkill);
      loader.loadSkill(workspaceSkill);

      const info = loader.getOverrideInfo("my-skill");

      expect(info).toBeDefined();
      expect(info?.activeSource).toBe("workspace");
      expect(info?.overriddenSources).toContain("bundled");
      expect(info?.overriddenSources).toContain("managed");
      expect(info?.paths.workspace).toBeDefined();
      expect(info?.paths.managed).toBeDefined();
      expect(info?.paths.bundled).toBeDefined();
    });

    it("should get all overriding skills", () => {
      loader.loadSkill(createTestSkill("skill-a", "bundled"));
      loader.loadSkill(createTestSkill("skill-a", "workspace"));
      loader.loadSkill(createTestSkill("skill-b", "managed"));

      const overriding = loader.getOverridingSkills();

      expect(overriding.length).toBe(1);
      expect(overriding[0].slug).toBe("skill-a");
    });

    it("should load multiple different skills", () => {
      loader.loadSkill(createTestSkill("skill-a", "bundled"));
      loader.loadSkill(createTestSkill("skill-b", "managed"));
      loader.loadSkill(createTestSkill("skill-c", "workspace"));

      expect(loader.getAllSkills()).toHaveLength(3);
      expect(loader.getSkill("skill-a")).toBeDefined();
      expect(loader.getSkill("skill-b")).toBeDefined();
      expect(loader.getSkill("skill-c")).toBeDefined();
    });

    it("should check source correctly", () => {
      loader.loadSkill(createTestSkill("skill-a", "bundled"));
      loader.loadSkill(createTestSkill("skill-b", "managed"));
      loader.loadSkill(createTestSkill("skill-c", "workspace"));

      expect(loader.isFromSource("skill-a", "bundled")).toBe(true);
      expect(loader.isFromSource("skill-a", "managed")).toBe(false);
      expect(loader.isFromSource("skill-b", "managed")).toBe(true);
      expect(loader.isFromSource("skill-c", "workspace")).toBe(true);
    });

    it("should get skills by source", () => {
      loader.loadSkill(createTestSkill("skill-a", "bundled"));
      loader.loadSkill(createTestSkill("skill-b", "bundled"));
      loader.loadSkill(createTestSkill("skill-c", "managed"));
      loader.loadSkill(createTestSkill("skill-d", "workspace"));

      expect(loader.getSkillsBySource("bundled")).toHaveLength(2);
      expect(loader.getSkillsBySource("managed")).toHaveLength(1);
      expect(loader.getSkillsBySource("workspace")).toHaveLength(1);
    });

    it("should clear all skills", () => {
      loader.loadSkill(createTestSkill("skill-a", "bundled"));
      loader.loadSkill(createTestSkill("skill-b", "managed"));

      loader.clear();

      expect(loader.getAllSkills()).toHaveLength(0);
      expect(loader.getOverrideInfo("skill-a")).toBeUndefined();
    });
  });

  describe("loadSkillsWithPrecedence()", () => {
    it("should load skills in correct order for workspace override", () => {
      const bundledSkills = [createTestSkill("common", "bundled", "1.0.0")];
      const workspaceSkills = [createTestSkill("common", "workspace", "2.0.0")];

      const loader = loadSkillsWithPrecedence({
        bundled: bundledSkills,
        workspace: workspaceSkills,
      });

      const skill = loader.getSkill("common");
      expect(skill?.source).toBe("workspace");
      expect(skill?.version).toBe("2.0.0");
    });

    it("should respect custom load order", () => {
      const bundledSkills = [createTestSkill("skill", "bundled")];
      const managedSkills = [createTestSkill("skill", "managed")];

      // Load in reverse order (workspace first, bundled last)
      // Bundled should NOT override workspace
      const loader = loadSkillsWithPrecedence(
        {
          bundled: bundledSkills,
          managed: managedSkills,
        },
        ["managed", "bundled"] // Load managed first, then try bundled
      );

      // Managed was loaded first, bundled can't override it
      expect(loader.getSkill("skill")?.source).toBe("managed");
    });

    it("should load unique skills from all sources", () => {
      const loader = loadSkillsWithPrecedence({
        bundled: [createTestSkill("bundled-only", "bundled")],
        managed: [createTestSkill("managed-only", "managed")],
        workspace: [createTestSkill("workspace-only", "workspace")],
      });

      expect(loader.getAllSkills()).toHaveLength(3);
      expect(loader.getSkillsBySource("bundled")).toHaveLength(1);
      expect(loader.getSkillsBySource("managed")).toHaveLength(1);
      expect(loader.getSkillsBySource("workspace")).toHaveLength(1);
    });
  });

  describe("Skill Override Detection", () => {
    it("should detect when workspace overrides bundled", () => {
      const loader = new PrecedenceSkillLoader();

      loader.loadSkill(createTestSkill("skill", "bundled"));
      loader.loadSkill(createTestSkill("skill", "workspace"));

      const info = loader.getOverrideInfo("skill");

      expect(info?.activeSource).toBe("workspace");
      expect(info?.overriddenSources).toContain("bundled");
    });

    it("should detect when managed overrides bundled", () => {
      const loader = new PrecedenceSkillLoader();

      loader.loadSkill(createTestSkill("skill", "bundled"));
      loader.loadSkill(createTestSkill("skill", "managed"));

      const info = loader.getOverrideInfo("skill");

      expect(info?.activeSource).toBe("managed");
      expect(info?.overriddenSources).toContain("bundled");
    });

    it("should track all paths even when overridden", () => {
      const loader = new PrecedenceSkillLoader();

      loader.loadSkill(createTestSkill("skill", "bundled"));
      loader.loadSkill(createTestSkill("skill", "managed"));
      loader.loadSkill(createTestSkill("skill", "workspace"));

      const info = loader.getOverrideInfo("skill");

      expect(info?.paths.bundled).toBe("/test/bundled/skill");
      expect(info?.paths.managed).toBe("/test/managed/skill");
      expect(info?.paths.workspace).toBe("/test/workspace/skill");
    });

    it("should not mark non-overriding skills as overriding", () => {
      const loader = new PrecedenceSkillLoader();

      loader.loadSkill(createTestSkill("unique-skill", "bundled"));

      const info = loader.getOverrideInfo("unique-skill");

      expect(info?.overriddenSources).toHaveLength(0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty skill lists", () => {
      const loader = loadSkillsWithPrecedence({});

      expect(loader.getAllSkills()).toHaveLength(0);
    });

    it("should handle single source only", () => {
      const loader = loadSkillsWithPrecedence({
        managed: [
          createTestSkill("skill-a", "managed"),
          createTestSkill("skill-b", "managed"),
        ],
      });

      expect(loader.getAllSkills()).toHaveLength(2);
      expect(loader.getSkillsBySource("managed")).toHaveLength(2);
    });

    it("should handle same skill loaded multiple times from same source", () => {
      const loader = new PrecedenceSkillLoader();

      const skill1 = createTestSkill("skill", "bundled");
      const skill2 = createTestSkill("skill", "bundled");
      skill2.version = "2.0.0";

      loader.loadSkill(skill1);
      loader.loadSkill(skill2); // Should not override (same precedence)

      expect(loader.getSkill("skill")?.version).toBe("1.0.0");
    });

    it("should handle special characters in skill slugs", () => {
      const loader = new PrecedenceSkillLoader();

      loader.loadSkill(createTestSkill("my-skill-2", "bundled"));
      loader.loadSkill(createTestSkill("my_skill_v2", "managed"));

      expect(loader.getSkill("my-skill-2")).toBeDefined();
      expect(loader.getSkill("my_skill_v2")).toBeDefined();
    });
  });

  describe("Real-World Scenarios", () => {
    it("should allow user to customize bundled skill", () => {
      // Bundled skill provides default behavior
      const bundledGitSkill = createTestSkill("git", "bundled");
      bundledGitSkill.content = "Default git instructions";

      // User creates workspace override with custom instructions
      const workspaceGitSkill = createTestSkill("git", "workspace");
      workspaceGitSkill.content = "Custom git instructions for this project";

      const loader = loadSkillsWithPrecedence({
        bundled: [bundledGitSkill],
        workspace: [workspaceGitSkill],
      });

      const activeSkill = loader.getSkill("git");
      expect(activeSkill?.content).toBe("Custom git instructions for this project");
      expect(activeSkill?.source).toBe("workspace");

      // Original is still trackable
      const info = loader.getOverrideInfo("git");
      expect(info?.paths.bundled).toBeDefined();
    });

    it("should allow installed skill to override bundled", () => {
      const bundledDocker = createTestSkill("docker", "bundled");
      bundledDocker.version = "1.0.0";

      // User installs newer version from registry
      const installedDocker = createTestSkill("docker", "managed");
      installedDocker.version = "2.0.0";

      const loader = loadSkillsWithPrecedence({
        bundled: [bundledDocker],
        managed: [installedDocker],
      });

      expect(loader.getSkill("docker")?.version).toBe("2.0.0");
    });

    it("should give user full control with workspace skills", () => {
      const loader = loadSkillsWithPrecedence({
        bundled: [createTestSkill("skill", "bundled")],
        managed: [createTestSkill("skill", "managed")],
        workspace: [createTestSkill("skill", "workspace")],
      });

      // Workspace always wins
      expect(loader.getSkill("skill")?.source).toBe("workspace");

      // Both bundled and managed were overridden
      const info = loader.getOverrideInfo("skill");
      expect(info?.overriddenSources).toHaveLength(2);
    });
  });
});
