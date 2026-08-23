/**
 * Exercises the CLI template manifest loader (`loadManifest`, `getTemplates`,
 * `getTemplateById`, `getTemplatesDir`) against a real on-disk manifest in a
 * temporary package root. Only `getPackageRoot` is mocked so the loader reads
 * files written by the test; the filesystem and path modules are real.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the temporary package root exists before the mocked
// `getPackageRoot` is first evaluated by the module under test.
const { packageRoot } = await vi.hoisted(async () => {
  const fsModule = await import("node:fs");
  const osModule = await import("node:os");
  const pathModule = await import("node:path");
  return {
    packageRoot: fsModule.mkdtempSync(
      pathModule.join(osModule.tmpdir(), "elizaos-manifest-test-"),
    ),
  };
});

vi.mock("../package-info.js", () => ({
  getPackageRoot: () => packageRoot,
}));

const MANIFEST = {
  templates: [
    {
      id: "plugin",
      aliases: ["pl"],
      name: "Plugin",
      description: "Plugin template",
      kind: "plugin",
      version: "1.0.0",
      languages: ["typescript"],
    },
    {
      id: "project",
      name: "Project",
      description: "Project template",
      kind: "project",
      version: "1.0.0",
      languages: ["typescript"],
    },
  ],
};

const manifestPath = path.join(packageRoot, "templates-manifest.json");
const templatesDir = path.join(packageRoot, "templates");

function writeManifest(): void {
  fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST), "utf-8");
}

function removeManifest(): void {
  fs.rmSync(manifestPath, { force: true });
}

// Each test imports a fresh module instance so the module-level cache starts
// empty and cache behaviour can be asserted per test.
async function freshModule(): Promise<typeof import("../manifest.ts")> {
  vi.resetModules();
  return await import("../manifest.ts");
}

beforeEach(() => {
  writeManifest();
  fs.rmSync(templatesDir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(packageRoot, { recursive: true, force: true });
});

describe("loadManifest", () => {
  it("reads the manifest from the package root and caches it", async () => {
    const { loadManifest } = await freshModule();
    const first = loadManifest();
    expect(first.templates.map((template) => template.id)).toEqual([
      "plugin",
      "project",
    ]);

    // Deleting the file after the first load proves later calls are served
    // from the cache rather than re-reading disk.
    removeManifest();
    const second = loadManifest();
    expect(second).toBe(first);
  });

  it("throws when the manifest is missing", async () => {
    removeManifest();
    const { loadManifest } = await freshModule();
    expect(() => loadManifest()).toThrow(
      "Could not find templates-manifest.json",
    );
  });

  it("throws when the manifest is not valid JSON", async () => {
    fs.writeFileSync(manifestPath, "{ not json", "utf-8");
    const { loadManifest } = await freshModule();
    expect(() => loadManifest()).toThrow(SyntaxError);
  });
});

describe("getTemplates / getTemplateById", () => {
  it("returns every template definition", async () => {
    const { getTemplates } = await freshModule();
    expect(getTemplates()).toEqual(MANIFEST.templates);
  });

  it("finds a template by id or alias and misses unknown ids", async () => {
    const { getTemplateById } = await freshModule();
    expect(getTemplateById("plugin")?.name).toBe("Plugin");
    expect(getTemplateById("pl")?.name).toBe("Plugin");
    expect(getTemplateById("project")?.name).toBe("Project");
    expect(getTemplateById("missing")).toBeUndefined();
  });

  it("does not match an alias that belongs to no template", async () => {
    const { getTemplateById } = await freshModule();
    expect(getTemplateById("pr")).toBeUndefined();
  });
});

describe("getTemplatesDir", () => {
  it("returns the templates directory under the package root", async () => {
    fs.mkdirSync(templatesDir, { recursive: true });
    const { getTemplatesDir } = await freshModule();
    expect(getTemplatesDir()).toBe(templatesDir);
  });

  it("throws when the templates directory is absent", async () => {
    const { getTemplatesDir } = await freshModule();
    expect(() => getTemplatesDir()).toThrow(
      "Could not find templates directory",
    );
  });
});
