/**
 * Unit tests for the pendingApprovals provider that grounds approval decisions
 * before Stage-1 action routing. Deterministic mocks assert owner scoping,
 * payload redaction, and the reject/hold routing text.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../src/lifeops/approval-queue.types.js";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(),
  queue: {
    list: vi.fn(),
  },
  createApprovalQueue: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

vi.mock("../src/lifeops/approval-queue.js", () => ({
  createApprovalQueue: mocks.createApprovalQueue,
}));

import {
  pendingApprovalsProvider,
  renderPendingApprovalsText,
} from "../src/providers/pending-approvals.js";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    action: "send_message",
    state: "pending",
    subjectUserId: OWNER_ID,
    channel: "sms",
    reason: "ambiguous Chris recipient",
    payload: {
      action: "send_message",
      channel: "sms",
      recipient: "+15555550123",
      body: "Sensitive private payload that must not appear in every prompt",
    },
    createdAt: new Date("2026-07-06T00:00:00Z"),
    updatedAt: new Date("2026-07-06T00:00:00Z"),
    expiresAt: new Date("2026-07-07T00:00:00Z"),
    resolvedAt: null,
    resolvedBy: null,
    resolutionReason: null,
    metadata: {},
    ...overrides,
  } as ApprovalRequest;
}

function runtime(): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

function message(): Memory {
  return {
    entityId: OWNER_ID,
    content: { text: "don't send it, reject that for now" },
  } as Memory;
}

describe("pendingApprovalsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasOwnerAccess.mockResolvedValue(true);
    mocks.createApprovalQueue.mockReturnValue(mocks.queue);
    mocks.queue.list.mockResolvedValue([]);
  });

  it("renders pending approvals as RESOLVE_REQUEST routing context without payload leakage", () => {
    const text = renderPendingApprovalsText([approval()]);

    expect(text).toContain("Pending Approvals");
    expect(text).toContain("RESOLVE_REQUEST");
    expect(text).toContain("reject leaves it permanently un-dispatched");
    expect(text).toContain("don't send it");
    expect(text).toContain("ambiguous Chris recipient");
    expect(text).not.toContain("Sensitive private payload");
    expect(text).not.toContain("+15555550123");
  });

  it("reads only the current owner's pending queue rows", async () => {
    mocks.queue.list.mockResolvedValue([approval()]);
    const result = await pendingApprovalsProvider.get(runtime(), message(), {});

    expect(mocks.createApprovalQueue).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT_ID }),
      { agentId: AGENT_ID },
    );
    expect(mocks.queue.list).toHaveBeenCalledWith({
      subjectUserId: OWNER_ID,
      state: "pending",
      action: null,
      limit: 20,
    });
    expect(result.text).toContain("RESOLVE_REQUEST");
    expect(result.values?.pendingApprovalCount).toBe(1);
    expect(result.data?.pendingApprovals).toHaveLength(1);
  });

  it("stays empty for non-owner turns", async () => {
    mocks.hasOwnerAccess.mockResolvedValue(false);

    const result = await pendingApprovalsProvider.get(runtime(), message(), {});

    expect(result.text).toBe("");
    expect(result.values?.pendingApprovalCount).toBe(0);
    expect(mocks.queue.list).not.toHaveBeenCalled();
  });
});
