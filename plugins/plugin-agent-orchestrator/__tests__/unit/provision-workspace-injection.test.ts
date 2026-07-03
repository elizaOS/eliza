import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UnsafeGitRefError,
  UnsafeGitRemoteError,
} from "../../src/services/repo-input.js";
import { CodingWorkspaceService } from "../../src/services/workspace-service.js";

// End-to-end regression for the git-remote / git-ref command-injection RCE that
// #10980 left reachable on the UNAUTHENTICATED clone path. These tests drive the
// REAL CodingWorkspaceService.provisionWorkspace entry (not assertSafeGitRemote in
// isolation): every production caller — the `provision_workspace` action and
// `POST /api/workspace/provision` — routes through it, and the lower-level
// `git-workspace-service` clones public repos through a shell (`promisify(exec)`),
// so an ungated repo / branch reaches `git clone … ${value} …` verbatim.
//
// The assertions are twofold: (1) provisionWorkspace throws at the local boundary
// BEFORE the dependency's `provision()` (which owns every git/shell spawn) is
// reached, and (2) the injected `touch <sentinel>` command never runs. Because the
// injection cases let `provision()` call through, deleting either gate would let
// the real shell clone execute and create the sentinel — failing the test loudly.

function runtimeStub(baseDir: string): unknown {
  return {
    getSetting: vi.fn((key: string) =>
      key === "ELIZA_WORKSPACE_DIR" ? baseDir : null,
    ),
    getService: vi.fn(() => null),
    hasService: vi.fn(() => false),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

interface ProvisionInternals {
  workspaceService: { provision: (...args: unknown[]) => Promise<unknown> };
}

describe("provisionWorkspace command-injection gate (#10980 follow-up)", () => {
  let baseDir: string;
  let sentinel: string;
  let service: CodingWorkspaceService;
  let provisionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    baseDir = join(
      tmpdir(),
      `orch-injection-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    sentinel = join(baseDir, "PWNED");
    service = await CodingWorkspaceService.start(runtimeStub(baseDir) as never);
    // Spy on the real dependency's provision so we can assert it is never reached
    // on an injection attempt; it CALLS THROUGH (no mock impl) so a removed gate
    // would let the shell clone actually run and create the sentinel.
    provisionSpy = vi.spyOn(
      (service as unknown as ProvisionInternals).workspaceService,
      "provision",
    );
  });

  afterEach(async () => {
    await service.stop().catch(() => undefined);
    rmSync(baseDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rejects a shell-metacharacter repo on the unauthenticated path and spawns no git", async () => {
    await expect(
      service.provisionWorkspace({
        repo: `https://127.0.0.1/x; touch ${sentinel}; echo`,
      }),
    ).rejects.toBeInstanceOf(UnsafeGitRemoteError);

    expect(provisionSpy).not.toHaveBeenCalled();
    expect(existsSync(sentinel)).toBe(false);
  });

  it("rejects command-substitution and pipe repos", async () => {
    for (const repo of [
      `https://127.0.0.1/x$(touch ${sentinel})`,
      "https://127.0.0.1/x|touch /tmp/x",
      "https://127.0.0.1/x`id`",
      "ext::sh -c touch",
      "file:///etc/passwd",
    ]) {
      await expect(service.provisionWorkspace({ repo })).rejects.toBeInstanceOf(
        UnsafeGitRemoteError,
      );
    }
    expect(provisionSpy).not.toHaveBeenCalled();
    expect(existsSync(sentinel)).toBe(false);
  });

  it("rejects a shell-metacharacter baseBranch and spawns no git", async () => {
    await expect(
      service.provisionWorkspace({
        repo: "https://github.com/elizaOS/eliza",
        baseBranch: `main; touch ${sentinel}; echo`,
      }),
    ).rejects.toBeInstanceOf(UnsafeGitRefError);

    expect(provisionSpy).not.toHaveBeenCalled();
    expect(existsSync(sentinel)).toBe(false);
  });

  it("rejects a shell-metacharacter branchName and spawns no git", async () => {
    await expect(
      service.provisionWorkspace({
        repo: "https://github.com/elizaOS/eliza",
        baseBranch: "main",
        branchName: `feat; touch ${sentinel}; echo`,
      }),
    ).rejects.toBeInstanceOf(UnsafeGitRefError);

    expect(provisionSpy).not.toHaveBeenCalled();
    expect(existsSync(sentinel)).toBe(false);
  });

  it("still provisions a legitimate repo + branch (gate does not block real use)", async () => {
    provisionSpy.mockResolvedValue({
      id: "ws-legit",
      path: join(baseDir, "ws-legit"),
      repo: "https://github.com/elizaOS/eliza.git",
      branch: { name: "eliza/feature", baseBranch: "develop" },
      strategy: "clone",
      status: "ready",
    });

    const result = await service.provisionWorkspace({
      repo: "elizaOS/eliza",
      baseBranch: "develop",
      branchName: "eliza/feature",
    });

    expect(provisionSpy).toHaveBeenCalledTimes(1);
    const config = provisionSpy.mock.calls[0][0] as {
      repo: string;
      baseBranch: string;
      branchName: string;
    };
    expect(config.repo).toBe("https://github.com/elizaOS/eliza.git");
    expect(config.baseBranch).toBe("develop");
    expect(config.branchName).toBe("eliza/feature");
    expect(result.id).toBe("ws-legit");
  });
});
