/**
 * Verifies assertSafeGitRemote.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  assertSafeGitRef,
  assertSafeGitRemote,
  normalizeRepositoryInput,
  UnsafeGitRefError,
  UnsafeGitRemoteError,
} from "../../src/services/repo-input.js";

// The coding orchestrator clones repos on behalf of sub-agents whose task text
// is model/attacker-influenced. `git clone` / `git ls-remote` expose command
// execution and local-disclosure vectors through the remote argument, so every
// repo string is run through assertSafeGitRemote before it reaches git.

describe("assertSafeGitRemote", () => {
  it("accepts https / http / ssh URLs and scp-style ssh remotes", () => {
    for (const ok of [
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo",
      "http://git.internal.example/owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
      "git@github.com:owner/repo.git",
      "user-name@host.example.com:group/sub/repo",
    ]) {
      expect(assertSafeGitRemote(ok)).toBe(ok);
    }
  });

  it("accepts the output of normalizeRepositoryInput for every shorthand form", () => {
    for (const input of [
      "owner/repo",
      "owner/repo.git",
      "github.com/owner/repo",
      "https://github.com/owner/repo/",
      "git@github.com:owner/repo.git",
    ]) {
      const normalized = normalizeRepositoryInput(input);
      expect(() => assertSafeGitRemote(normalized)).not.toThrow();
    }
  });

  it("rejects the ext:: remote-helper (arbitrary command execution / RCE)", () => {
    expect(() => assertSafeGitRemote('ext::sh -c "touch /tmp/pwned"')).toThrow(
      UnsafeGitRemoteError,
    );
    // any <helper>:: transport prefix, not just ext
    expect(() => assertSafeGitRemote("fd::17/repo")).toThrow(
      UnsafeGitRemoteError,
    );
    expect(() => assertSafeGitRemote("foo::bar")).toThrow(UnsafeGitRemoteError);
  });

  it("rejects a leading '-' (argument injection, e.g. --upload-pack=…)", () => {
    expect(() => assertSafeGitRemote("--upload-pack=touch /tmp/pwned")).toThrow(
      UnsafeGitRemoteError,
    );
    expect(() => assertSafeGitRemote("-oProxyCommand=sh")).toThrow(
      UnsafeGitRemoteError,
    );
  });

  it("rejects file:// (local repository disclosure) and git:// (unauthenticated)", () => {
    expect(() => assertSafeGitRemote("file:///etc/passwd")).toThrow(
      UnsafeGitRemoteError,
    );
    expect(() => assertSafeGitRemote("git://evil.example/repo")).toThrow(
      UnsafeGitRemoteError,
    );
  });

  it("rejects empty / whitespace / bare tokens that are not valid remotes", () => {
    expect(() => assertSafeGitRemote("")).toThrow(UnsafeGitRemoteError);
    expect(() => assertSafeGitRemote("   ")).toThrow(UnsafeGitRemoteError);
    expect(() => assertSafeGitRemote("just-a-word")).toThrow(
      UnsafeGitRemoteError,
    );
  });

  it("does not misclassify an IPv6 https URL as a transport helper", () => {
    // `::` inside an IPv6 literal must NOT trip the `<helper>::` check.
    const ipv6 = "https://[2001:db8::1]/owner/repo.git";
    expect(assertSafeGitRemote(ipv6)).toBe(ipv6);
  });

  it("rejects shell metacharacters / whitespace even behind a valid scheme", () => {
    // The unauthenticated clone path in git-workspace-service runs the remote
    // through a shell, so an `https://`-prefixed string with metacharacters is
    // still command injection. A prefix-only scheme check would wave these
    // through — the reason #10980's fix left the RCE reachable.
    for (const bad of [
      "https://127.0.0.1/x; touch /tmp/pwned",
      "https://127.0.0.1/x$(touch /tmp/pwned)",
      "https://127.0.0.1/x`id`",
      "https://127.0.0.1/x|touch /tmp/pwned",
      "https://127.0.0.1/x && touch /tmp/pwned",
      "https://127.0.0.1/x\ntouch /tmp/pwned",
    ]) {
      expect(() => assertSafeGitRemote(bad)).toThrow(UnsafeGitRemoteError);
    }
  });
});

describe("assertSafeGitRef", () => {
  it("accepts ordinary branch / ref names", () => {
    for (const ok of [
      "main",
      "develop",
      "master",
      "feature/foo-bar",
      "release/1.2.3",
      "v1.0.0",
      "eliza/task-abc123",
    ]) {
      expect(assertSafeGitRef(ok)).toBe(ok);
    }
  });

  it("rejects a leading '-' (argument injection)", () => {
    expect(() => assertSafeGitRef("--upload-pack=sh")).toThrow(
      UnsafeGitRefError,
    );
  });

  it("rejects shell metacharacters / whitespace (branch-name command injection)", () => {
    for (const bad of [
      "main; touch /tmp/pwned",
      "main$(touch /tmp/pwned)",
      "main`id`",
      "main | sh",
      "main && rm -rf /",
      "with space",
      "",
    ]) {
      expect(() => assertSafeGitRef(bad)).toThrow(UnsafeGitRefError);
    }
  });
});
