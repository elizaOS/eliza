/**
 * COMPUTER_USE action's approval-relay wiring — pending-approval snapshots reach
 * the message callback. Deterministic; no real desktop.
 */
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

  it("includes the Telegram requester id in approval callbacks when available", async () => {
    const listeners: Array<(snapshot: ApprovalSnapshot) => void> = [];
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
          return vi.fn();
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

    await useComputerAction.handler?.(
      runtime as never,
      { content: { text: "" }, metadata: { telegramUserId: "42" } } as never,
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

    const approvalCall = callback.mock.calls.find(
      ([, actionName]) => actionName === "COMPUTER_USE_APPROVAL",
    );
    expect(approvalCall?.[0].text).toContain(
      "cua:approval_123:approve:u42=Approve",
    );
    expect(approvalCall?.[0].text).toContain("cua:approval_123:deny:u42=Deny");
  });

  it("relays approval prompts while the desktop action is still pending", async () => {
    const listeners: Array<(snapshot: ApprovalSnapshot) => void> = [];
    const approval = {
      id: "approval_123",
      command: "desktop_click",
      parameters: { action: "click", coordinate: [10, 20] },
      requestedAt: "2026-06-22T12:00:00.000Z",
    };
    let finishAction:
      | ((result: {
          success: boolean;
          message?: string;
          error?: string;
        }) => void)
      | undefined;
    const service = {
      getApprovalSnapshot: vi.fn(() => emptySnapshot()),
      subscribeApprovals: vi.fn(
        (listener: (snapshot: ApprovalSnapshot) => void) => {
          listeners.push(listener);
          return vi.fn();
        },
      ),
      executeDesktopAction: vi.fn(async () => {
        listeners[0]?.({
          mode: "approve_all",
          pendingCount: 1,
          pendingApprovals: [approval],
        });
        return await new Promise<{
          success: boolean;
          message?: string;
          error?: string;
        }>((resolve) => {
          finishAction = resolve;
        });
      }),
    };
    const runtime = {
      getService: vi.fn((name: string) =>
        name === "computeruse" ? service : null,
      ),
    };
    const callback = vi.fn(async () => []);

    let completed = false;
    const resultPromise = useComputerAction
      .handler?.(
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
      )
      .then((result) => {
        completed = true;
        return result;
      });

    await Promise.resolve();
    await Promise.resolve();

    expect(completed).toBe(false);
    expect(
      callback.mock.calls.some(
        ([content, actionName]) =>
          actionName === "COMPUTER_USE_APPROVAL" &&
          String(content.text).includes("approval_123"),
      ),
    ).toBe(true);

    finishAction?.({ success: true, message: "Clicked." });
    const result = await resultPromise;

    expect(result?.success).toBe(true);
    expect(callback).toHaveBeenLastCalledWith({ text: "Clicked." });
  });
});
