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
} from "../dev-plugin-dist-staleness";

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
  { distAt, sourceAt }: { distAt?: number; sourceAt?: number },
): string {
  const pkg = path.join(root, name);
  if (distAt !== undefined) {
    writeAt(path.join(pkg, "dist", "index.js"), distAt);
  }
  if (sourceAt !== undefined) {
    writeAt(path.join(pkg, "service.ts"), sourceAt);
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

  it("ignores build outputs, dot dirs, and test files as source", () => {
    const root = tempRoot();
    const pkg = makePlugin(root, "plugin-d", {
      distAt: 3_000,
      sourceAt: 2_000,
    });
    // All newer than dist, none of them build inputs.
    writeAt(path.join(pkg, "dist", "chunk.mjs"), 5_000);
    writeAt(path.join(pkg, "node_modules", "dep", "index.ts"), 5_000);
    writeAt(path.join(pkg, ".turbo", "cache.ts"), 5_000);
    writeAt(path.join(pkg, "__tests__", "x.test.ts"), 5_000);
    writeAt(path.join(pkg, "service.test.ts"), 5_000);
    writeAt(path.join(pkg, "README.md"), 5_000);
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
    expect(message).toContain(path.join("plugin-stale", "service.ts"));
    expect(message).toContain(path.join("dist", "index.js"));
    expect(message).toContain("bun run --cwd plugins/plugin-stale build");
  });

  it("returns quietly for a missing plugins root", () => {
    const warn = vi.fn();
    const result = warnStalePluginDists({
      pluginsRoot: path.join(tempRoot(), "does-not-exist"),
      warn,
    });
    expect(result).toEqual({ scanned: 0, stale: [] });
    expect(warn).not.toHaveBeenCalled();
  });
});
