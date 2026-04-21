import { describe, expect, test } from "vitest";
import type {
  CreateOptions,
  FullstackTemplateValues,
  PluginTemplateValues,
  TemplateDefinition,
  TemplatesManifest,
  UpgradeOptions,
} from "../types.js";

describe("TemplateDefinition", () => {
  test("supports plugin and fullstack-app templates", () => {
    const template: TemplateDefinition = {
      description: "Plugin starter",
      id: "plugin",
      kind: "plugin",
      languages: ["typescript", "python", "rust"],
      name: "plugin",
      version: 1,
    };

    expect(template.id).toBe("plugin");
    expect(template.languages).toContain("rust");
  });
});

describe("TemplatesManifest", () => {
  test("supports template collections", () => {
    const manifest: TemplatesManifest = {
      generatedAt: "2026-04-14T00:00:00.000Z",
      repoUrl: "https://github.com/elizaos/eliza",
      templates: [
        {
          description: "Fullstack workspace",
          id: "fullstack-app",
          kind: "fullstack-app",
          languages: ["typescript"],
          name: "fullstack-app",
          version: 1,
        },
      ],
      version: "1.0.0",
    };

    expect(manifest.templates).toHaveLength(1);
    expect(manifest.templates[0]?.id).toBe("fullstack-app");
  });
});

describe("Template value types", () => {
  test("plugin values capture scaffold substitutions", () => {
    const values: PluginTemplateValues = {
      displayName: "Foo",
      elizaVersion: "2.0.0-alpha.139",
      githubUsername: "octocat",
      pluginBaseName: "plugin-foo",
      pluginDescription: "plugin-foo plugin for elizaOS",
      pluginSnake: "plugin_foo",
      repoUrl: "https://github.com/octocat/plugin-foo",
    };

    expect(values.pluginBaseName).toBe("plugin-foo");
  });

  test("fullstack values capture branded workspace substitutions", () => {
    const values: FullstackTemplateValues = {
      appName: "Foo App",
      appUrl: "https://example.com/foo-app",
      bugReportUrl: "https://github.com/your-org/foo-app/issues/new",
      bundleId: "com.example.fooapp",
      docsUrl: "https://example.com/foo-app/docs",
      fileExtension: ".foo-app.agent",
      hashtag: "#FooApp",
      orgName: "your-org",
      packageScope: "fooapp",
      projectSlug: "foo-app",
      releaseBaseUrl: "https://example.com/foo-app/releases/",
      repoName: "foo-app",
    };

    expect(values.bundleId).toContain("fooapp");
  });
});

describe("CLI option types", () => {
  test("create options support template selection", () => {
    const options: CreateOptions = {
      language: "typescript",
      template: "fullstack-app",
      yes: true,
    };

    expect(options.template).toBe("fullstack-app");
  });

  test("upgrade options support dry runs", () => {
    const options: UpgradeOptions = {
      check: true,
      dryRun: true,
      skipUpstream: true,
    };

    expect(options.dryRun).toBe(true);
  });
});
