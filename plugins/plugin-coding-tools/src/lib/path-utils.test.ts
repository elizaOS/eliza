/** Unit tests for the path predicates and blocklist resolution. */
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAbsolutePath,
  isBlockedPath,
  isUncPath,
  isWithin,
  isWithinAnyRoot,
  normalizeAbsolute,
  relativeFromRoot,
  resolveRealPath,
  traversesBlockedPath,
} from "./path-utils.js";

/** Sandbox path validation — prevents traversal/escape, so the matching is pinned. */

describe("isAbsolutePath / isUncPath", () => {
  it("accepts posix absolute, rejects relative / UNC / non-strings", () => {
    expect(isAbsolutePath("/usr/local")).toBe(true);
    expect(isAbsolutePath("relative/path")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
    expect(isAbsolutePath("\\\\server\\share")).toBe(false);
    expect(isAbsolutePath("//server/share")).toBe(false);
    expect(isAbsolutePath(undefined as unknown as string)).toBe(false);
  });

  it("flags UNC paths", () => {
    expect(isUncPath("\\\\server\\share")).toBe(true);
    expect(isUncPath("//server/share")).toBe(true);
    expect(isUncPath("/server/share")).toBe(false);
  });
});

describe("isBlockedPath", () => {
  it("blocks special device files and /proc fd paths", () => {
    expect(isBlockedPath("/dev/zero")).toBe(true);
    expect(isBlockedPath("/dev/urandom")).toBe(true);
    expect(isBlockedPath("/dev/fd")).toBe(true);
    expect(isBlockedPath("/dev/fd/0")).toBe(true);
    expect(isBlockedPath("/proc/123/fd")).toBe(true);
    expect(isBlockedPath("/proc/123/fd/4")).toBe(true);
    expect(isBlockedPath("/proc/self/fd/4")).toBe(true);
    expect(isBlockedPath("/proc/123/task/456/fd/4")).toBe(true);
    expect(isBlockedPath("/proc/self/task/456/fd/4")).toBe(true);
    expect(isBlockedPath("/proc/thread-self/fd/4")).toBe(true);
    expect(isBlockedPath("/home/user/file.txt")).toBe(false);
    expect(isBlockedPath("/proc/cpuinfo")).toBe(false);
    expect(isBlockedPath("/proc/123/fdinfo/4")).toBe(false);
    expect(isBlockedPath("/proc/123/task/456/status")).toBe(false);
  });
});

describe("traversesBlockedPath", () => {
  const itSymlink = process.platform === "win32" ? it.skip : it;

  itSymlink(
    "checks the target produced by the fortieth symlink hop",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "eliza-coding-hops-"));
      try {
        // macOS exposes /var through /private/var. Build below the canonical root so
        // that platform alias does not consume one of the 40 tested symlink hops.
        const canonicalRoot = await resolveRealPath(root);
        for (let hop = 40; hop >= 1; hop -= 1) {
          symlinkSync(
            hop === 40 ? "/dev/urandom" : `hop-${String(hop + 1)}`,
            path.join(canonicalRoot, `hop-${String(hop)}`),
            "file",
          );
        }

        expect(
          await traversesBlockedPath(path.join(canonicalRoot, "hop-1")),
        ).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("isWithin — traversal containment", () => {
  it("treats equal paths and descendants as within", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/b/c/d", "/a/b")).toBe(true);
  });

  it("rejects siblings, ancestors, and ../ escapes", () => {
    expect(isWithin("/a/x", "/a/b")).toBe(false);
    expect(isWithin("/a", "/a/b")).toBe(false);
    // A normalized traversal that lands outside the parent is rejected.
    expect(isWithin("/a/b/../x", "/a/b")).toBe(false);
    // ...and one that stays inside is accepted.
    expect(isWithin("/a/b/sub/../c", "/a/b")).toBe(true);
  });
});

describe("isWithinAnyRoot", () => {
  it("is false with no roots, true when contained by one", async () => {
    expect(await isWithinAnyRoot("/a/b/c", [])).toBe(false);
    expect(await isWithinAnyRoot("/srv/app/x", ["/tmp", "/srv/app"])).toBe(
      true,
    );
    expect(await isWithinAnyRoot("/etc/passwd", ["/srv/app"])).toBe(false);
  });
});

describe("resolveRealPath — missing leaf through a symlink parent", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const itSymlink = process.platform === "win32" ? it.skip : it;

  itSymlink(
    "resolves a not-yet-created file through a directory symlink",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "eliza-coding-root-"));
      const victim = mkdtempSync(path.join(tmpdir(), "eliza-coding-victim-"));
      temps.push(root, victim);
      const realRoot = await resolveRealPath(root);
      const realVictim = await resolveRealPath(victim);
      symlinkSync(realVictim, path.join(realRoot, "escape"), "dir");
      const resolved = await resolveRealPath(
        path.join(realRoot, "escape", "planted.txt"),
      );
      expect(resolved).toBe(path.join(realVictim, "planted.txt"));
      expect(await isWithinAnyRoot(resolved, [realRoot])).toBe(false);
    },
  );
});

describe("normalizeAbsolute / relativeFromRoot", () => {
  it("normalizeAbsolute returns an absolute, collapsed path", () => {
    // path.resolve is platform-specific (drive letter + backslashes on Windows),
    // so normalize separators before asserting the collapsed POSIX-style tail.
    const out = normalizeAbsolute("/a/b/../c").replace(/\\/g, "/");
    expect(out).not.toContain("/../");
    expect(out.endsWith("/a/c")).toBe(true);
  });

  it("relativeFromRoot returns the path relative to root, or '.'", () => {
    // relativeFromRoot uses path.relative (backslashes on Windows) — normalize.
    expect(relativeFromRoot("/a/b/c", "/a").replace(/\\/g, "/")).toBe("b/c");
    expect(relativeFromRoot("/a", "/a")).toBe(".");
  });
});
