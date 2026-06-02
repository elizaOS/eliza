import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFullstackTemplateValues,
  buildPluginTemplateValues,
  getTemplateReplacementEntries,
  renderTemplateTree,
  updateManagedFiles,
} from "./scaffold.js";
import type { ProjectTemplateMetadata } from "./types.js";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "elizaos-scaffold-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function hashFor(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

describe("template value builders", () => {
  it("normalizes plugin names and preserves an existing plugin prefix", () => {
    expect(
      buildPluginTemplateValues({
        elizaVersion: "2.0.0",
        githubUsername: "alice",
        pluginDescription: "Does things",
        projectName: "Cool Search!",
        repoUrl: "https://github.com/alice/plugin-cool-search",
      }),
    ).toEqual({
      displayName: "Cool Search",
      elizaVersion: "2.0.0",
      githubUsername: "alice",
      pluginBaseName: "plugin-cool-search",
      pluginDescription: "Does things",
      pluginSnake: "plugin_cool_search",
      repoUrl: "https://github.com/alice/plugin-cool-search",
    });

    expect(
      buildPluginTemplateValues({
        elizaVersion: "2.0.0",
        githubUsername: "alice",
        pluginDescription: "Does things",
        projectName: "plugin-Already There",
        repoUrl: "repo",
      }).pluginBaseName,
    ).toBe("plugin-already-there");
  });

  it("builds fullstack defaults from normalized project names", () => {
    expect(buildFullstackTemplateValues("My App!!")).toMatchObject({
      appName: "My App",
      appUrl: "https://example.com/my-app",
      bundleId: "com.example.myapp",
      fileExtension: ".my-app.agent",
      hashtag: "#MyApp",
      packageScope: "myapp",
      projectSlug: "my-app",
      repoName: "my-app",
    });
    expect(buildFullstackTemplateValues("!!!")).toMatchObject({
      bundleId: "com.example.project",
      packageScope: "project",
      projectSlug: "project",
    });
  });
});

describe("getTemplateReplacementEntries", () => {
  it("throws when plugin template values are missing", () => {
    expect(() =>
      getTemplateReplacementEntries({
        templateId: "plugin",
        values: { pluginBaseName: "plugin-x" },
      }),
    ).toThrow(/displayName/);
  });

  it("emits package and name replacements for plugin templates", () => {
    const values = buildPluginTemplateValues({
      elizaVersion: "2.0.0",
      githubUsername: "alice",
      pluginDescription: "Does things",
      projectName: "search",
      repoUrl: "repo",
    });

    expect(
      Object.fromEntries(
        getTemplateReplacementEntries({ templateId: "plugin", values }),
      ),
    ).toMatchObject({
      "${PLUGINNAME}": "plugin-search",
      "@elizaos/plugin-starter": "@elizaos/plugin-search",
      elizaos_plugin_starter: "elizaos_plugin_search",
      "plugin-starter": "plugin-search",
      __ELIZAOS_VERSION__: "2.0.0",
    });
  });
});

describe("renderTemplateTree", () => {
  it("skips generated directories, replaces filenames/text, and preserves binary files", () =>
    withTempDir((dir) => {
      const source = join(dir, "template");
      const destination = join(dir, "out");
      mkdirSync(join(source, "src"), { recursive: true });
      mkdirSync(join(source, "node_modules"), { recursive: true });
      mkdirSync(join(source, "dist"), { recursive: true });
      writeFileSync(join(source, "template.json"), "{}");
      writeFileSync(join(source, "node_modules", "skip.txt"), "skip");
      writeFileSync(join(source, "dist", "skip.txt"), "skip");
      writeFileSync(
        join(source, "src", "__NAME__.ts"),
        "export const name = '__NAME__';",
      );
      writeFileSync(join(source, "image.png"), Buffer.from([0, 1, 2, 3]));

      const managed = renderTemplateTree({
        sourceDir: source,
        destinationDir: destination,
        replacements: [["__NAME__", "rendered"]],
      });

      expect(
        readFileSync(join(destination, "src", "rendered.ts"), "utf8"),
      ).toBe("export const name = 'rendered';");
      expect(readFileSync(join(destination, "image.png"))).toEqual(
        Buffer.from([0, 1, 2, 3]),
      );
      expect(Object.keys(managed).sort()).toEqual([
        "image.png",
        "src/rendered.ts",
      ]);
      expect(() => readFileSync(join(destination, "template.json"))).toThrow();
      expect(() =>
        readFileSync(join(destination, "node_modules", "skip.txt")),
      ).toThrow();
      expect(() =>
        readFileSync(join(destination, "dist", "skip.txt")),
      ).toThrow();
    }));

  it("rejects rendered filenames that would escape the destination", () =>
    withTempDir((dir) => {
      const source = join(dir, "template");
      const destination = join(dir, "out");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "__NAME__.ts"), "escape");

      expect(() =>
        renderTemplateTree({
          sourceDir: source,
          destinationDir: destination,
          replacements: [["__NAME__", "../outside"]],
        }),
      ).toThrow("Unsafe managed file path");
      expect(() => readFileSync(join(dir, "outside.ts"))).toThrow();
    }));
});

describe("updateManagedFiles", () => {
  function metadata(
    managedFiles: Record<string, string>,
  ): ProjectTemplateMetadata {
    return {
      cliVersion: "2.0.0",
      createdAt: "2026-01-01T00:00:00.000Z",
      managedFiles,
      templateId: "plugin",
      templateVersion: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      values: {},
    };
  }

  it("classifies unchanged, updated, created, deleted, and conflicting files", () =>
    withTempDir((dir) => {
      const projectRoot = join(dir, "project");
      const renderedDir = join(dir, "rendered");
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(renderedDir, { recursive: true });

      writeFileSync(join(projectRoot, "same.txt"), "same");
      writeFileSync(join(renderedDir, "same.txt"), "same");
      writeFileSync(join(projectRoot, "update.txt"), "old");
      writeFileSync(join(renderedDir, "update.txt"), "new");
      writeFileSync(join(renderedDir, "create.txt"), "created");
      writeFileSync(join(projectRoot, "delete.txt"), "delete");
      writeFileSync(join(projectRoot, "conflict.txt"), "local edit");
      writeFileSync(join(renderedDir, "conflict.txt"), "new conflict");

      const result = updateManagedFiles({
        projectRoot,
        renderedDir,
        currentMetadata: metadata({
          "same.txt": hashFor("same"),
          "update.txt": hashFor("old"),
          "delete.txt": hashFor("delete"),
          "conflict.txt": hashFor("old conflict"),
        }),
        renderedManagedFiles: {
          "same.txt": hashFor("same"),
          "update.txt": hashFor("new"),
          "create.txt": hashFor("created"),
          "conflict.txt": hashFor("new conflict"),
        },
      });

      expect(result).toMatchObject({
        unchanged: ["same.txt"],
        updated: ["update.txt"],
        created: ["create.txt"],
        deleted: ["delete.txt"],
        conflicts: ["conflict.txt"],
      });
      expect(result.nextManagedFiles).not.toHaveProperty("delete.txt");
      expect(result.nextManagedFiles).not.toHaveProperty("conflict.txt");
      expect(readFileSync(join(projectRoot, "update.txt"), "utf8")).toBe("new");
      expect(readFileSync(join(projectRoot, "create.txt"), "utf8")).toBe(
        "created",
      );
      expect(() => readFileSync(join(projectRoot, "delete.txt"))).toThrow();
    }));

  it("does not write during dry runs", () =>
    withTempDir((dir) => {
      const projectRoot = join(dir, "project");
      const renderedDir = join(dir, "rendered");
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(renderedDir, { recursive: true });
      writeFileSync(join(projectRoot, "update.txt"), "old");
      writeFileSync(join(renderedDir, "update.txt"), "new");

      const result = updateManagedFiles({
        projectRoot,
        renderedDir,
        dryRun: true,
        currentMetadata: metadata({ "update.txt": hashFor("old") }),
        renderedManagedFiles: { "update.txt": hashFor("new") },
      });

      expect(result.updated).toEqual(["update.txt"]);
      expect(readFileSync(join(projectRoot, "update.txt"), "utf8")).toBe("old");
    }));

  it("rejects managed metadata paths that would escape the project", () =>
    withTempDir((dir) => {
      const projectRoot = join(dir, "project");
      const renderedDir = join(dir, "rendered");
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(renderedDir, { recursive: true });
      writeFileSync(join(renderedDir, "safe.txt"), "safe");

      expect(() =>
        updateManagedFiles({
          projectRoot,
          renderedDir,
          currentMetadata: metadata({ "../outside.txt": hashFor("old") }),
          renderedManagedFiles: { "safe.txt": hashFor("safe") },
        }),
      ).toThrow("Unsafe managed file path");
      expect(() => readFileSync(join(dir, "outside.txt"))).toThrow();
    }));
});
