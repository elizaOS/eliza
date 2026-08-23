import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock("node:path", () => ({
  join: (...parts: string[]) => parts.join("/"),
}));
vi.mock("./package-info.js", () => ({
  getPackageRoot: () => "/pkg",
}));

import * as fs from "node:fs";

const MANIFEST = {
  templates: [
    { id: "plugin", aliases: ["pl"], name: "Plugin" },
    { id: "project", name: "Project" },
  ],
};

async function freshModule() {
  vi.resetModules();
  return await import("./manifest.ts");
}

beforeEach(() => {
  vi.clearAllMocks();
  (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
    JSON.stringify(MANIFEST),
  );
});

describe("loadManifest", () => {
  it("loads and caches the manifest", async () => {
    const { loadManifest } = await freshModule();
    const m1 = loadManifest();
    const m2 = loadManifest();
    expect(m1.templates).toHaveLength(2);
    expect(m2).toBe(m1); // cached
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("throws when the manifest is missing", async () => {
    const { loadManifest } = await freshModule();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(() => loadManifest()).toThrow("templates-manifest.json");
  });
});

describe("getTemplates / getTemplateById", () => {
  it("returns all templates", async () => {
    const { getTemplates } = await freshModule();
    expect(getTemplates()).toHaveLength(2);
  });

  it("finds by id and alias", async () => {
    const { getTemplateById } = await freshModule();
    expect(getTemplateById("plugin")?.name).toBe("Plugin");
    expect(getTemplateById("pl")?.name).toBe("Plugin");
    expect(getTemplateById("missing")).toBeUndefined();
  });
});
