import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  assertSafeGitRemote,
  normalizeRepositoryInput,
  UnsafeGitRemoteError,
} from "../../src/services/repo-input.js";
import { CodingWorkspaceService } from "../../src/services/workspace-service.js";

// The coding orchestrator clones repos on behalf of sub-agents whose task text
// is model/attacker-influenced. `git clone` / `git ls-remote` expose command
// execution and local-disclosure vectors through the remote argument, so every
// repo string is run through assertSafeGitRemote before it reaches git.
//
// Critically, the underlying git-workspace-service unauthenticated clone path
// (public repo / no token) interpolates the remote into a *shell* `git clone`
// via promisify(exec). The credential-safe clone override only covers the
// credentialed path, so the application-level gate in provisionWorkspace() is
// what protects the public/no-token path from command injection.

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

  it("rejects shell-metacharacter payloads that would break out of the unauthenticated shell clone", () => {
    for (const payload of [
      "https://github.com/owner/repo.git; touch /tmp/pwned",
      "https://github.com/owner/repo.git && rm -rf /",
      "https://github.com/owner/repo.git`touch /tmp/pwned`",
      "https://github.com/owner/repo.git$(touch /tmp/pwned)",
      "https://github.com/owner/repo.git | id",
    ]) {
      expect(() => assertSafeGitRemote(payload)).toThrow(UnsafeGitRemoteError);
    }
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
});

// Integration: prove the gate sits at the provisionWorkspace chokepoint, in
// front of BOTH the git ls-remote default-branch probe AND the dependency's
// provision() (whose unauthenticated clone path shells out). A malicious repo
// must be rejected before provision() — the shell — is ever reached.
describe("CodingWorkspaceService.provisionWorkspace git-remote gate", () => {
  function serviceUnderTest(): {
    service: CodingWorkspaceService;
    provision: ReturnType<typeof vi.fn>;
  } {
    const runtime = {
      getSetting: vi.fn(() => null),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as IAgentRuntime;

    const service = new CodingWorkspaceService(runtime, {
      baseDir: "/tmp/orchestrator-git-gate-test",
    });

    // Stand in for the git-workspace-service WorkspaceService. If the gate
    // fails, provision() is where the injected remote reaches the shell clone.
    const provision = vi.fn(async () => {
      throw new Error(
        "provision() must never be reached for an unsafe git remote — the shell clone path is exposed",
      );
    });
    (service as unknown as { workspaceService: unknown }).workspaceService = {
      provision,
    };

    return { service, provision };
  }

  it("rejects an ext:: RCE payload on the PUBLIC/no-token path before provision() shells out", async () => {
    const { service, provision } = serviceUnderTest();

    await expect(
      service.provisionWorkspace({
        // Not a GitHub repo → resolveUserCredentials returns no token →
        // this is exactly the public/no-token unauthenticated clone path.
        repo: 'ext::sh -c "touch /tmp/pwned"',
        execution: { id: "exec-1", patternName: "test" },
        task: { id: "task-1", role: "coding-agent" },
      }),
    ).rejects.toBeInstanceOf(UnsafeGitRemoteError);

    // The gate fired BEFORE the dependency's provision() (the shell) ran.
    expect(provision).not.toHaveBeenCalled();
  });

  it("rejects transport-helper / argument-injection / disallowed-scheme remotes before provision()", async () => {
    // These bypass URL parsing entirely (no https scheme to reconstruct), so
    // the assertSafeGitRemote allowlist is the only thing standing between them
    // and the shell clone.
    for (const repo of [
      'ext::sh -c "touch /tmp/pwned"',
      "--upload-pack=touch /tmp/pwned",
      "file:///etc/passwd",
      "git://evil.example/repo",
    ]) {
      const { service, provision } = serviceUnderTest();
      await expect(
        service.provisionWorkspace({
          repo,
          execution: { id: "exec-1", patternName: "test" },
          task: { id: "task-1", role: "coding-agent" },
        }),
      ).rejects.toBeInstanceOf(UnsafeGitRemoteError);
      expect(provision).not.toHaveBeenCalled();
    }
  });

  it("never lets raw shell metacharacters in an https remote reach provision()", async () => {
    // For https inputs, normalizeRepositoryInput percent-encodes shell chars in
    // the pathname. Whatever survives to provision() must be a clean https URL
    // with NO literal shell metacharacter — otherwise the unauthenticated shell
    // clone could break out. This is the end-to-end invariant, verified against
    // the real normalizeRepositoryInput + assertSafeGitRemote pipeline.
    const shellMeta = /[;&|`$()<>\s'"\\]/;
    for (const repo of [
      "https://github.com/owner/repo.git; touch /tmp/pwned",
      "https://github.com/owner/repo.git && rm -rf /",
      "https://github.com/owner/repo.git`touch /tmp/pwned`",
      "https://github.com/owner/repo.git$(touch /tmp/pwned)",
      "https://github.com/owner/repo.git | id",
    ]) {
      const { service, provision } = serviceUnderTest();
      provision.mockImplementation(async (config: { repo: string }) => {
        expect(config.repo).not.toMatch(shellMeta);
        return {
          id: "ws",
          path: "/tmp/orchestrator-git-gate-test/ws",
          repo: config.repo,
          branch: { name: "b", baseBranch: "main" },
          status: "ready",
          strategy: "clone",
        };
      });

      // Either rejected by the allowlist, or neutralized to a safe URL that the
      // provision() assertion above accepts — never a raw-metacharacter remote.
      let thrown: unknown;
      try {
        await service.provisionWorkspace({
          repo,
          baseBranch: "main",
          execution: { id: "exec-1", patternName: "test" },
          task: { id: "task-1", role: "coding-agent" },
        });
      } catch (err) {
        thrown = err;
      }
      // The ONLY acceptable failure is the safety gate itself; a leaked
      // metacharacter would surface as the AssertionError from provision().
      if (thrown !== undefined) {
        expect(thrown).toBeInstanceOf(UnsafeGitRemoteError);
      }
    }
  });

  it("passes a safe, normalized remote through to provision()", async () => {
    const { service, provision } = serviceUnderTest();
    // Provide a resolving provision() for the happy path.
    provision.mockImplementation(async (config: { repo: string }) => ({
      id: "ws-1",
      path: "/tmp/orchestrator-git-gate-test/ws-1",
      repo: config.repo,
      branch: { name: "feat/x", baseBranch: "main" },
      status: "ready",
      strategy: "clone",
    }));

    const result = await service.provisionWorkspace({
      repo: "owner/repo",
      baseBranch: "main",
      execution: { id: "exec-1", patternName: "test" },
      task: { id: "task-1", role: "coding-agent" },
    });

    expect(provision).toHaveBeenCalledTimes(1);
    const passedRepo = (provision.mock.calls[0]?.[0] as { repo: string }).repo;
    expect(passedRepo).toBe("https://github.com/owner/repo.git");
    expect(result.repo).toBe("https://github.com/owner/repo.git");
  });
});
