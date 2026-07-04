/**
 * Verifies TASKS:provision_workspace.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { provisionWorkspaceAction } from "../../src/actions/tasks.js";
import { CodingWorkspaceService } from "../../src/services/workspace-service.js";
import {
  callback,
  memory,
  runtimeWith,
  state,
} from "../../src/test-utils/action-test-utils.js";

function workspaceServiceMock(overrides: Record<string, unknown> = {}) {
  const service = Object.create(CodingWorkspaceService.prototype) as {
    provisionWorkspace: ReturnType<typeof vi.fn>;
    getWorkspace: ReturnType<typeof vi.fn>;
  };
  service.provisionWorkspace = vi.fn(async (options) => ({
    id: "workspace-1",
    path: "/tmp/workspace-1",
    branch: options.baseBranch ?? "main",
    baseBranch: options.baseBranch ?? "main",
    isWorktree: options.useWorktree === true,
  }));
  service.getWorkspace = vi.fn();
  Object.assign(service, overrides);
  return service;
}

describe("TASKS:provision_workspace", () => {
  it("uses planner parameters before legacy message content", async () => {
    const service = workspaceServiceMock();

    const result = await provisionWorkspaceAction.handler(
      runtimeWith(service),
      memory({
        repo: "https://github.com/legacy/repo",
        baseBranch: "legacy",
        useWorktree: true,
      }),
      state,
      {
        parameters: {
          action: "provision_workspace",
          repo: "elizaOS/eliza",
          baseBranch: "develop",
          useWorktree: false,
        },
      },
      callback(),
    );

    expect(result?.success).toBe(true);
    expect(service.provisionWorkspace).toHaveBeenCalledWith({
      repo: "https://github.com/elizaOS/eliza.git",
      baseBranch: "develop",
      useWorktree: false,
      parentWorkspaceId: undefined,
    });
  });

  it("lets params.useWorktree false override legacy content true", async () => {
    const service = workspaceServiceMock();

    const result = await provisionWorkspaceAction.handler(
      runtimeWith(service),
      memory({ useWorktree: true, parentWorkspaceId: "parent-1" }),
      state,
      {
        parameters: {
          action: "provision_workspace",
          useWorktree: false,
        },
      },
      callback(),
    );

    expect(result?.success).toBe(false);
    expect(result?.error).toBe("MISSING_REPO");
    expect(service.provisionWorkspace).not.toHaveBeenCalled();
  });

  it("falls back to legacy message content for repo inputs", async () => {
    const service = workspaceServiceMock();

    const result = await provisionWorkspaceAction.handler(
      runtimeWith(service),
      memory({
        repo: "elizaOS/eliza",
        baseBranch: "develop",
      }),
      state,
      { parameters: { action: "provision_workspace" } },
      callback(),
    );

    expect(result?.success).toBe(true);
    expect(service.provisionWorkspace).toHaveBeenCalledWith({
      repo: "https://github.com/elizaOS/eliza.git",
      baseBranch: "develop",
      useWorktree: false,
      parentWorkspaceId: undefined,
    });
  });

  it("derives the repo from the parent workspace for worktree-only params", async () => {
    const service = workspaceServiceMock({
      getWorkspace: vi.fn(() => ({
        id: "parent-1",
        repo: "https://github.com/elizaOS/parent.git",
      })),
    });

    const result = await provisionWorkspaceAction.handler(
      runtimeWith(service),
      memory({}),
      state,
      {
        parameters: {
          action: "provision_workspace",
          useWorktree: true,
          parentWorkspaceId: "parent-1",
        },
      },
      callback(),
    );

    expect(result?.success).toBe(true);
    expect(service.getWorkspace).toHaveBeenCalledWith("parent-1");
    expect(service.provisionWorkspace).toHaveBeenCalledWith({
      repo: "https://github.com/elizaOS/parent.git",
      baseBranch: undefined,
      useWorktree: true,
      parentWorkspaceId: "parent-1",
    });
  });
});
