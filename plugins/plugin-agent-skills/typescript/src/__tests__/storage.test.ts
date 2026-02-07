/**
 * Storage Tests
 *
 * Tests for the skill storage abstraction layer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  MemorySkillStore,
  FileSystemSkillStore,
  createStorage,
  loadSkillFromStorage,
  type SkillPackage,
} from "../storage";

// ============================================================
// TEST DATA
// ============================================================

const TEST_SKILL_MD = `---
name: Test Skill
description: A test skill for unit tests
license: MIT
compatibility: Claude
---

# Test Skill

This is a test skill.

## Usage

Follow these instructions...
`;

const TEST_SKILL_MD_WITH_SCRIPTS = `---
name: Scripted Skill
description: A skill with scripts
license: MIT
compatibility: Claude
metadata:
  version: 1.0.0
  otto:
    requires:
      bins:
        - node
---

# Scripted Skill

A skill that uses scripts.
`;

// ============================================================
// MEMORY STORAGE TESTS
// ============================================================

describe("MemorySkillStore", () => {
  let store: MemorySkillStore;

  beforeEach(async () => {
    store = new MemorySkillStore("/virtual/skills");
    await store.initialize();
  });

  describe("basic operations", () => {
    it("should start empty", async () => {
      const skills = await store.listSkills();
      expect(skills).toEqual([]);
    });

    it("should report memory type", () => {
      expect(store.type).toBe("memory");
    });

    it("should save and retrieve a skill", async () => {
      const pkg: SkillPackage = {
        slug: "test-skill",
        files: new Map([
          [
            "SKILL.md",
            { path: "SKILL.md", content: TEST_SKILL_MD, isText: true },
          ],
        ]),
      };

      await store.saveSkill(pkg);

      expect(await store.hasSkill("test-skill")).toBe(true);
      expect(await store.listSkills()).toEqual(["test-skill"]);

      const content = await store.loadSkillContent("test-skill");
      expect(content).toBe(TEST_SKILL_MD);
    });

    it("should delete a skill", async () => {
      await store.saveSkill({
        slug: "to-delete",
        files: new Map([
          [
            "SKILL.md",
            { path: "SKILL.md", content: TEST_SKILL_MD, isText: true },
          ],
        ]),
      });

      expect(await store.hasSkill("to-delete")).toBe(true);
      expect(await store.deleteSkill("to-delete")).toBe(true);
      expect(await store.hasSkill("to-delete")).toBe(false);
    });

    it("should return null for non-existent skill", async () => {
      expect(await store.loadSkillContent("nonexistent")).toBeNull();
    });

    it("should get virtual path", () => {
      expect(store.getSkillPath("my-skill")).toBe("/virtual/skills/my-skill");
    });
  });

  describe("loadFromContent", () => {
    it("should load skill directly from content", async () => {
      await store.loadFromContent("direct-skill", TEST_SKILL_MD);

      expect(await store.hasSkill("direct-skill")).toBe(true);

      const content = await store.loadSkillContent("direct-skill");
      expect(content).toBe(TEST_SKILL_MD);
    });

    it("should load skill with additional files", async () => {
      const additionalFiles = new Map<string, string | Uint8Array>([
        ["scripts/run.sh", '#!/bin/bash\necho "Hello"'],
        ["references/api.md", "# API Reference"],
      ]);

      await store.loadFromContent("with-files", TEST_SKILL_MD, additionalFiles);

      const script = await store.loadFile("with-files", "scripts/run.sh");
      expect(script).toBe('#!/bin/bash\necho "Hello"');

      const ref = await store.loadFile("with-files", "references/api.md");
      expect(ref).toBe("# API Reference");
    });
  });

  describe("file listing", () => {
    it("should list files in subdirectories", async () => {
      const pkg: SkillPackage = {
        slug: "multi-file",
        files: new Map([
          [
            "SKILL.md",
            { path: "SKILL.md", content: TEST_SKILL_MD, isText: true },
          ],
          [
            "scripts/run.sh",
            { path: "scripts/run.sh", content: "#!/bin/bash", isText: true },
          ],
          [
            "scripts/test.py",
            { path: "scripts/test.py", content: 'print("test")', isText: true },
          ],
          [
            "references/guide.md",
            { path: "references/guide.md", content: "# Guide", isText: true },
          ],
        ]),
      };

      await store.saveSkill(pkg);

      const scripts = await store.listFiles("multi-file", "scripts");
      expect(scripts).toHaveLength(2);
      expect(scripts).toContain("run.sh");
      expect(scripts).toContain("test.py");

      const refs = await store.listFiles("multi-file", "references");
      expect(refs).toEqual(["guide.md"]);

      const root = await store.listFiles("multi-file");
      expect(root).toEqual(["SKILL.md"]);
    });
  });

  describe("package management", () => {
    it("should get package for export", async () => {
      const pkg: SkillPackage = {
        slug: "exportable",
        files: new Map([
          [
            "SKILL.md",
            { path: "SKILL.md", content: TEST_SKILL_MD, isText: true },
          ],
        ]),
      };

      await store.saveSkill(pkg);

      const retrieved = store.getPackage("exportable");
      expect(retrieved).toBeDefined();
      expect(retrieved?.slug).toBe("exportable");
      expect(retrieved?.files.has("SKILL.md")).toBe(true);
    });

    it("should get all packages", async () => {
      await store.saveSkill({
        slug: "skill-1",
        files: new Map([
          [
            "SKILL.md",
            { path: "SKILL.md", content: "---\nname: One\n---", isText: true },
          ],
        ]),
      });
      await store.saveSkill({
        slug: "skill-2",
        files: new Map([
          [
            "SKILL.md",
            { path: "SKILL.md", content: "---\nname: Two\n---", isText: true },
          ],
        ]),
      });

      const all = store.getAllPackages();
      expect(all.size).toBe(2);
      expect(all.has("skill-1")).toBe(true);
      expect(all.has("skill-2")).toBe(true);
    });
  });
});

// ============================================================
// FILESYSTEM STORAGE TESTS
// ============================================================

describe("FileSystemSkillStore", () => {
  const testDir = path.join(__dirname, ".test-skills");
  let store: FileSystemSkillStore;

  beforeEach(async () => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    store = new FileSystemSkillStore(testDir);
    await store.initialize();
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe("basic operations", () => {
    it("should create directory on initialize", () => {
      expect(fs.existsSync(testDir)).toBe(true);
    });

    it("should report filesystem type", () => {
      expect(store.type).toBe("filesystem");
    });

    it("should start empty", async () => {
      const skills = await store.listSkills();
      expect(skills).toEqual([]);
    });

    it("should save and retrieve a skill", async () => {
      const pkg: SkillPackage = {
        slug: "fs-skill",
        files: new Map([
          [
            "SKILL.md",
            { path: "SKILL.md", content: TEST_SKILL_MD, isText: true },
          ],
        ]),
      };

      await store.saveSkill(pkg);

      expect(await store.hasSkill("fs-skill")).toBe(true);
      expect(await store.listSkills()).toEqual(["fs-skill"]);

      const content = await store.loadSkillContent("fs-skill");
      expect(content).toBe(TEST_SKILL_MD);

      // Verify file exists on disk
      const skillPath = path.join(testDir, "fs-skill", "SKILL.md");
      expect(fs.existsSync(skillPath)).toBe(true);
    });

    it("should delete a skill", async () => {
      await store.saveSkill({
        slug: "to-remove",
        files: new Map([
          [
            "SKILL.md",
            { path: "SKILL.md", content: TEST_SKILL_MD, isText: true },
          ],
        ]),
      });

      expect(await store.hasSkill("to-remove")).toBe(true);
      expect(await store.deleteSkill("to-remove")).toBe(true);
      expect(await store.hasSkill("to-remove")).toBe(false);

      // Verify directory removed from disk
      expect(fs.existsSync(path.join(testDir, "to-remove"))).toBe(false);
    });

    it("should get absolute path", () => {
      const skillPath = store.getSkillPath("my-skill");
      expect(path.isAbsolute(skillPath)).toBe(true);
      expect(skillPath.endsWith("my-skill")).toBe(true);
    });
  });

  describe("nested file structure", () => {
    it("should create subdirectories", async () => {
      const pkg: SkillPackage = {
        slug: "nested",
        files: new Map([
          [
            "SKILL.md",
            { path: "SKILL.md", content: TEST_SKILL_MD, isText: true },
          ],
          [
            "scripts/build.sh",
            {
              path: "scripts/build.sh",
              content: "#!/bin/bash\nbuild",
              isText: true,
            },
          ],
          [
            "assets/data/config.json",
            { path: "assets/data/config.json", content: "{}", isText: true },
          ],
        ]),
      };

      await store.saveSkill(pkg);

      // Verify structure on disk
      expect(
        fs.existsSync(path.join(testDir, "nested", "scripts", "build.sh")),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(testDir, "nested", "assets", "data", "config.json"),
        ),
      ).toBe(true);

      const scripts = await store.listFiles("nested", "scripts");
      expect(scripts).toEqual(["build.sh"]);
    });
  });

  describe("binary files", () => {
    it("should handle binary content", async () => {
      const binaryData = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]); // PNG header

      const pkg: SkillPackage = {
        slug: "with-binary",
        files: new Map([
          [
            "SKILL.md",
            { path: "SKILL.md", content: TEST_SKILL_MD, isText: true },
          ],
          [
            "assets/icon.png",
            { path: "assets/icon.png", content: binaryData, isText: false },
          ],
        ]),
      };

      await store.saveSkill(pkg);

      const loaded = await store.loadFile("with-binary", "assets/icon.png");
      expect(loaded).toBeInstanceOf(Uint8Array);
      expect(loaded).toEqual(binaryData);
    });
  });
});

// ============================================================
// FACTORY FUNCTION TESTS
// ============================================================

describe("createStorage", () => {
  it("should create memory store when type is memory", () => {
    const store = createStorage({ type: "memory" });
    expect(store.type).toBe("memory");
    expect(store).toBeInstanceOf(MemorySkillStore);
  });

  it("should create filesystem store when type is filesystem", () => {
    const store = createStorage({
      type: "filesystem",
      basePath: "/tmp/test-skills",
    });
    expect(store.type).toBe("filesystem");
    expect(store).toBeInstanceOf(FileSystemSkillStore);
  });

  it("should use custom base path", () => {
    const memStore = createStorage({
      type: "memory",
      basePath: "/custom/path",
    });
    expect(memStore.getSkillPath("test")).toBe("/custom/path/test");
  });

  it("should auto-detect environment", () => {
    // In Node.js test environment, should create filesystem store
    const store = createStorage({ type: "auto" });
    expect(store.type).toBe("filesystem");
  });
});

// ============================================================
// loadSkillFromStorage TESTS
// ============================================================

describe("loadSkillFromStorage", () => {
  let store: MemorySkillStore;

  beforeEach(async () => {
    store = new MemorySkillStore();
    await store.initialize();
  });

  it("should load a valid skill", async () => {
    await store.loadFromContent("valid-skill", TEST_SKILL_MD);

    const skill = await loadSkillFromStorage(store, "valid-skill");

    expect(skill).not.toBeNull();
    expect(skill?.slug).toBe("valid-skill");
    expect(skill?.name).toBe("Test Skill");
    expect(skill?.description).toBe("A test skill for unit tests");
    expect(skill?.frontmatter.license).toBe("MIT");
  });

  it("should return null for non-existent skill", async () => {
    const skill = await loadSkillFromStorage(store, "missing");
    expect(skill).toBeNull();
  });

  it("should populate resource arrays", async () => {
    const additionalFiles = new Map<string, string>([
      ["scripts/run.sh", "#!/bin/bash"],
      ["scripts/test.py", 'print("test")'],
      ["references/api.md", "# API"],
      ["assets/logo.svg", "<svg></svg>"],
    ]);

    await store.loadFromContent(
      "with-resources",
      TEST_SKILL_MD,
      additionalFiles,
    );

    const skill = await loadSkillFromStorage(store, "with-resources");

    expect(skill?.scripts).toEqual(["run.sh", "test.py"]);
    expect(skill?.references).toEqual(["api.md"]);
    expect(skill?.assets).toEqual(["logo.svg"]);
  });

  it("should include version from metadata", async () => {
    await store.loadFromContent("versioned", TEST_SKILL_MD_WITH_SCRIPTS);

    const skill = await loadSkillFromStorage(store, "versioned");

    expect(skill?.version).toBe("1.0.0");
  });

  it("should set loadedAt timestamp", async () => {
    const before = Date.now();
    await store.loadFromContent("timed", TEST_SKILL_MD);

    const skill = await loadSkillFromStorage(store, "timed");
    const after = Date.now();

    expect(skill?.loadedAt).toBeGreaterThanOrEqual(before);
    expect(skill?.loadedAt).toBeLessThanOrEqual(after);
  });
});

// ============================================================
// REAL SKILL INTEGRATION TESTS
// ============================================================

describe("Storage with real Otto skills", () => {
  const ottoSkillsDir = path.resolve(
    __dirname,
    "../../../../../otto/skills",
  );

  it("should load skills from filesystem into memory store", async () => {
    const memStore = new MemorySkillStore();
    await memStore.initialize();

    // Read a real skill from disk and load into memory
    const githubSkillPath = path.join(ottoSkillsDir, "github", "SKILL.md");
    if (fs.existsSync(githubSkillPath)) {
      const content = fs.readFileSync(githubSkillPath, "utf-8");
      await memStore.loadFromContent("github", content);

      const skill = await loadSkillFromStorage(memStore, "github");
      expect(skill).not.toBeNull();
      // Name is lowercase as defined in the SKILL.md
      expect(skill?.name).toBe("github");
      // Metadata is parsed from embedded JSON
      expect(skill?.frontmatter.metadata).toBeDefined();
    }
  });

  it("should support transferring skills between stores", async () => {
    const fsStore = new FileSystemSkillStore(ottoSkillsDir);
    await fsStore.initialize();

    const memStore = new MemorySkillStore();
    await memStore.initialize();

    // Check if clawhub skill exists
    if (await fsStore.hasSkill("clawhub")) {
      const content = await fsStore.loadSkillContent("clawhub");
      expect(content).not.toBeNull();

      // Transfer to memory store
      await memStore.loadFromContent("clawhub", content!);

      // Verify transfer
      const memSkill = await loadSkillFromStorage(memStore, "clawhub");
      // Name is lowercase as defined in the SKILL.md
      expect(memSkill?.name).toBe("clawhub");
    }
  });
});
