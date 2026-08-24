/**
 * Covers the dev-host stale-dist tripwire (#18737): stale/fresh/no-dist
 * classification with controlled mtimes, build outputs and test files never
 * counting as source, and the sweep warning once per stale plugin with both
 * paths and the rebuild command while skipping non-plugin entries and
 * missing roots quietly.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkPluginDistStaleness,
  warnStalePluginDists,
} from "../dev-plugin-dist-staleness.js";

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dist-stale-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a file and pin its mtime (seconds since epoch for utimesSync). */
function writeAt(filePath: string, epochSeconds: number): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "content");
  utimesSync(filePath, epochSeconds, epochSeconds);
}

function makePlugin(
  root: string,
  name: string,
  {
    distAt,
    sourceAt,
    runtimeTarget = "./dist/index.js",
  }: {
    distAt?: number;
    sourceAt?: number;
    runtimeTarget?: unknown;
  },
): string {
  const pkg = path.join(root, name);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: `@elizaos/${name}`,
      exports: { ".": runtimeTarget },
    }),
  );
  if (distAt !== undefined) {
    const distTarget =
      typeof runtimeTarget === "string" && runtimeTarget.startsWith("./dist/")
        ? runtimeTarget.slice(2)
        : "dist/index.js";
    writeAt(path.join(pkg, distTarget), distAt);
  }
  if (sourceAt !== undefined) {
    writeAt(path.join(pkg, "src", "service.ts"), sourceAt);
  }
  return pkg;
}

describe("checkPluginDistStaleness", () => {
  it("reports stale when the newest source postdates dist", () => {
    const pkg = makePlugin(tempRoot(), "plugin-a", {
      distAt: 1_000,
      sourceAt: 2_000,
    });
    const status = checkPluginDistStaleness(pkg);
    expect(status.status).toBe("stale");
    expect(status.newestSourcePath).toContain("service.ts");
  });

  it("reports fresh when dist postdates every source file", () => {
    const pkg = makePlugin(tempRoot(), "plugin-b", {
      distAt: 3_000,
      sourceAt: 2_000,
    });
    expect(checkPluginDistStaleness(pkg).status).toBe("fresh");
  });

  it("reports no-dist when the entry bundle is missing", () => {
    const pkg = makePlugin(tempRoot(), "plugin-c", { sourceAt: 2_000 });
    expect(checkPluginDistStaleness(pkg).status).toBe("no-dist");
  });

  it("follows an alternate dist entry from the package export", () => {
    const pkg = makePlugin(tempRoot(), "plugin-node-layout", {
      distAt: 1_000,
      sourceAt: 2_000,
      runtimeTarget: "./dist/node/index.node.js",
    });
    const status = checkPluginDistStaleness(pkg);
    expect(status.status).toBe("stale");
    expect(status.runtimeEntryPath).toContain(
      path.join("dist", "node", "index.node.js"),
    );
  });

  it("skips a package whose active source condition bypasses dist", () => {
    const pkg = makePlugin(tempRoot(), "plugin-source", {
      distAt: 1_000,
      sourceAt: 2_000,
      runtimeTarget: {
        "eliza-source": "./src/index.ts",
        import: "./dist/index.js",
      },
    });
    writeAt(path.join(pkg, "src", "index.ts"), 2_000);
    expect(checkPluginDistStaleness(pkg).status).toBe("source-loaded");
  });

  it("uses Bun module and Node main fallbacks when exports are absent", () => {
    const pkg = path.join(tempRoot(), "plugin-fallback");
    mkdirSync(path.join(pkg, "src"), { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@elizaos/plugin-fallback",
        module: "./src/index.ts",
        main: "./dist/index.js",
      }),
    );
    writeAt(path.join(pkg, "src", "index.ts"), 2_000);
    writeAt(path.join(pkg, "dist", "index.js"), 1_000);

    expect(
      checkPluginDistStaleness(pkg, new Set(["node", "import"])).status,
    ).toBe("stale");
    expect(
      checkPluginDistStaleness(pkg, new Set(["bun", "node", "import"])).status,
    ).toBe("source-loaded");
  });

  it("ignores build outputs, dot dirs, and test files as source", () => {
    const root = tempRoot();
    const pkg = makePlugin(root, "plugin-d", {
      distAt: 3_000,
      sourceAt: 2_000,
    });
    // All newer than dist, none of them build inputs.
    const src = path.join(pkg, "src");
    writeAt(path.join(src, "dist", "chunk.mjs"), 5_000);
    writeAt(path.join(src, "node_modules", "dep", "index.ts"), 5_000);
    writeAt(path.join(src, ".turbo", "cache.ts"), 5_000);
    writeAt(path.join(src, "__tests__", "x.test.ts"), 5_000);
    writeAt(path.join(src, "test", "stubs", "stub-plugin.ts"), 5_000);
    writeAt(path.join(src, "test", "fixtures", "fixture.ts"), 5_000);
    writeAt(path.join(src, "e2e", "flow.ts"), 5_000);
    writeAt(path.join(src, "service.test.ts"), 5_000);
    writeAt(path.join(src, "README.md"), 5_000);
    expect(checkPluginDistStaleness(pkg).status).toBe("fresh");
  });

  it("reports no-manifest for a missing or invalid package.json", () => {
    const missing = path.join(tempRoot(), "plugin-none");
    mkdirSync(missing, { recursive: true });
    expect(checkPluginDistStaleness(missing)).toEqual({
      packageDir: missing,
      status: "no-manifest",
    });

    const invalid = path.join(tempRoot(), "plugin-invalid");
    mkdirSync(invalid, { recursive: true });
    writeFileSync(path.join(invalid, "package.json"), "{not json");
    const status = checkPluginDistStaleness(invalid);
    expect(status.status).toBe("no-manifest");
    expect(status.packageName).toBeUndefined();
  });

  it("reports no-entry when no export condition matches", () => {
    const pkg = makePlugin(tempRoot(), "plugin-require-only", {
      runtimeTarget: { require: "./dist/index.js" },
    });
    const status = checkPluginDistStaleness(pkg);
    expect(status.status).toBe("no-entry");
    expect(status.packageName).toBe("@elizaos/plugin-require-only");
  });

  it("reports no-entry for targets outside the package or lacking ./", () => {
    const bare = makePlugin(tempRoot(), "plugin-bare-target", {
      runtimeTarget: "dist/index.js",
    });
    expect(checkPluginDistStaleness(bare).status).toBe("no-entry");

    const escaping = makePlugin(tempRoot(), "plugin-escape-target", {
      runtimeTarget: "./../elsewhere.js",
    });
    expect(checkPluginDistStaleness(escaping).status).toBe("no-entry");
  });

  it("resolves array exports and the unconditional default condition", () => {
    const arrayPkg = makePlugin(tempRoot(), "plugin-array-exports", {
      distAt: 1_000,
      sourceAt: 2_000,
      runtimeTarget: [{ require: "./dist/legacy.js" }, "./dist/index.js"],
    });
    expect(checkPluginDistStaleness(arrayPkg).status).toBe("stale");

    const defaultPkg = makePlugin(tempRoot(), "plugin-default-export", {
      distAt: 3_000,
      sourceAt: 2_000,
      runtimeTarget: { default: "./dist/index.js" },
    });
    expect(checkPluginDistStaleness(defaultPkg, new Set(["node"])).status).toBe(
      "fresh",
    );
  });

  it("reports no-source when src is absent and only ignored entries remain", () => {
    const pkg = makePlugin(tempRoot(), "plugin-no-source", {
      distAt: 3_000,
    });
    const status = checkPluginDistStaleness(pkg);
    expect(status.status).toBe("no-source");
    expect(status.runtimeEntryMtimeMs).toBeDefined();
    expect(status.newestSourcePath).toBeUndefined();
  });

  it("treats equal mtimes as fresh because comparison is strictly newer", () => {
    const pkg = makePlugin(tempRoot(), "plugin-tie", {
      distAt: 2_000,
      sourceAt: 2_000,
    });
    expect(checkPluginDistStaleness(pkg).status).toBe("fresh");
  });
});

describe("warnStalePluginDists", () => {
  it("warns once per stale plugin, naming both paths and the rebuild command", () => {
    const root = tempRoot();
    makePlugin(root, "plugin-stale", { distAt: 1_000, sourceAt: 2_000 });
    makePlugin(root, "plugin-fresh", { distAt: 3_000, sourceAt: 2_000 });
    makePlugin(root, "plugin-src-only", { sourceAt: 2_000 });
    // Not a plugin package; never scanned.
    writeAt(path.join(root, "shared-lib", "index.ts"), 9_000);

    const warn = vi.fn();
    const result = warnStalePluginDists({ pluginsRoot: root, warn });

    expect(result.scanned).toBe(3);
    expect(result.stale).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain("plugin-stale");
    expect(message).toContain("NOT running");
    expect(message).toContain(path.join("plugin-stale", "src", "service.ts"));
    expect(message).toContain(path.join("dist", "index.js"));
    expect(message).toContain("bun run --cwd plugins/plugin-stale build");
  });

  it("reports truthful dist-loaded and source-loaded totals", () => {
    const root = tempRoot();
    makePlugin(root, "plugin-stale", { distAt: 1_000, sourceAt: 2_000 });
    makePlugin(root, "plugin-fresh", { distAt: 3_000, sourceAt: 2_000 });
    makePlugin(root, "plugin-source", {
      distAt: 1_000,
      sourceAt: 2_000,
      runtimeTarget: {
        "eliza-source": "./src/index.ts",
        import: "./dist/index.js",
      },
    });
    writeAt(path.join(root, "plugin-source", "src", "index.ts"), 2_000);

    const result = warnStalePluginDists({ pluginsRoot: root, warn: vi.fn() });
    expect(result).toMatchObject({
      scanned: 3,
      distLoaded: 2,
      sourceLoaded: 1,
    });
  });

  it("returns quietly for a missing plugins root", () => {
    const warn = vi.fn();
    const result = warnStalePluginDists({
      pluginsRoot: path.join(tempRoot(), "does-not-exist"),
      warn,
    });
    expect(result).toEqual({
      scanned: 0,
      distLoaded: 0,
      sourceLoaded: 0,
      stale: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips plain files whose names look like plugins", () => {
    const root = tempRoot();
    makePlugin(root, "plugin-real", { distAt: 1_000, sourceAt: 2_000 });
    writeFileSync(path.join(root, "plugin-impostor"), "not a package");

    const result = warnStalePluginDists({ pluginsRoot: root, warn: vi.fn() });
    expect(result.scanned).toBe(1);
    expect(result.stale).toHaveLength(1);
  });

  it("reports the sweep as unavailable when the root cannot be listed", () => {
    const root = tempRoot();
    const filePath = path.join(root, "plugins-root-file");
    writeFileSync(filePath, "a directory this is not");

    const warn = vi.fn();
    const result = warnStalePluginDists({ pluginsRoot: filePath, warn });
    expect(result).toEqual({
      scanned: 0,
      distLoaded: 0,
      sourceLoaded: 0,
      stale: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("unavailable");
  });

  it("keeps sweeping when one package's source scan fails", () => {
    const root = tempRoot();
    makePlugin(root, "plugin-stale-later", { distAt: 1_000, sourceAt: 2_000 });
    const broken = path.join(root, "plugin-broken-src");
    mkdirSync(broken, { recursive: true });
    writeFileSync(
      path.join(broken, "package.json"),
      JSON.stringify({
        name: "@elizaos/plugin-broken-src",
        exports: { ".": "./dist/index.js" },
      }),
    );
    writeAt(path.join(broken, "dist", "index.js"), 3_000);
    // src exists as a regular file, so listing it throws and the sweep
    // must name this package instead of dying or faking success.
    writeFileSync(path.join(broken, "src"), "");

    const warn = vi.fn();
    const result = warnStalePluginDists({ pluginsRoot: root, warn });

    expect(result.scanned).toBe(2);
    expect(result.distLoaded).toBe(1);
    expect(result.stale.map((entry) => entry.packageDir)).toContain(
      path.join(root, "plugin-stale-later"),
    );
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes("plugin-broken-src"))).toBe(true);
    expect(
      messages.some((m) => m.includes("stale-dist check unavailable")),
    ).toBe(true);
  });
});
