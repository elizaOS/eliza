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

  it("blocks the other descriptor-backed /proc entries", () => {
    expect(isBlockedPath("/proc/123/root")).toBe(true);
    expect(isBlockedPath("/proc/123/root/etc/shadow")).toBe(true);
    expect(isBlockedPath("/proc/self/cwd")).toBe(true);
    expect(isBlockedPath("/proc/self/cwd/secret.txt")).toBe(true);
    expect(isBlockedPath("/proc/self/exe")).toBe(true);
    expect(isBlockedPath("/proc/thread-self/root/etc/passwd")).toBe(true);
    expect(isBlockedPath("/proc/123/task/456/cwd")).toBe(true);
    expect(isBlockedPath("/proc/123/map_files/400000-401000")).toBe(true);
  });

  it("keeps neighbouring /proc names outside the descriptor match", () => {
    expect(isBlockedPath("/proc/123/rootfs")).toBe(false);
    expect(isBlockedPath("/proc/123/exec_domains")).toBe(false);
    expect(isBlockedPath("/proc/123/cwdinfo")).toBe(false);
    expect(isBlockedPath("/proc/123/map_files_summary")).toBe(false);
    expect(isBlockedPath("/proc/self/status")).toBe(false);
    expect(isBlockedPath("/proc/thread-self/stat")).toBe(false);
  });
});

describe("traversesBlockedPath", () => {
  const itSymlink = process.platform === "win32" ? it.skip : it;

  /**
   * Build `count` chained symlinks below a temporary directory, where hop-N
   * points at `finalTarget` and every earlier hop points at its successor.
   * macOS exposes /var through /private/var, so the chain is built below the
   * canonical root and that platform alias does not consume a tested hop.
   */
  async function withSymlinkChain(
    count: number,
    finalTarget: string,
    assert: (canonicalRoot: string) => Promise<void>,
  ): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "eliza-coding-hops-"));
    try {
      const canonicalRoot = await resolveRealPath(root);
      for (let hop = count; hop >= 1; hop -= 1) {
        symlinkSync(
          hop === count ? finalTarget : `hop-${String(hop + 1)}`,
          path.join(canonicalRoot, `hop-${String(hop)}`),
          "file",
        );
      }
      await assert(canonicalRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  itSymlink(
    "blocks a chain whose fortieth hop expands into a blocked pseudo-path",
    async () => {
      // The fortieth hop expands to `/dev`, which is not itself blocked. Only
      // rejoining the unconsumed `fd/0` tail produces the blocked `/dev/fd/0`,
      // so this case is reachable exclusively through the check performed
      // after the traversal bound is reached.
      await withSymlinkChain(40, "/dev", async (canonicalRoot) => {
        expect(
          await traversesBlockedPath(
            path.join(canonicalRoot, "hop-1", "fd", "0"),
          ),
        ).toBe(true);
      });
    },
  );

  itSymlink(
    "blocks a chain that reaches a device inside the bound",
    async () => {
      await withSymlinkChain(40, "/dev/urandom", async (canonicalRoot) => {
        expect(
          await traversesBlockedPath(path.join(canonicalRoot, "hop-1")),
        ).toBe(true);
      });
    },
  );

  itSymlink(
    "stops resolving past the bound without throwing when the chain is longer",
    async () => {
      // One hop beyond the OS maximum: resolution is abandoned rather than
      // continued, and the caller's own filesystem operation reports ELOOP.
      await withSymlinkChain(41, "/dev", async (canonicalRoot) => {
        expect(
          await traversesBlockedPath(
            path.join(canonicalRoot, "hop-1", "fd", "0"),
          ),
        ).toBe(false);
      });
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
