/** Path predicate tests; canonical resolution and containment now live in `@elizaos/shared/platform/path-confinement`. */
import { describe, expect, it } from "vitest";
import { isAbsolutePath, isBlockedPath, isUncPath } from "./path-utils.js";

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
