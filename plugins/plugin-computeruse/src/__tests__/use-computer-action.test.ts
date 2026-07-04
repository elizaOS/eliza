/**
 * COMPUTER_USE action handler over a mocked ComputerUseService: param resolution,
 * approval snapshots, and result shaping. Deterministic.
 */
import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { useComputerAction } from "../actions/use-computer.js";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type { ApprovalSnapshot, PendingApproval } from "../types.js";

const message = (content: Memory["content"]): Memory =>
  ({
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content,
  }) as Memory;

function runtimeWithService(
  service: Partial<ComputerUseService>,
): IAgentRuntime {
  return {
    getService: (name: string) => (name === "computeruse" ? service : null),
  } as unknown as IAgentRuntime;
}

describe("COMPUTER_USE action approvals", () => {
  it("relays pending approval requests as chat choice buttons", async () => {
    const pending: PendingApproval = {
      id: "approval_123_abc",
      command: "computer_use_click",
      parameters: { action: "click" },
      requestedAt: "2026-06-22T14:00:00.000Z",
    };
    let approvalListener: ((snapshot: ApprovalSnapshot) => void) | null = null;
    const unsubscribe = vi.fn();
    const service = {
      getApprovalSnapshot: () => ({
        mode: "approve_all",
        pendingCount: 0,
        pendingApprovals: [],
      }),
      subscribeApprovals: (listener: (snapshot: ApprovalSnapshot) => void) => {
        approvalListener = listener;
        return unsubscribe;
      },
      executeDesktopAction: vi.fn(async () => {
        approvalListener?.({
          mode: "approve_all",
          pendingCount: 1,
          pendingApprovals: [pending],
        });
        return { success: true, message: "clicked" };
      }),
    } as Partial<ComputerUseService>;
    const callback = vi.fn(async () => []) satisfies HandlerCallback;
    const handler = useComputerAction.handler;
    if (!handler) {
      throw new Error("COMPUTER_USE handler missing");
    }

    const result = await handler(
      runtimeWithService(service),
      message({ action: "click" }),
      undefined,
      undefined,
      callback,
    );

    expect(result?.success).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const approvalCall = callback.mock.calls.find(
      ([, actionName]) => actionName === "COMPUTER_USE_APPROVAL",
    );
    expect(approvalCall?.[0]).toMatchObject({
      source: "computeruse_approval",
      text: expect.stringContaining("[CHOICE:computeruse-approval"),
    });
    expect(approvalCall?.[0].text).toContain(
      "cua:approval_123_abc:approve=Approve",
    );
    expect(approvalCall?.[0].text).toContain("cua:approval_123_abc:deny=Deny");
  });

  it("supports typed legacy approve/deny text for manual fallback", async () => {
    const resolveApproval = vi.fn(() => ({
      id: "approval_123_abc",
      command: "computer_use_click",
      approved: true,
      cancelled: false,
      mode: "approve_all",
      requestedAt: "2026-06-22T14:00:00.000Z",
      resolvedAt: "2026-06-22T14:00:01.000Z",
    }));
    const service = { resolveApproval } as Partial<ComputerUseService>;
    const callback = vi.fn(async () => []) satisfies HandlerCallback;
    const handler = useComputerAction.handler;
    if (!handler) {
      throw new Error("COMPUTER_USE handler missing");
    }

    const result = await handler(
      runtimeWithService(service),
      message({ text: "approve:approval_123_abc" }),
      undefined,
      undefined,
      callback,
    );

    expect(resolveApproval).toHaveBeenCalledWith(
      "approval_123_abc",
      true,
      "Resolved from chat button (approve)",
    );
    expect(result?.success).toBe(true);
  });

  it("resolves approve/deny callbacks returned from chat buttons", async () => {
    const resolveApproval = vi.fn(() => ({
      id: "approval_123_abc",
      command: "computer_use_click",
      approved: true,
      cancelled: false,
      mode: "approve_all",
      requestedAt: "2026-06-22T14:00:00.000Z",
      resolvedAt: "2026-06-22T14:00:01.000Z",
    }));
    const service = { resolveApproval } as Partial<ComputerUseService>;
    const callback = vi.fn(async () => []) satisfies HandlerCallback;
    const handler = useComputerAction.handler;
    if (!handler) {
      throw new Error("COMPUTER_USE handler missing");
    }

    const result = await handler(
      runtimeWithService(service),
      message({ text: "cua:approval_123_abc:approve" }),
      undefined,
      undefined,
      callback,
    );

    expect(resolveApproval).toHaveBeenCalledWith(
      "approval_123_abc",
      true,
      "Resolved from chat button (approve)",
    );
    expect(result?.success).toBe(true);
    expect(result?.text).toBe(
      "Computer-use approval approval_123_abc approved.",
    );
    expect(callback).toHaveBeenCalledWith(
      { text: "Computer-use approval approval_123_abc approved." },
      "COMPUTER_USE",
    );
  });

  it("rejects owner-scoped callbacks from another Telegram user", async () => {
    const service = {
      resolveApproval: vi.fn(),
    } as Partial<ComputerUseService>;
    const callback = vi.fn(async () => []) satisfies HandlerCallback;
    const handler = useComputerAction.handler;
    if (!handler) {
      throw new Error("COMPUTER_USE handler missing");
    }

    const result = await handler(
      runtimeWithService(service),
      {
        ...message({ text: "cua:approval_123_abc:approve:u42" }),
        metadata: { telegramUserId: "7" },
      } as Memory,
      undefined,
      undefined,
      callback,
    );

    expect(service.resolveApproval).not.toHaveBeenCalled();
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("does not belong to this user");
  });
});
