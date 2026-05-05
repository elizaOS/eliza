import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { getTemplateById } from "../manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, "..", "..");

describe("templates-manifest.json", () => {
  test("manifest file exists", () => {
    expect(
      fs.existsSync(path.join(PACKAGE_ROOT, "templates-manifest.json")),
    ).toBe(true);
  });

  test("manifest contains expected template entries", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(PACKAGE_ROOT, "templates-manifest.json"),
        "utf-8",
      ),
    );

    expect(Array.isArray(manifest.templates)).toBe(true);
    expect(
      manifest.templates.map((template: { id: string }) => template.id),
    ).toEqual(expect.arrayContaining(["plugin", "project"]));
    expect(getTemplateById("project")?.id).toBe("project");
  });

  test("project template is package-first by default", () => {
    const projectTemplate = getTemplateById("project");
    expect(projectTemplate?.upstream).toBeUndefined();

    const packageJson = JSON.parse(
      fs.readFileSync(
        path.join(PACKAGE_ROOT, "templates", "project", "package.json"),
        "utf-8",
      ),
    );
    expect(packageJson.workspaces).toEqual(["apps/*"]);
    expect(JSON.stringify(packageJson)).not.toContain("eliza/packages");

    const appPackageJson = JSON.parse(
      fs.readFileSync(
        path.join(
          PACKAGE_ROOT,
          "templates",
          "project",
          "apps",
          "app",
          "package.json",
        ),
        "utf-8",
      ),
    );
    for (const [name, spec] of Object.entries(
      appPackageJson.dependencies ?? {},
    )) {
      if (String(name).startsWith("@elizaos/")) {
        expect(spec).not.toBe("workspace:*");
      }
    }
  });

  test("packaged templates directory contains the expected source templates", () => {
    expect(fs.existsSync(path.join(PACKAGE_ROOT, "templates", "plugin"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(PACKAGE_ROOT, "templates", "project"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(PACKAGE_ROOT, "templates", "min-project")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(PACKAGE_ROOT, "templates", "min-plugin")),
    ).toBe(true);
  });
});
