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
});
