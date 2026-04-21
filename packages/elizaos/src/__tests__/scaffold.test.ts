import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildFullstackTemplateValues,
  buildPluginTemplateValues,
  ensurePackageJsonWorkspaces,
  ensureUpstreamCompatibilityFiles,
  getFullstackReplacementEntries,
  getPluginReplacementEntries,
  renderTemplateTree,
  updateManagedFiles,
} from "../scaffold.js";
import type { ProjectTemplateMetadata } from "../types.js";

const tempDirs: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("template value builders", () => {
  test("builds plugin naming defaults", () => {
    const values = buildPluginTemplateValues({
      elizaVersion: "2.0.0-alpha.139",
      githubUsername: "octocat",
      pluginDescription: "Plugin Foo",
      projectName: "foo",
      repoUrl: "https://github.com/octocat/plugin-foo",
    });

    expect(values.pluginBaseName).toBe("plugin-foo");
    expect(values.pluginSnake).toBe("plugin_foo");
    expect(
      getPluginReplacementEntries(values).some(
        ([from, to]) => from === "plugin-starter" && to === "plugin-foo",
      ),
    ).toBe(true);
  });

  test("builds fullstack branding defaults", () => {
    const values = buildFullstackTemplateValues("cool app");
    expect(values.projectSlug).toBe("cool-app");
    expect(values.appName).toBe("Cool App");
    expect(
      getFullstackReplacementEntries(values).some(
        ([from, to]) =>
          from === "__APP_PACKAGE_NAME__" && to === "cool-app-app",
      ),
    ).toBe(true);
    expect(
      getFullstackReplacementEntries(values).some(
        ([from, to]) =>
          from === "__ELECTROBUN_PACKAGE_NAME__" &&
          to === "cool-app-electrobun",
      ),
    ).toBe(true);
  });
});

describe("managed file upgrades", () => {
  test("renders replacement values into file paths as well as file contents", () => {
    const sourceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "elizaos-render-src-"),
    );
    const destinationDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "elizaos-render-dest-"),
    );
    tempDirs.push(sourceDir, destinationDir);

    fs.mkdirSync(path.join(sourceDir, "src", "e2e"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "src", "e2e", "plugin-starter.e2e.ts"),
      'export const value = "plugin-starter";\n',
    );

    const values = buildPluginTemplateValues({
      elizaVersion: "2.0.0-alpha.139",
      githubUsername: "octocat",
      pluginDescription: "Plugin Foo",
      projectName: "plugin-foo",
      repoUrl: "https://github.com/octocat/plugin-foo",
    });

    const managedFiles = renderTemplateTree({
      destinationDir,
      replacements: getPluginReplacementEntries(values),
      sourceDir,
    });

    const renderedPath = path.join(
      destinationDir,
      "src",
      "e2e",
      "plugin-foo.e2e.ts",
    );
    expect(fs.existsSync(renderedPath)).toBe(true);
    expect(fs.readFileSync(renderedPath, "utf8")).toContain("plugin-foo");
    expect(managedFiles).toHaveProperty("src/e2e/plugin-foo.e2e.ts");
  });

  test("adds missing workspace entries without duplicating existing ones", () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "elizaos-workspaces-"),
    );
    tempDirs.push(projectRoot);

    const packageJsonPath = path.join(projectRoot, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      `${JSON.stringify(
        {
          name: "fixture",
          private: true,
          workspaces: ["packages/*", "plugins/plugin-sql/typescript"],
        },
        null,
        2,
      )}\n`,
    );

    expect(
      ensurePackageJsonWorkspaces(packageJsonPath, [
        "plugins/plugin-sql/typescript",
        "plugins/plugin-elizacloud/typescript",
      ]),
    ).toBe(true);

    const next = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      workspaces: string[];
    };
    expect(next.workspaces).toEqual([
      "packages/*",
      "plugins/plugin-sql/typescript",
      "plugins/plugin-elizacloud/typescript",
    ]);
  });

  test("materializes required upstream compatibility shims", () => {
    const submoduleRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "elizaos-upstream-compat-"),
    );
    tempDirs.push(submoduleRoot);

    const siblingPath = path.join(
      submoduleRoot,
      "packages",
      "shared",
      "src",
      "env-utils.impl.ts",
    );
    fs.mkdirSync(path.dirname(siblingPath), { recursive: true });
    fs.writeFileSync(
      siblingPath,
      "export function isTruthyEnvValue() { return true; }\n",
    );

    const created = ensureUpstreamCompatibilityFiles(submoduleRoot);

    expect(created).toEqual([
      "packages/shared/src/env-utils.impl.d.ts",
      "packages/shared/src/env-utils.impl.js",
    ]);
    expect(
      fs.existsSync(
        path.join(submoduleRoot, "packages/shared/src/env-utils.impl.js"),
      ),
    ).toBe(true);
  });

  test("updates untouched managed files and reports conflicts", () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "elizaos-upgrade-project-"),
    );
    const renderedDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "elizaos-upgrade-render-"),
    );
    tempDirs.push(projectRoot, renderedDir);

    fs.mkdirSync(path.join(projectRoot, "config"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "config", "safe.txt"), "old\n");
    fs.writeFileSync(
      path.join(projectRoot, "config", "conflict.txt"),
      "local\n",
    );

    fs.mkdirSync(path.join(renderedDir, "config"), { recursive: true });
    fs.writeFileSync(path.join(renderedDir, "config", "safe.txt"), "new\n");
    fs.writeFileSync(
      path.join(renderedDir, "config", "conflict.txt"),
      "upstream\n",
    );
    fs.writeFileSync(path.join(renderedDir, "config", "added.txt"), "added\n");

    const metadata: ProjectTemplateMetadata = {
      cliVersion: "2.0.0-alpha.1",
      createdAt: "2026-04-14T00:00:00.000Z",
      managedFiles: {
        "config/conflict.txt": sha256("old\n"),
        "config/safe.txt": sha256("old\n"),
      },
      templateId: "fullstack-app",
      templateVersion: 1,
      updatedAt: "2026-04-14T00:00:00.000Z",
      values: {},
    };

    const result = updateManagedFiles({
      currentMetadata: metadata,
      projectRoot,
      renderedDir,
      renderedManagedFiles: {
        "config/added.txt": sha256("added\n"),
        "config/conflict.txt": sha256("upstream\n"),
        "config/safe.txt": sha256("new\n"),
      },
    });

    expect(result.updated).toEqual(["config/safe.txt"]);
    expect(result.created).toEqual(["config/added.txt"]);
    expect(result.conflicts).toEqual(["config/conflict.txt"]);
  });
});
