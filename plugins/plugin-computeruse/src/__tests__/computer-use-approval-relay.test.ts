import { describe, expect, it, vi } from "vitest";
import { useComputerAction } from "../actions/use-computer.js";
import type { ApprovalSnapshot } from "../types.js";

function emptySnapshot(): ApprovalSnapshot {
  return {
    mode: "approve_all",
    pendingCount: 0,
    pendingApprovals: [],
  };
}

describe("COMPUTER_USE approval relay", () => {
  it("posts approve/deny inline choices to the action callback", async () => {
    const listeners: Array<(snapshot: ApprovalSnapshot) => void> = [];
    const unsubscribe = vi.fn();
    const approval = {
      id: "approval_123",
      command: "desktop_click",
      parameters: { action: "click", coordinate: [10, 20] },
      requestedAt: "2026-06-22T12:00:00.000Z",
    };
    const service = {
      getApprovalSnapshot: vi.fn(() => emptySnapshot()),
      subscribeApprovals: vi.fn(
        (listener: (snapshot: ApprovalSnapshot) => void) => {
          listeners.push(listener);
          listener(emptySnapshot());
          return unsubscribe;
        },
      ),
      executeDesktopAction: vi.fn(async () => {
        listeners[0]?.({
          mode: "approve_all",
          pendingCount: 1,
          pendingApprovals: [approval],
        });
        return { success: true, message: "Clicked." };
      }),
    };
    const runtime = {
      getService: vi.fn((name: string) =>
        name === "computeruse" ? service : null,
      ),
    };
    const callback = vi.fn(async () => []);

    const result = await useComputerAction.handler?.(
      runtime as never,
      { content: { text: "" } } as never,
      undefined,
      {
        parameters: {
          action: "click",
          coordinate: [10, 20],
          displayId: 0,
        },
      } as never,
      callback,
    );

    expect(result?.success).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const approvalCall = callback.mock.calls.find(
      ([, actionName]) => actionName === "COMPUTER_USE_APPROVAL",
    );
    expect(approvalCall?.[0]).toMatchObject({
      source: "computeruse_approval",
      text: expect.stringContaining(
        "[CHOICE:computeruse-approval id=approval_123]",
      ),
    });
    expect(approvalCall?.[0].text).toContain(
      "cua:approval_123:approve=Approve",
    );
    expect(approvalCall?.[0].text).toContain("cua:approval_123:deny=Deny");
    expect(callback).toHaveBeenLastCalledWith({ text: "Clicked." });
  });
});
