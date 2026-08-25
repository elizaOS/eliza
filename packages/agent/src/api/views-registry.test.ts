/**
 * Unit coverage for the in-process view registry.
 *
 * Drives the real module: registration, listing (order / ties / empty /
 * single-element / viewType preference), lookup, unregistration of a missing
 * plugin, disk-path confinement, hero probing, and built-in idempotency.
 * No HTTP server and no mocks of the registry itself.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Plugin, ViewDeclaration } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ViewRegistryEntry } from "./views-registry.js";
import {
  bindPluginPackageDirectory,
  findHeroOnDisk,
  generateViewHeroSvg,
  getBundleDiskPath,
  getFrameDiskPath,
  getHeroDiskPath,
  getView,
  listViews,
  pluginPackageNameCandidates,
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.js";

const PLUGIN = "@elizaos/plugin-vr-unit";
const PLUGIN_B = "@elizaos/plugin-vr-unit-b";
const BUILTIN_PLUGIN = "@elizaos/builtin";
const FIXTURE_DIR = "/tmp/does-not-need-to-exist-for-url-views";

const tmpDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function pluginWith(name: string, views: ViewDeclaration[]): Plugin {
  return {
    name,
    description: "views-registry unit fixture",
    views,
  } as Plugin;
}

function urlView(
  id: string,
  overrides: Omit<ViewDeclaration, "id"> = { label: id },
): ViewDeclaration {
  const { label: overrideLabel, ...rest } = overrides;
  return {
    bundleUrl: "https://example.invalid/bundle.js",
    ...rest,
    id,
    label: overrideLabel,
  };
}

function diskLookup(partial: {
  pluginDir?: string;
  bundlePath?: string;
  framePath?: string;
  heroImagePath?: string;
}): ViewRegistryEntry {
  return {
    id: "vr-unit-lookup",
    label: "lookup",
    viewType: "gui",
    pluginName: PLUGIN,
    hasHeroImage: false,
    available: false,
    loadedAt: 0,
    platform: "web",
    pluginDir: partial.pluginDir,
    bundlePath: partial.bundlePath,
    framePath: partial.framePath,
    heroImagePath: partial.heroImagePath,
  };
}

function fixtureIds(entries: { id: string }[]): string[] {
  return entries.map((entry) => entry.id).filter((id) => id.startsWith("vr-"));
}

/** Disk helpers return `realpath` results (`/var/folders` → `/private/var/folders` on macOS). */
function realPathUnder(root: string, ...parts: string[]): string {
  return path.join(realpathSync(root), ...parts);
}

beforeEach(() => {
  unregisterPluginViews(PLUGIN);
  unregisterPluginViews(PLUGIN_B);
  unregisterPluginViews(BUILTIN_PLUGIN);
});

afterEach(async () => {
  unregisterPluginViews(PLUGIN);
  unregisterPluginViews(PLUGIN_B);
  unregisterPluginViews(BUILTIN_PLUGIN);
  await Promise.all(
    tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("pluginPackageNameCandidates", () => {
  it("returns a scoped name as the sole candidate", () => {
    expect(pluginPackageNameCandidates("@elizaos/plugin-inbox")).toEqual([
      "@elizaos/plugin-inbox",
    ]);
  });

  it("prefers @elizaos/plugin-<short> before a bare short name", () => {
    expect(pluginPackageNameCandidates("birdclaw")).toEqual([
      "@elizaos/plugin-birdclaw",
      "birdclaw",
    ]);
  });

  it("strips a plugin- prefix before building the canonical scoped name", () => {
    expect(pluginPackageNameCandidates("plugin-health")).toEqual([
      "@elizaos/plugin-health",
      "plugin-health",
    ]);
  });
});

describe("listViews", () => {
  it("returns an empty list when the registry has no entries", () => {
    expect(listViews()).toEqual([]);
    expect(listViews({ includeAllKinds: true })).toEqual([]);
  });

  it("returns the single registered view", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [urlView("vr-solo", { label: "Solo" })]),
      FIXTURE_DIR,
    );
    const listed = listViews({ includeAllKinds: true });
    expect(fixtureIds(listed)).toEqual(["vr-solo"]);
    expect(listed[0]?.label).toBe("Solo");
    expect(listed[0]?.pluginName).toBe(PLUGIN);
  });

  it("orders by order ascending, defaulting a missing order to 100", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr-late", { label: "Late", order: 50 }),
        urlView("vr-early", { label: "Early", order: 1 }),
        urlView("vr-default", { label: "Default" }),
        urlView("vr-zero", { label: "Zero", order: 0 }),
      ]),
      FIXTURE_DIR,
    );
    expect(fixtureIds(listViews({ includeAllKinds: true }))).toEqual([
      "vr-zero",
      "vr-early",
      "vr-late",
      "vr-default",
    ]);
  });

  it("breaks order ties by label, then by id", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr-b", { label: "Same", order: 10 }),
        urlView("vr-a", { label: "Same", order: 10 }),
        urlView("vr-c", { label: "Alpha", order: 10 }),
      ]),
      FIXTURE_DIR,
    );
    expect(fixtureIds(listViews({ includeAllKinds: true }))).toEqual([
      "vr-c",
      "vr-a",
      "vr-b",
    ]);
  });

  it("omits a tui-only view from the default gui listing", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr-tui-only", { label: "TUI", viewType: "tui" }),
      ]),
      FIXTURE_DIR,
    );
    expect(fixtureIds(listViews({ includeAllKinds: true }))).toEqual([]);
    expect(
      fixtureIds(listViews({ includeAllKinds: true, viewType: "tui" })),
    ).toEqual(["vr-tui-only"]);
  });

  it("prefers the requested viewType over the gui fallback for the same id", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr-dual", {
          label: "Dual",
          modalities: ["gui", "tui"],
        }),
      ]),
      FIXTURE_DIR,
    );
    const asGui = listViews({ includeAllKinds: true }).find(
      (entry) => entry.id === "vr-dual",
    );
    const asTui = listViews({
      includeAllKinds: true,
      viewType: "tui",
    }).find((entry) => entry.id === "vr-dual");
    expect(asGui?.viewType).toBe("gui");
    expect(asTui?.viewType).toBe("tui");
  });

  it("still lists a gui view when a different viewType is requested", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [urlView("vr-gui-fallback", { label: "GUI" })]),
      FIXTURE_DIR,
    );
    expect(
      fixtureIds(listViews({ includeAllKinds: true, viewType: "xr" })),
    ).toEqual(["vr-gui-fallback"]);
  });
});

describe("getView", () => {
  it("returns undefined for a missing id", () => {
    expect(getView("vr-does-not-exist")).toBeUndefined();
  });

  it("returns the registered gui entry and falls back from a missing type", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [urlView("vr-lookup", { label: "Lookup" })]),
      FIXTURE_DIR,
    );
    expect(getView("vr-lookup")?.label).toBe("Lookup");
    expect(getView("vr-lookup", { viewType: "tui" })?.viewType).toBe("gui");
  });

  it("returns the exact tui entry when that type is registered", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr-typed", {
          label: "Typed",
          modalities: ["gui", "tui"],
        }),
      ]),
      FIXTURE_DIR,
    );
    expect(getView("vr-typed", { viewType: "tui" })?.viewType).toBe("tui");
    expect(getView("vr-typed")?.viewType).toBe("gui");
  });
});

describe("registerPluginViews / unregisterPluginViews", () => {
  it("is a no-op for a missing views array or an empty views array", async () => {
    await registerPluginViews(
      { name: PLUGIN, description: "none" } as Plugin,
      FIXTURE_DIR,
    );
    await registerPluginViews(pluginWith(PLUGIN, []), FIXTURE_DIR);
    expect(listViews({ includeAllKinds: true })).toEqual([]);
  });

  it("does not unregister existing entries when a later call has no views", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [urlView("vr-keep", { label: "Keep" })]),
      FIXTURE_DIR,
    );
    await registerPluginViews(pluginWith(PLUGIN, []), FIXTURE_DIR);
    expect(fixtureIds(listViews({ includeAllKinds: true }))).toEqual([
      "vr-keep",
    ]);
  });

  it("replaces a plugin's views on a non-empty re-register", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [urlView("vr-old", { label: "Old" })]),
      FIXTURE_DIR,
    );
    await registerPluginViews(
      pluginWith(PLUGIN, [urlView("vr-new", { label: "New" })]),
      FIXTURE_DIR,
    );
    expect(fixtureIds(listViews({ includeAllKinds: true }))).toEqual([
      "vr-new",
    ]);
    expect(getView("vr-old")).toBeUndefined();
  });

  it("keeps the first plugin when a second plugin reuses the same id", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [urlView("vr-conflict", { label: "First" })]),
      FIXTURE_DIR,
    );
    await registerPluginViews(
      pluginWith(PLUGIN_B, [urlView("vr-conflict", { label: "Second" })]),
      FIXTURE_DIR,
    );
    expect(getView("vr-conflict")?.pluginName).toBe(PLUGIN);
    expect(getView("vr-conflict")?.label).toBe("First");
  });

  it("treats unregistering a missing plugin as a no-op", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [urlView("vr-stay", { label: "Stay" })]),
      FIXTURE_DIR,
    );
    unregisterPluginViews("@elizaos/plugin-vr-unit-missing");
    expect(fixtureIds(listViews({ includeAllKinds: true }))).toEqual([
      "vr-stay",
    ]);
  });

  it("removes only the named plugin's views", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [urlView("vr-a", { label: "A" })]),
      FIXTURE_DIR,
    );
    await registerPluginViews(
      pluginWith(PLUGIN_B, [urlView("vr-b", { label: "B" })]),
      FIXTURE_DIR,
    );
    unregisterPluginViews(PLUGIN);
    expect(fixtureIds(listViews({ includeAllKinds: true }))).toEqual(["vr-b"]);
  });

  it("uses an explicit pluginDir over a bound directory", async () => {
    const boundDir = await makeTempDir("vr-bound-");
    const explicitDir = await makeTempDir("vr-explicit-");
    const plugin = pluginWith(PLUGIN, [
      urlView("vr-dir", {
        label: "Dir",
        bundleUrl: undefined,
        bundlePath: "x",
      }),
    ]);
    bindPluginPackageDirectory(plugin, boundDir);
    await registerPluginViews(plugin, explicitDir);
    expect(getView("vr-dir")?.pluginDir).toBe(explicitDir);
  });

  it("falls back to a directory bound on the plugin object", async () => {
    const boundDir = await makeTempDir("vr-bound-only-");
    const plugin = pluginWith(PLUGIN, [
      urlView("vr-bound", {
        label: "Bound",
        bundleUrl: undefined,
        bundlePath: "missing.js",
      }),
    ]);
    bindPluginPackageDirectory(plugin, boundDir);
    await registerPluginViews(plugin);
    expect(getView("vr-bound")?.pluginDir).toBe(path.resolve(boundDir));
  });

  it("marks a bundleUrl view available even without a package directory", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [urlView("vr-remote", { label: "Remote" })]),
    );
    const entry = getView("vr-remote");
    expect(entry?.available).toBe(true);
    expect(entry?.pluginDir).toBeUndefined();
    expect(entry?.hasHeroImage).toBe(false);
    expect(entry?.platform).toBe("web");
  });

  it("marks a path-only view unavailable when the bundle file is missing", async () => {
    const pluginDir = await makeTempDir("vr-missing-bundle-");
    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr-missing-file", {
          label: "Missing",
          bundleUrl: undefined,
          bundlePath: "dist/views/bundle.js",
        }),
      ]),
      pluginDir,
    );
    expect(getView("vr-missing-file")?.available).toBe(false);
  });

  it("records hash, size, and versioned URL when the bundle file exists", async () => {
    const pluginDir = await makeTempDir("vr-bundle-");
    const relative = path.join("dist", "bundle.js");
    const absolute = path.join(pluginDir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    const contents = "export default { id: 'vr-hashed' };\n";
    await writeFile(absolute, contents);
    const expectedHash = createHash("sha256")
      .update(contents)
      .digest("hex")
      .slice(0, 12);

    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr-hashed", {
          label: "Hashed",
          bundleUrl: undefined,
          bundlePath: relative,
        }),
      ]),
      pluginDir,
    );
    const entry = getView("vr-hashed");
    expect(entry?.available).toBe(true);
    expect(entry?.bundleHash).toBe(expectedHash);
    expect(entry?.bundleSize).toBe(Buffer.byteLength(contents));
    expect(entry?.bundleUrl).toMatch(
      /^\/api\/views\/vr-hashed\/bundle\.js\?v=/,
    );
    expect(entry?.bundleUrlVersioned).toBe(
      `/api/views/vr-hashed/bundle.js?v=${expectedHash}`,
    );
  });

  it("records size for a bundle larger than the 1MiB warning threshold", async () => {
    const pluginDir = await makeTempDir("vr-large-");
    const relative = path.join("dist", "large.js");
    const absolute = path.join(pluginDir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    const oversized = Buffer.alloc(1024 * 1024 + 1, 0x61);
    await writeFile(absolute, oversized);

    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr-large", {
          label: "Large",
          bundleUrl: undefined,
          bundlePath: relative,
        }),
      ]),
      pluginDir,
    );
    expect(getView("vr-large")?.bundleSize).toBe(oversized.length);
    expect(getView("vr-large")?.available).toBe(true);
  });

  it("does not treat a disk bundle as making a sandboxed-iframe view available", async () => {
    const pluginDir = await makeTempDir("vr-sandbox-");
    const bundleRel = path.join("dist", "bundle.js");
    await mkdir(path.join(pluginDir, "dist"), { recursive: true });
    await writeFile(path.join(pluginDir, bundleRel), "export default {}\n");

    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr-sandbox", {
          label: "Sandbox",
          bundleUrl: undefined,
          bundlePath: bundleRel,
          surface: { isolation: "sandboxed-iframe" },
        }),
      ]),
      pluginDir,
    );
    expect(getView("vr-sandbox")?.available).toBe(false);
  });

  it("marks a sandboxed view available when its frame document exists", async () => {
    const pluginDir = await makeTempDir("vr-frame-");
    const frameRel = path.join("dist", "frame.html");
    await mkdir(path.join(pluginDir, "dist"), { recursive: true });
    const html = "<html><body>frame</body></html>";
    await writeFile(path.join(pluginDir, frameRel), html);
    const expectedHash = createHash("sha256")
      .update(html)
      .digest("hex")
      .slice(0, 12);

    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr-frame", {
          label: "Frame",
          bundleUrl: undefined,
          framePath: frameRel,
          surface: { isolation: "sandboxed-iframe" },
        }),
      ]),
      pluginDir,
    );
    const entry = getView("vr-frame");
    expect(entry?.available).toBe(true);
    expect(entry?.frameHash).toBe(expectedHash);
    expect(entry?.frameUrlVersioned).toBe(
      `/api/views/vr-frame/frame.html?v=${expectedHash}`,
    );
  });

  it("encodes the view id and appends viewType on non-gui asset URLs", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr unit/slash", {
          label: "Encoded",
          viewType: "tui",
          bundleUrl: undefined,
          bundlePath: "dist/bundle.js",
        }),
      ]),
      FIXTURE_DIR,
    );
    const entry = getView("vr unit/slash", { viewType: "tui" });
    expect(entry?.bundleUrl).toContain(
      "/api/views/vr%20unit%2Fslash/bundle.js",
    );
    expect(entry?.bundleUrl).toContain("viewType=tui");
    expect(entry?.heroImageUrl).toContain("viewType=tui");
  });

  it("takes the first declared platform and defaults to web", async () => {
    await registerPluginViews(
      pluginWith(PLUGIN, [
        urlView("vr-ios", {
          label: "iOS",
          platforms: ["ios", "web"],
        }),
        urlView("vr-web-default", { label: "Web" }),
      ]),
      FIXTURE_DIR,
    );
    expect(getView("vr-ios")?.platform).toBe("ios");
    expect(getView("vr-web-default")?.platform).toBe("web");
  });
});

describe("disk path confinement", () => {
  it("returns null when bundlePath or pluginDir is missing", () => {
    expect(getBundleDiskPath(diskLookup({}))).toBeNull();
    expect(
      getBundleDiskPath(diskLookup({ pluginDir: "/tmp/vr-unit" })),
    ).toBeNull();
    expect(
      getBundleDiskPath(diskLookup({ bundlePath: "dist/bundle.js" })),
    ).toBeNull();
  });

  it("returns null when framePath or pluginDir is missing", () => {
    expect(getFrameDiskPath(diskLookup({}))).toBeNull();
    expect(
      getFrameDiskPath(diskLookup({ pluginDir: "/tmp/vr-unit" })),
    ).toBeNull();
  });

  it("returns null when heroImagePath or pluginDir is missing", () => {
    expect(getHeroDiskPath(diskLookup({}))).toBeNull();
    expect(
      getHeroDiskPath(diskLookup({ pluginDir: "/tmp/vr-unit" })),
    ).toBeNull();
  });

  it("resolves a path inside the plugin root", async () => {
    const pluginDir = await makeTempDir("vr-inside-");
    const relative = path.join("dist", "bundle.js");
    await mkdir(path.join(pluginDir, "dist"), { recursive: true });
    await writeFile(path.join(pluginDir, relative), "ok\n");
    const resolved = getBundleDiskPath(
      diskLookup({ pluginDir, bundlePath: relative }),
    );
    expect(resolved).toBe(realPathUnder(pluginDir, "dist", "bundle.js"));
  });

  it("rejects a bundle path that escapes the plugin root", async () => {
    const pluginDir = await makeTempDir("vr-escape-");
    expect(
      getBundleDiskPath(
        diskLookup({
          pluginDir,
          bundlePath: path.join("..", "..", "etc", "passwd"),
        }),
      ),
    ).toBeNull();
    expect(
      getFrameDiskPath(
        diskLookup({
          pluginDir,
          framePath: path.join("..", "outside.html"),
        }),
      ),
    ).toBeNull();
    expect(
      getHeroDiskPath(
        diskLookup({
          pluginDir,
          heroImagePath: path.join("..", "secret.png"),
        }),
      ),
    ).toBeNull();
  });
});

describe("findHeroOnDisk", () => {
  it("returns null when pluginDir is missing", async () => {
    expect(await findHeroOnDisk(diskLookup({}))).toBeNull();
  });

  it("returns a declared hero when the file exists with a known extension", async () => {
    const pluginDir = await makeTempDir("vr-hero-declared-");
    const relative = path.join("assets", "card.webp");
    await mkdir(path.join(pluginDir, "assets"), { recursive: true });
    await writeFile(path.join(pluginDir, relative), "webp-bytes");
    const found = await findHeroOnDisk(
      diskLookup({ pluginDir, heroImagePath: relative }),
    );
    expect(found).toEqual({
      absolutePath: realPathUnder(pluginDir, "assets", "card.webp"),
      contentType: "image/webp",
    });
  });

  it("probes assets/hero.<ext> in preference order when no declared hero exists", async () => {
    const pluginDir = await makeTempDir("vr-hero-probe-");
    await mkdir(path.join(pluginDir, "assets"), { recursive: true });
    await writeFile(path.join(pluginDir, "assets", "hero.png"), "png");
    await writeFile(path.join(pluginDir, "assets", "hero.webp"), "webp");
    const found = await findHeroOnDisk(diskLookup({ pluginDir }));
    expect(found).toEqual({
      absolutePath: realPathUnder(pluginDir, "assets", "hero.webp"),
      contentType: "image/webp",
    });
  });

  it("skips a declared path with an unknown extension and falls back to assets/hero", async () => {
    const pluginDir = await makeTempDir("vr-hero-unknown-");
    await mkdir(path.join(pluginDir, "assets"), { recursive: true });
    await writeFile(path.join(pluginDir, "assets", "odd.gif"), "gif");
    await writeFile(path.join(pluginDir, "assets", "hero.svg"), "<svg/>");
    const found = await findHeroOnDisk(
      diskLookup({ pluginDir, heroImagePath: path.join("assets", "odd.gif") }),
    );
    expect(found).toEqual({
      absolutePath: realPathUnder(pluginDir, "assets", "hero.svg"),
      contentType: "image/svg+xml",
    });
  });

  it("returns null when nothing is on disk", async () => {
    const pluginDir = await makeTempDir("vr-hero-empty-");
    expect(await findHeroOnDisk(diskLookup({ pluginDir }))).toBeNull();
  });
});

describe("generateViewHeroSvg", () => {
  it("returns branded SVG that includes the view label", () => {
    const svg = generateViewHeroSvg("Registry Fixture", "Wallet");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Registry Fixture");
  });
});

describe("registerBuiltinViews", () => {
  it("registers first-party views as available builtins and is idempotent", () => {
    registerBuiltinViews();
    const first = listViews({ includeAllKinds: true }).filter(
      (entry) => entry.pluginName === BUILTIN_PLUGIN,
    );
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((entry) => entry.builtin === true)).toBe(true);
    expect(first.every((entry) => entry.available === true)).toBe(true);
    expect(getView("chat")?.pluginName).toBe(BUILTIN_PLUGIN);

    registerBuiltinViews();
    const second = listViews({ includeAllKinds: true }).filter(
      (entry) => entry.pluginName === BUILTIN_PLUGIN,
    );
    expect(second).toHaveLength(first.length);
  });

  it("keeps a built-in entry when a plugin later claims the same id", async () => {
    registerBuiltinViews();
    await registerPluginViews(
      pluginWith(PLUGIN, [urlView("chat", { label: "Hijack" })]),
      FIXTURE_DIR,
    );
    expect(getView("chat")?.pluginName).toBe(BUILTIN_PLUGIN);
    expect(getView("chat")?.builtin).toBe(true);
  });
});
