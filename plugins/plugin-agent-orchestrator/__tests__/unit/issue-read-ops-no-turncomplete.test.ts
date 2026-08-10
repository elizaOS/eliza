/**
 * Pins the settlement contract for `manage_issues` read operations (list/get):
 * they must NOT stamp `turnComplete: true` on the action result, because a read
 * is inherently usable as a lookup substep in a larger plan (e.g. "list issues,
 * then comment on #3"). With `turnComplete`, the planner-loop's sole-tool gate
 * (`tryGateEvaluator` → `action_terminal_result`) terminates the turn after the
 * read and the write step never runs (#18244).
 *
 * The `verifiedUserFacing` license is preserved — it prevents double-messaging
 * by ensuring the callback-delivered text is the canonical user reply, without
 * granting terminal authority.
 *
 * Write operations (create, comment) keep `turnComplete: true` because they are
 * terminal by intent — the user asked for a mutation and the confirmation IS the
 * complete answer.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────
// The real getCodingWorkspaceService uses `instanceof CodingWorkspaceService`,
// so a plain mock object is rejected. We stub it to return our fake directly.
// Likewise, requireTaskAgentAccess has complex role/connector resolution that
// we bypass for this settlement-contract test.

const fakeWorkspaceService = {
  setAuthPromptCallback: vi.fn(),
  listIssues: vi.fn(async () => [
    {
      number: 42,
      title: "Fix the thing",
      state: "open",
      labels: ["bug"],
      url: "https://github.com/owner/repo/issues/42",
    },
  ]),
  getIssue: vi.fn(async () => ({
    number: 42,
    title: "Fix the thing",
    state: "open",
    labels: ["bug"],
    body: "Something is broken.",
    url: "https://github.com/owner/repo/issues/42",
  })),
  addComment: vi.fn(async () => ({
    id: 1,
    url: "https://github.com/owner/repo/issues/42#issuecomment-1",
    body: "test comment",
  })),
  createIssue: vi.fn(async () => ({
    number: 99,
    title: "New issue",
    state: "open",
    labels: [],
    body: "",
    url: "https://github.com/owner/repo/issues/99",
  })),
};

vi.mock("../../src/services/workspace-service.js", () => ({
  getCodingWorkspaceService: vi.fn(() => fakeWorkspaceService),
  CodingWorkspaceService: class {},
}));

vi.mock("../../src/services/task-policy.js", () => ({
  requireTaskAgentAccess: vi.fn(async () => ({
    allowed: true,
    connector: null,
    requiredRole: "GUEST",
    actualRole: "GUEST",
  })),
}));

// Import AFTER mocks are in place.
const { tasksAction } = await import("../../src/actions/tasks.js");

const runtime = {
  agentId: "agent1",
  getService: vi.fn(),
  hasService: vi.fn(() => true),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  getRoom: vi.fn(async () => ({ id: "room1" })),
  reportError: vi.fn(),
} as unknown as IAgentRuntime;

const baseMessage: Memory = {
  id: "msg1",
  entityId: "user1",
  agentId: "agent1",
  roomId: "room1",
  content: { text: "list issues in owner/repo", source: "chat" },
  createdAt: Date.now(),
} as never;

const baseState = {} as State;

/** Call the handler with a typed parameters envelope and return the raw result. */
async function callHandler(
  params: Record<string, unknown>,
  cb: ReturnType<typeof vi.fn>,
): Promise<Record<string, unknown>> {
  const handler = tasksAction.handler as unknown as (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: { parameters: Record<string, unknown> },
    callback: unknown,
  ) => Promise<Record<string, unknown>>;
  return handler(runtime, baseMessage, baseState, { parameters: params }, cb);
}

describe("manage_issues read ops do not stamp turnComplete (#18244)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("list: returns verifiedUserFacing=true, turnComplete absent", async () => {
    const cb = vi.fn(async () => []);
    const result = await callHandler(
      { action: "manage_issues", issueAction: "list", repo: "owner/repo" },
      cb,
    );

    expect(result.success).toBe(true);
    expect(result.verifiedUserFacing).toBe(true);
    expect(result.userFacingText).toBeTruthy();
    // The fix: read ops do NOT own the turn's termination.
    expect(result.turnComplete).not.toBe(true);
    expect(fakeWorkspaceService.listIssues).toHaveBeenCalledWith(
      "owner/repo",
      expect.anything(),
    );
  });

  it("get: returns verifiedUserFacing=true, turnComplete absent", async () => {
    const cb = vi.fn(async () => []);
    const result = await callHandler(
      {
        action: "manage_issues",
        issueAction: "get",
        repo: "owner/repo",
        issueNumber: 42,
      },
      cb,
    );

    expect(result.success).toBe(true);
    expect(result.verifiedUserFacing).toBe(true);
    expect(result.userFacingText).toBeTruthy();
    expect(result.turnComplete).not.toBe(true);
    expect(fakeWorkspaceService.getIssue).toHaveBeenCalledWith("owner/repo", 42);
  });

  it("comment (write): still stamps turnComplete=true — mutation owns the turn", async () => {
    const cb = vi.fn(async () => []);
    const result = await callHandler(
      {
        action: "manage_issues",
        issueAction: "comment",
        repo: "owner/repo",
        issueNumber: 42,
        body: "test comment",
      },
      cb,
    );

    expect(result.success).toBe(true);
    // Write ops DO own the turn — the confirmation IS the complete answer.
    expect(result.turnComplete).toBe(true);
    expect(result.verifiedUserFacing).toBe(true);
    expect(fakeWorkspaceService.addComment).toHaveBeenCalled();
  });

  it("create (write): still stamps turnComplete=true — mutation owns the turn", async () => {
    const cb = vi.fn(async () => []);
    const result = await callHandler(
      {
        action: "manage_issues",
        issueAction: "create",
        repo: "owner/repo",
        title: "New issue",
        body: "body text",
      },
      cb,
    );

    expect(result.success).toBe(true);
    expect(result.turnComplete).toBe(true);
    expect(result.verifiedUserFacing).toBe(true);
    expect(fakeWorkspaceService.createIssue).toHaveBeenCalled();
  });
});
