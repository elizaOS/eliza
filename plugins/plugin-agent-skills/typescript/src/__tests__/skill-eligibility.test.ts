/**
 * Skill Eligibility Tests
 *
 * Tests for binary detection, environment variable checking,
 * and eligibility caching for Agent Skills.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Types
// ============================================================================

interface OttoMetadata {
  emoji?: string;
  requires?: {
    bins?: string[];
    envVars?: string[];
  };
  install?: OttoInstallOption[];
}

interface OttoInstallOption {
  id: string;
  kind: "brew" | "apt" | "node" | "pip" | "cargo" | "manual";
  formula?: string;
  package?: string;
  bins?: string[];
  label?: string;
}

interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: {
    otto?: OttoMetadata;
  };
}

interface SkillEligibility {
  eligible: boolean;
  reason?: string;
  missingBins?: string[];
  missingEnvVars?: string[];
}

// ============================================================================
// Eligibility Logic (for testing)
// ============================================================================

/**
 * Check if a binary exists in PATH
 */
function checkBinaryExists(binaryName: string): boolean {
  if (!binaryName || !binaryName.trim()) {
    return false;
  }
  const pathEnv = process.env.PATH || "";
  const pathDirs = pathEnv.split(path.delimiter);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const binPath = path.join(dir, binaryName + ext);
      try {
        fs.accessSync(binPath, fs.constants.X_OK);
        return true;
      } catch {
        // Binary not found in this location
      }
    }
  }
  return false;
}

/**
 * Check if an environment variable is set and non-empty
 */
function checkEnvVarExists(envVar: string): boolean {
  const value = process.env[envVar];
  return value !== undefined && value.trim() !== "";
}

/**
 * Check skill eligibility based on requirements
 */
function checkSkillEligibility(
  frontmatter: SkillFrontmatter,
  binChecker: (bin: string) => boolean = checkBinaryExists,
  envChecker: (envVar: string) => boolean = checkEnvVarExists
): SkillEligibility {
  const requires = frontmatter.metadata?.otto?.requires;

  if (!requires) {
    return { eligible: true };
  }

  const missingBins: string[] = [];
  const missingEnvVars: string[] = [];

  // Check required binaries
  if (requires.bins && requires.bins.length > 0) {
    for (const bin of requires.bins) {
      if (!binChecker(bin)) {
        missingBins.push(bin);
      }
    }
  }

  // Check required environment variables
  if (requires.envVars && requires.envVars.length > 0) {
    for (const envVar of requires.envVars) {
      if (!envChecker(envVar)) {
        missingEnvVars.push(envVar);
      }
    }
  }

  if (missingBins.length > 0 || missingEnvVars.length > 0) {
    return {
      eligible: false,
      reason: `Missing requirements: ${[...missingBins, ...missingEnvVars].join(", ")}`,
      missingBins: missingBins.length > 0 ? missingBins : undefined,
      missingEnvVars: missingEnvVars.length > 0 ? missingEnvVars : undefined,
    };
  }

  return { eligible: true };
}

/**
 * Eligibility cache for performance
 */
class SkillEligibilityCache {
  private cache: Map<string, { eligibility: SkillEligibility; cachedAt: number }> = new Map();
  private ttlMs: number;

  constructor(ttlMs: number = 60000) {
    this.ttlMs = ttlMs;
  }

  get(skillSlug: string): SkillEligibility | null {
    const entry = this.cache.get(skillSlug);
    if (!entry) return null;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(skillSlug);
      return null;
    }

    return entry.eligibility;
  }

  set(skillSlug: string, eligibility: SkillEligibility): void {
    this.cache.set(skillSlug, {
      eligibility,
      cachedAt: Date.now(),
    });
  }

  invalidate(skillSlug?: string): void {
    if (skillSlug) {
      this.cache.delete(skillSlug);
    } else {
      this.cache.clear();
    }
  }

  size(): number {
    return this.cache.size;
  }
}

// ============================================================================
// Test Utilities
// ============================================================================

function createTestFrontmatter(options: {
  name?: string;
  bins?: string[];
  envVars?: string[];
}): SkillFrontmatter {
  return {
    name: options.name || "test-skill",
    description: "A test skill",
    metadata: {
      otto: {
        requires: {
          bins: options.bins,
          envVars: options.envVars,
        },
      },
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Skill Eligibility", () => {
  describe("Binary Detection", () => {
    it("should detect common system binaries", () => {
      // These binaries exist on most systems
      const commonBins = process.platform === "win32" 
        ? ["cmd"]
        : ["sh", "echo"];

      for (const bin of commonBins) {
        expect(checkBinaryExists(bin)).toBe(true);
      }
    });

    it("should return false for non-existent binaries", () => {
      expect(checkBinaryExists("definitely-not-a-real-binary-xyz123")).toBe(false);
      expect(checkBinaryExists("nonexistent-tool-abc")).toBe(false);
    });

    it("should handle empty binary name", () => {
      expect(checkBinaryExists("")).toBe(false);
    });

    it("should handle binary name with spaces", () => {
      expect(checkBinaryExists("not a binary")).toBe(false);
    });
  });

  describe("Environment Variable Checking", () => {
    beforeEach(() => {
      process.env.TEST_SKILL_VAR = "test-value";
      process.env.TEST_EMPTY_VAR = "";
    });

    afterEach(() => {
      delete process.env.TEST_SKILL_VAR;
      delete process.env.TEST_EMPTY_VAR;
    });

    it("should return true for set non-empty env vars", () => {
      expect(checkEnvVarExists("TEST_SKILL_VAR")).toBe(true);
      expect(checkEnvVarExists("PATH")).toBe(true);
    });

    it("should return false for unset env vars", () => {
      expect(checkEnvVarExists("DEFINITELY_NOT_SET_XYZ123")).toBe(false);
    });

    it("should return false for empty env vars", () => {
      expect(checkEnvVarExists("TEST_EMPTY_VAR")).toBe(false);
    });

    it("should return false for whitespace-only env vars", () => {
      process.env.TEST_WHITESPACE_VAR = "   ";
      expect(checkEnvVarExists("TEST_WHITESPACE_VAR")).toBe(false);
      delete process.env.TEST_WHITESPACE_VAR;
    });
  });

  describe("checkSkillEligibility()", () => {
    it("should return eligible for skills with no requirements", () => {
      const frontmatter: SkillFrontmatter = {
        name: "no-requirements",
        description: "A skill with no requirements",
      };

      const result = checkSkillEligibility(frontmatter);

      expect(result.eligible).toBe(true);
      expect(result.missingBins).toBeUndefined();
      expect(result.missingEnvVars).toBeUndefined();
    });

    it("should return eligible when all binaries exist", () => {
      const frontmatter = createTestFrontmatter({
        bins: ["git", "node"],
      });

      // Mock binary checker to return true
      const mockBinChecker = vi.fn().mockReturnValue(true);

      const result = checkSkillEligibility(frontmatter, mockBinChecker);

      expect(result.eligible).toBe(true);
      expect(mockBinChecker).toHaveBeenCalledWith("git");
      expect(mockBinChecker).toHaveBeenCalledWith("node");
    });

    it("should return ineligible when binaries are missing", () => {
      const frontmatter = createTestFrontmatter({
        bins: ["missing-binary"],
      });

      const mockBinChecker = vi.fn().mockReturnValue(false);

      const result = checkSkillEligibility(frontmatter, mockBinChecker);

      expect(result.eligible).toBe(false);
      expect(result.missingBins).toContain("missing-binary");
    });

    it("should return eligible when all env vars exist", () => {
      const frontmatter = createTestFrontmatter({
        envVars: ["OPENAI_API_KEY"],
      });

      const mockEnvChecker = vi.fn().mockReturnValue(true);

      const result = checkSkillEligibility(
        frontmatter,
        () => true,
        mockEnvChecker
      );

      expect(result.eligible).toBe(true);
      expect(mockEnvChecker).toHaveBeenCalledWith("OPENAI_API_KEY");
    });

    it("should return ineligible when env vars are missing", () => {
      const frontmatter = createTestFrontmatter({
        envVars: ["MISSING_API_KEY"],
      });

      const mockEnvChecker = vi.fn().mockReturnValue(false);

      const result = checkSkillEligibility(
        frontmatter,
        () => true,
        mockEnvChecker
      );

      expect(result.eligible).toBe(false);
      expect(result.missingEnvVars).toContain("MISSING_API_KEY");
    });

    it("should check both binaries and env vars", () => {
      const frontmatter = createTestFrontmatter({
        bins: ["docker"],
        envVars: ["DOCKER_HOST"],
      });

      const mockBinChecker = vi.fn().mockReturnValue(true);
      const mockEnvChecker = vi.fn().mockReturnValue(true);

      const result = checkSkillEligibility(
        frontmatter,
        mockBinChecker,
        mockEnvChecker
      );

      expect(result.eligible).toBe(true);
      expect(mockBinChecker).toHaveBeenCalledWith("docker");
      expect(mockEnvChecker).toHaveBeenCalledWith("DOCKER_HOST");
    });

    it("should report all missing requirements", () => {
      const frontmatter = createTestFrontmatter({
        bins: ["bin1", "bin2"],
        envVars: ["VAR1", "VAR2"],
      });

      const result = checkSkillEligibility(
        frontmatter,
        () => false,
        () => false
      );

      expect(result.eligible).toBe(false);
      expect(result.missingBins).toHaveLength(2);
      expect(result.missingEnvVars).toHaveLength(2);
      expect(result.reason).toContain("bin1");
      expect(result.reason).toContain("VAR1");
    });

    it("should handle partial failures", () => {
      const frontmatter = createTestFrontmatter({
        bins: ["exists", "missing"],
      });

      const mockBinChecker = vi.fn((bin) => bin === "exists");

      const result = checkSkillEligibility(frontmatter, mockBinChecker);

      expect(result.eligible).toBe(false);
      expect(result.missingBins).toContain("missing");
      expect(result.missingBins).not.toContain("exists");
    });
  });

  describe("SkillEligibilityCache", () => {
    let cache: SkillEligibilityCache;

    beforeEach(() => {
      cache = new SkillEligibilityCache(1000); // 1 second TTL
    });

    it("should cache eligibility results", () => {
      const eligibility: SkillEligibility = { eligible: true };

      cache.set("my-skill", eligibility);
      const cached = cache.get("my-skill");

      expect(cached).toEqual(eligibility);
    });

    it("should return null for uncached skills", () => {
      const cached = cache.get("uncached-skill");

      expect(cached).toBeNull();
    });

    it("should expire cache entries after TTL", async () => {
      const cache = new SkillEligibilityCache(50); // 50ms TTL
      const eligibility: SkillEligibility = { eligible: true };

      cache.set("expiring-skill", eligibility);

      // Should exist immediately
      expect(cache.get("expiring-skill")).not.toBeNull();

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should be expired now
      expect(cache.get("expiring-skill")).toBeNull();
    });

    it("should invalidate specific skill", () => {
      cache.set("skill-a", { eligible: true });
      cache.set("skill-b", { eligible: true });

      cache.invalidate("skill-a");

      expect(cache.get("skill-a")).toBeNull();
      expect(cache.get("skill-b")).not.toBeNull();
    });

    it("should invalidate all skills", () => {
      cache.set("skill-a", { eligible: true });
      cache.set("skill-b", { eligible: true });

      cache.invalidate();

      expect(cache.get("skill-a")).toBeNull();
      expect(cache.get("skill-b")).toBeNull();
      expect(cache.size()).toBe(0);
    });

    it("should track cache size", () => {
      expect(cache.size()).toBe(0);

      cache.set("skill-1", { eligible: true });
      expect(cache.size()).toBe(1);

      cache.set("skill-2", { eligible: true });
      expect(cache.size()).toBe(2);

      cache.invalidate("skill-1");
      expect(cache.size()).toBe(1);
    });

    it("should update existing cache entry", () => {
      cache.set("my-skill", { eligible: true });
      cache.set("my-skill", { eligible: false, reason: "updated" });

      const cached = cache.get("my-skill");

      expect(cached?.eligible).toBe(false);
      expect(cached?.reason).toBe("updated");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty bins array", () => {
      const frontmatter = createTestFrontmatter({
        bins: [],
      });

      const result = checkSkillEligibility(frontmatter);

      expect(result.eligible).toBe(true);
    });

    it("should handle empty envVars array", () => {
      const frontmatter = createTestFrontmatter({
        envVars: [],
      });

      const result = checkSkillEligibility(frontmatter);

      expect(result.eligible).toBe(true);
    });

    it("should handle undefined otto metadata", () => {
      const frontmatter: SkillFrontmatter = {
        name: "no-otto",
        description: "No otto metadata",
        metadata: {},
      };

      const result = checkSkillEligibility(frontmatter);

      expect(result.eligible).toBe(true);
    });

    it("should handle undefined requires object", () => {
      const frontmatter: SkillFrontmatter = {
        name: "no-requires",
        description: "No requires",
        metadata: {
          otto: {
            emoji: "🔧",
          },
        },
      };

      const result = checkSkillEligibility(frontmatter);

      expect(result.eligible).toBe(true);
    });
  });

  describe("Install Options", () => {
    it("should parse install options from metadata", () => {
      const frontmatter: SkillFrontmatter = {
        name: "with-install",
        description: "Has install options",
        metadata: {
          otto: {
            requires: {
              bins: ["docker"],
            },
            install: [
              {
                id: "brew",
                kind: "brew",
                formula: "docker",
                bins: ["docker"],
                label: "Install via Homebrew",
              },
              {
                id: "apt",
                kind: "apt",
                package: "docker.io",
                bins: ["docker"],
                label: "Install via APT",
              },
            ],
          },
        },
      };

      const install = frontmatter.metadata?.otto?.install;

      expect(install).toHaveLength(2);
      expect(install?.[0].kind).toBe("brew");
      expect(install?.[1].kind).toBe("apt");
    });

    it("should get available install options based on platform", () => {
      const installOptions: OttoInstallOption[] = [
        { id: "brew", kind: "brew", formula: "tool" },
        { id: "apt", kind: "apt", package: "tool" },
        { id: "node", kind: "node", package: "tool" },
        { id: "pip", kind: "pip", package: "tool" },
        { id: "cargo", kind: "cargo", package: "tool" },
        { id: "manual", kind: "manual", label: "Manual install" },
      ];

      // All should be valid kinds
      for (const option of installOptions) {
        expect(["brew", "apt", "node", "pip", "cargo", "manual"]).toContain(option.kind);
      }
    });
  });
});

