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
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("[CHOICE:computeruse-approval"),
      }),
      "COMPUTER_USE",
    );
    expect(callback.mock.calls[0]?.[0].text).toContain(
      "approve:approval_123_abc=Approve",
    );
    expect(callback.mock.calls[0]?.[0].text).toContain(
      "deny:approval_123_abc=Deny",
    );
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
    expect(result?.text).toBe(
      "Computer-use approval approval_123_abc approved.",
    );
    expect(callback).toHaveBeenCalledWith(
      { text: "Computer-use approval approval_123_abc approved." },
      "COMPUTER_USE",
    );
  });
});
