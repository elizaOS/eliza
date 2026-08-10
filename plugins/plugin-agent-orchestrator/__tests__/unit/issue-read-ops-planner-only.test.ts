/**
 * Exercises issue reads through the complete TASKS action wrapper to prove
 * lookup results remain planner-only until a final operation owns delivery.
 */

import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    body: "Investigating now.",
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

const baseMessage = {
  id: "msg1",
  entityId: "user1",
  agentId: "agent1",
  roomId: "room1",
  content: { text: "work with issue 42 in owner/repo", source: "chat" },
  createdAt: Date.now(),
} as unknown as Memory;

const baseState = {} as State;

async function callHandler(
  params: Record<string, unknown>,
  callback: HandlerCallback,
): Promise<ActionResult> {
  const result = await tasksAction.handler(
    runtime,
    baseMessage,
    baseState,
    { parameters: params },
    callback,
  );
  if (!result) throw new Error("TASKS handler returned no result");
  return result;
}

function expectPlannerOnlyRead(result: ActionResult): void {
  expect(result.success).toBe(true);
  expect(result.text).toBeTruthy();
  expect(result.userFacingText).toBeUndefined();
  expect(result.verifiedUserFacing).toBeUndefined();
  expect(result.turnComplete).toBeUndefined();
  expect(result.effectReceipts).toEqual([
    expect.objectContaining({
      operation: "agent-orchestrator.tasks.manage_issues",
      outcome: "noop",
      reason: "The operation only read provider issue state.",
    }),
  ]);
}

describe("manage_issues planner-only read settlement (#18244)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps list data in the planner trajectory without delivering a callback", async () => {
    const callback = vi.fn(async () => []);
    const result = await callHandler(
      {
        action: "manage_issues",
        issueAction: "list",
        repo: "owner/repo",
      },
      callback,
    );

    expectPlannerOnlyRead(result);
    expect(callback).not.toHaveBeenCalled();
    expect(result.data?.issues).toEqual([
      expect.objectContaining({ number: 42, title: "Fix the thing" }),
    ]);
  });

  it("keeps get data in the planner trajectory without delivering a callback", async () => {
    const callback = vi.fn(async () => []);
    const result = await callHandler(
      {
        action: "manage_issues",
        issueAction: "get",
        repo: "owner/repo",
        issueNumber: 42,
      },
      callback,
    );

    expectPlannerOnlyRead(result);
    expect(callback).not.toHaveBeenCalled();
    expect(result.data?.issue).toEqual(
      expect.objectContaining({ number: 42, body: "Something is broken." }),
    );
  });

  it("stays silent for lookup and delivers only the follow-up mutation", async () => {
    const callback = vi.fn(async () => []);
    const readResult = await callHandler(
      {
        action: "manage_issues",
        issueAction: "list",
        repo: "owner/repo",
      },
      callback,
    );
    expectPlannerOnlyRead(readResult);
    expect(callback).not.toHaveBeenCalled();

    const commentResult = await callHandler(
      {
        action: "manage_issues",
        issueAction: "comment",
        repo: "owner/repo",
        issueNumber: 42,
        body: "Investigating now.",
      },
      callback,
    );

    expect(fakeWorkspaceService.addComment).toHaveBeenCalledWith(
      "owner/repo",
      42,
      "Investigating now.",
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      {
        text: "Added comment to issue #42: https://github.com/owner/repo/issues/42#issuecomment-1",
      },
      undefined,
    );
    expect(commentResult).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      turnComplete: true,
    });
  });
});
