/** Unit tests for the path predicates, blocklist resolution, and session-cwd input resolution. */
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { SESSION_CWD_SERVICE } from "../types.js";
import {
  isAbsolutePath,
  isBlockedPath,
  isUncPath,
  isWithin,
  isWithinAnyRoot,
  normalizeAbsolute,
  relativeFromRoot,
  resolveInputPath,
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
    expect(isBlockedPath("/proc/123/fd/4")).toBe(true);
    expect(isBlockedPath("/home/user/file.txt")).toBe(false);
    expect(isBlockedPath("/proc/cpuinfo")).toBe(false);
  });
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

describe("resolveInputPath", () => {
  const runtimeWithCwd = (cwd: string | null) =>
    ({
      getService: <T>(serviceType: string): T | null =>
        serviceType === SESSION_CWD_SERVICE && cwd !== null
          ? ({ getCwd: () => cwd } as T)
          : null,
    }) as IAgentRuntime;

  it("returns absolute paths untouched without consulting the session cwd", () => {
    const runtime = {
      getService: (): never => {
        throw new Error("must not be called for absolute paths");
      },
    } as unknown as IAgentRuntime;
    expect(resolveInputPath(runtime, "room-1", "/etc/hosts")).toBe(
      "/etc/hosts",
    );
  });

  it("resolves relative paths against the conversation's session cwd", () => {
    const runtime = runtimeWithCwd("/workspace/repo");
    expect(resolveInputPath(runtime, "room-1", "docs/README.md")).toBe(
      path.resolve("/workspace/repo", "docs/README.md"),
    );
    expect(resolveInputPath(runtime, "room-1", "../sibling/file.ts")).toBe(
      path.resolve("/workspace/repo", "../sibling/file.ts"),
    );
  });

  it("falls back to process.cwd() when the session-cwd service is absent", () => {
    expect(resolveInputPath(runtimeWithCwd(null), "room-1", "notes.txt")).toBe(
      path.resolve(process.cwd(), "notes.txt"),
    );
  });
});
