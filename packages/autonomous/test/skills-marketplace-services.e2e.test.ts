/**
 * E2E tests for the skills marketplace lifecycle.
 *
 * Tests search, install (with security scan), uninstall, and listing flows.
 * Real filesystem operations — only git I/O and external APIs are mocked.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mutable ref — controls what files git clone creates
// ---------------------------------------------------------------------------

const { gitFixtureRef, gitSymlinksRef } = vi.hoisted(() => ({
  gitFixtureRef: { files: {} as Record<string, string> },
  gitSymlinksRef: { links: {} as Record<string, string> },
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../packages/autonomous/src/diagnostics/integration-observability.ts", () => ({
  createIntegrationTelemetrySpan: vi.fn(() => ({
    success: vi.fn(),
    failure: vi.fn(),
  })),
}));

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");

  return {
    ...actual,
    execFile: vi.fn(
      (cmd: string, args: string[], optionsOrCb: unknown, cb?: unknown) => {
        let callback = typeof optionsOrCb === "function" ? optionsOrCb : cb;
        if (!callback && typeof args === "function") callback = args as unknown;
        const cbFn = callback as (
          err: Error | null,
          stdout: string,
          stderr: string,
        ) => void;

        if (cmd === "git" && Array.isArray(args)) {
          // git clone → create fixture files at the clone target
          if (args[0] === "clone") {
            const cloneDir = args[args.length - 1];
            nodeFs.default.mkdirSync(cloneDir, { recursive: true });
            for (const [relPath, content] of Object.entries(
              gitFixtureRef.files,
            )) {
              const filePath = nodePath.default.join(cloneDir, relPath);
              nodeFs.default.mkdirSync(nodePath.default.dirname(filePath), {
                recursive: true,
              });
              nodeFs.default.writeFileSync(filePath, content);
            }
            for (const [relPath, target] of Object.entries(
              gitSymlinksRef.links,
            )) {
              const linkPath = nodePath.default.join(cloneDir, relPath);
              nodeFs.default.mkdirSync(nodePath.default.dirname(linkPath), {
                recursive: true,
              });
              nodeFs.default.symlinkSync(target, linkPath);
            }
            return process.nextTick(() => cbFn(null, "", ""));
          }
          // git sparse-checkout → noop
          if (args.includes("sparse-checkout")) {
            return process.nextTick(() => cbFn(null, "", ""));
          }
        }

        process.nextTick(() => cbFn(new Error("Mock command failed"), "", ""));
      },
    ),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;
let savedEnv: Record<string, string | undefined>;

function stubFetch(response: { ok: boolean; status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: vi.fn().mockResolvedValue(response.body),
    } as unknown as Response),
  );
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "milady-e2e-skills-"));
  workspaceDir = path.join(tmpDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });

  savedEnv = {
    MILADY_STATE_DIR: process.env.MILADY_STATE_DIR,
    SKILLS_MARKETPLACE_URL: process.env.SKILLS_MARKETPLACE_URL,
    SKILLS_REGISTRY: process.env.SKILLS_REGISTRY,
    CLAWHUB_REGISTRY: process.env.CLAWHUB_REGISTRY,
    SKILLSMP_API_KEY: process.env.SKILLSMP_API_KEY,
  };
  process.env.MILADY_STATE_DIR = tmpDir;
  delete process.env.SKILLS_REGISTRY;
  delete process.env.CLAWHUB_REGISTRY;
  delete process.env.SKILLS_MARKETPLACE_URL;
  delete process.env.SKILLSMP_API_KEY;

  gitFixtureRef.files = {};
  gitSymlinksRef.links = {};
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Skills Marketplace E2E", () => {
  describe("searchSkillsMarketplace", () => {
    it("returns structured results from clawhub API", async () => {
      stubFetch({
        ok: true,
        status: 200,
        body: {
          results: [
            {
              id: "content-marketer",
              slug: "content-marketer",
              name: "Content Marketer",
              description: "Generates marketing content",
              repository: "test-org/skills-repo",
              githubUrl:
                "https://github.com/test-org/skills-repo/tree/main/skills/content-marketer",
              path: "skills/content-marketer",
              tags: ["marketing", "content"],
              score: 0.95,
            },
            {
              id: "data-analyst",
              slug: "data-analyst",
              name: "Data Analyst",
              description: "Analyses datasets",
              repository: "test-org/skills-repo",
              path: "skills/data-analyst",
              tags: ["data"],
              score: 0.8,
            },
          ],
        },
      });

      const { searchSkillsMarketplace } = await import(
        "../packages/autonomous/src/services/skill-marketplace.ts"
      );
      const results = await searchSkillsMarketplace("marketing");

      expect(results).toHaveLength(2);
      // inferName prioritises slug > name when displayName is absent
      expect(results[0].name).toBe("content-marketer");
      expect(results[0].description).toBe("Generates marketing content");
      expect(results[0].source).toBe("clawhub");
      expect(results[0].tags).toEqual(["marketing", "content"]);
      expect(results[1].name).toBe("data-analyst");
    });

    it("returns empty array when API returns no results", async () => {
      stubFetch({ ok: true, status: 200, body: { results: [] } });

      const { searchSkillsMarketplace } = await import(
        "../packages/autonomous/src/services/skill-marketplace.ts"
      );
      const results = await searchSkillsMarketplace("nonexistent");

      expect(results).toEqual([]);
    });

    it("throws on non-OK HTTP response", async () => {
      stubFetch({ ok: false, status: 503, body: {} });

      const { searchSkillsMarketplace } = await import(
        "../packages/autonomous/src/services/skill-marketplace.ts"
      );

      await expect(searchSkillsMarketplace("test")).rejects.toThrow(
        /request failed/i,
      );
    });

    it("throws on network timeout", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(
          new Error("The operation was aborted"),
        ) as typeof globalThis.fetch;

      const { searchSkillsMarketplace } = await import(
        "../packages/autonomous/src/services/skill-marketplace.ts"
      );

      await expect(searchSkillsMarketplace("test")).rejects.toThrow(
        /timed out/i,
      );
    });
  });

  describe("installMarketplaceSkill", () => {
    it("installs skill with SKILL.md and writes record", async () => {
      gitFixtureRef.files = {
        "skills/test-skill/SKILL.md": "# Test Skill\nA valid test skill.",
        "skills/test-skill/index.ts": "export default {};",
      };

      const { installMarketplaceSkill, listInstalledMarketplaceSkills } =
        await import("../packages/autonomous/src/services/skill-marketplace.ts");

      const record = await installMarketplaceSkill(workspaceDir, {
        repository: "test-org/skills-repo",
        path: "skills/test-skill",
        name: "test-skill",
        description: "A test skill",
        source: "clawhub",
      });

      expect(record.id).toBe("test-skill");
      expect(record.repository).toBe("test-org/skills-repo");
      expect(record.path).toBe("skills/test-skill");
      expect(record.source).toBe("clawhub");
      expect(record.scanStatus).toBe("clean");

      // Verify files on disk
      const skillMd = await fs.readFile(
        path.join(record.installPath, "SKILL.md"),
        "utf-8",
      );
      expect(skillMd).toContain("Test Skill");

      // Verify scan report written
      const scanReport = JSON.parse(
        await fs.readFile(
          path.join(record.installPath, ".scan-results.json"),
          "utf-8",
        ),
      ) as Record<string, unknown>;
      expect(scanReport.status).toBe("clean");

      // Verify install record persisted
      const list = await listInstalledMarketplaceSkills(workspaceDir);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("test-skill");
    });

    it("blocks skill with binary executable files", async () => {
      gitFixtureRef.files = {
        "skills/trojan/SKILL.md": "# Trojan Skill",
        "skills/trojan/payload.exe": "MZ\x90\x00",
      };

      const { installMarketplaceSkill } = await import(
        "../packages/autonomous/src/services/skill-marketplace.ts"
      );

      await expect(
        installMarketplaceSkill(workspaceDir, {
          repository: "evil-org/trojan-repo",
          path: "skills/trojan",
          name: "trojan",
        }),
      ).rejects.toThrow(/blocked by security scan/i);

      // Verify directory was cleaned up (rollback)
      const installRoot = path.join(
        workspaceDir,
        "skills",
        ".marketplace",
        "trojan",
      );
      await expect(fs.access(installRoot)).rejects.toThrow();
    });

    it("blocks skill without SKILL.md and cleans up (rollback)", async () => {
      gitFixtureRef.files = {
        "skills/no-manifest/index.ts": "export default {};",
        "skills/no-manifest/README.md": "# No skill manifest",
      };

      const { installMarketplaceSkill } = await import(
        "../packages/autonomous/src/services/skill-marketplace.ts"
      );

      await expect(
        installMarketplaceSkill(workspaceDir, {
          repository: "test-org/bad-repo",
          path: "skills/no-manifest",
          name: "no-manifest",
        }),
      ).rejects.toThrow(/does not contain SKILL\.md/i);

      // Verify directory was cleaned up (rollback)
      const installRoot = path.join(
        workspaceDir,
        "skills",
        ".marketplace",
        "no-manifest",
      );
      await expect(fs.access(installRoot)).rejects.toThrow();
    });

    it("blocks skill with symlink escape and cleans up (rollback)", async () => {
      gitFixtureRef.files = {
        "skills/symlink-attack/SKILL.md": "# Symlink Attack",
        "skills/symlink-attack/safe.ts": "export default {};",
      };
      gitSymlinksRef.links = {
        "skills/symlink-attack/escape.lnk": "/etc/passwd",
      };

      const { installMarketplaceSkill } = await import(
        "../packages/autonomous/src/services/skill-marketplace.ts"
      );

      await expect(
        installMarketplaceSkill(workspaceDir, {
          repository: "evil-org/symlink-repo",
          path: "skills/symlink-attack",
          name: "symlink-attack",
        }),
      ).rejects.toThrow(/blocked by security scan/i);

      // Verify directory was cleaned up (rollback)
      const installRoot = path.join(
        workspaceDir,
        "skills",
        ".marketplace",
        "symlink-attack",
      );
      await expect(fs.access(installRoot)).rejects.toThrow();
    });

    it("rejects already-installed skill", async () => {
      gitFixtureRef.files = {
        "skills/dupe/SKILL.md": "# Duplicate Skill",
      };

      const { installMarketplaceSkill } = await import(
        "../packages/autonomous/src/services/skill-marketplace.ts"
      );

      // Install first time
      await installMarketplaceSkill(workspaceDir, {
        repository: "test-org/skills-repo",
        path: "skills/dupe",
        name: "dupe",
      });

      // Try to install again
      await expect(
        installMarketplaceSkill(workspaceDir, {
          repository: "test-org/skills-repo",
          path: "skills/dupe",
          name: "dupe",
        }),
      ).rejects.toThrow(/already installed/i);
    });
  });

  describe("uninstallMarketplaceSkill", () => {
    it("removes directory and record", async () => {
      gitFixtureRef.files = {
        "skills/removable/SKILL.md": "# Removable Skill",
        "skills/removable/index.ts": "export default {};",
      };

      const {
        installMarketplaceSkill,
        uninstallMarketplaceSkill,
        listInstalledMarketplaceSkills,
      } = await import("../packages/autonomous/src/services/skill-marketplace.ts");

      const record = await installMarketplaceSkill(workspaceDir, {
        repository: "test-org/skills-repo",
        path: "skills/removable",
        name: "removable",
      });

      // Verify installed
      expect(await listInstalledMarketplaceSkills(workspaceDir)).toHaveLength(
        1,
      );
      await expect(fs.access(record.installPath)).resolves.toBeUndefined();

      // Uninstall
      const removed = await uninstallMarketplaceSkill(
        workspaceDir,
        "removable",
      );
      expect(removed.id).toBe("removable");

      // Verify removed
      expect(await listInstalledMarketplaceSkills(workspaceDir)).toHaveLength(
        0,
      );
      await expect(fs.access(record.installPath)).rejects.toThrow();
    });

    it("throws for unknown skill", async () => {
      const { uninstallMarketplaceSkill } = await import(
        "../packages/autonomous/src/services/skill-marketplace.ts"
      );

      await expect(
        uninstallMarketplaceSkill(workspaceDir, "nonexistent"),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("listInstalledMarketplaceSkills", () => {
    it("returns skills sorted by date (most recent first)", async () => {
      // Write records directly for deterministic dates
      const recordsDir = path.join(workspaceDir, "skills", ".cache");
      await fs.mkdir(recordsDir, { recursive: true });

      const records = {
        "skill-old": {
          id: "skill-old",
          name: "Old Skill",
          description: "",
          repository: "org/repo",
          githubUrl: "https://github.com/org/repo",
          path: "skills/old",
          installPath: path.join(
            workspaceDir,
            "skills",
            ".marketplace",
            "skill-old",
          ),
          installedAt: "2026-01-01T00:00:00Z",
          source: "clawhub",
        },
        "skill-new": {
          id: "skill-new",
          name: "New Skill",
          description: "",
          repository: "org/repo",
          githubUrl: "https://github.com/org/repo",
          path: "skills/new",
          installPath: path.join(
            workspaceDir,
            "skills",
            ".marketplace",
            "skill-new",
          ),
          installedAt: "2026-02-15T00:00:00Z",
          source: "clawhub",
        },
      };

      await fs.writeFile(
        path.join(recordsDir, "marketplace-installs.json"),
        JSON.stringify(records, null, 2),
      );

      const { listInstalledMarketplaceSkills } = await import(
        "../packages/autonomous/src/services/skill-marketplace.ts"
      );
      const list = await listInstalledMarketplaceSkills(workspaceDir);

      expect(list).toHaveLength(2);
      expect(list[0].id).toBe("skill-new");
      expect(list[1].id).toBe("skill-old");
    });

    it("returns empty array when no skills installed", async () => {
      const { listInstalledMarketplaceSkills } = await import(
        "../packages/autonomous/src/services/skill-marketplace.ts"
      );
      const list = await listInstalledMarketplaceSkills(workspaceDir);
      expect(list).toEqual([]);
    });
  });
});
