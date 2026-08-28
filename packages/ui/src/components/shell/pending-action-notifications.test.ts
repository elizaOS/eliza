/**
 * Verifies the state-backed pending-action projection and response routing
 * without replacing the canonical agent read model with notification events.
 */

import type { AgentNotification, PendingUserAction } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { orderDashboardNotifications } from "./notification-shade-content";
import {
  derivePendingActionActivation,
  derivePendingActionOptionReply,
  pendingActionIdFromNotification,
  reconcilePendingActionNotifications,
} from "./pending-action-notifications";

const NOW = 2_000_000;

function pending(
  overrides: Partial<PendingUserAction> = {},
): PendingUserAction {
  return {
    id: "request-1",
    kind: "approval",
    source: "lifeops",
    title: "Send the weekly report?",
    createdAt: NOW - 5_000,
    ...overrides,
  };
}

function persistedApproval(): AgentNotification {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Approval needed",
    body: "Send the weekly report?",
    category: "approval",
    priority: "high",
    source: "lifeops",
    deepLink: "/chat",
    groupKey: "approval:request-1",
    data: { requestId: "request-1" },
    createdAt: NOW - 5_000,
  };
}

describe("pending-action notification projection", () => {
  it("replaces a dismissible approval event with one live state-backed row", () => {
    const unrelated = persistedApproval();
    unrelated.id = "22222222-2222-4222-8222-222222222222";
    unrelated.groupKey = "approval:request-2";
    unrelated.data = { requestId: "request-2" };
    const projected = reconcilePendingActionNotifications(
      [persistedApproval(), unrelated],
      [pending()],
      NOW,
    );
    expect(projected).toHaveLength(2);
    expect(projected[0]).toEqual(unrelated);
    const notification = projected[1];
    expect(notification).toBeDefined();
    if (!notification) throw new Error("Expected one projected notification");
    expect(notification.id).not.toBe(persistedApproval().id);
    expect(pendingActionIdFromNotification(notification)).toBe("request-1");
    expect(notification).toMatchObject({
      title: "Send the weekly report?",
      category: "approval",
      priority: "high",
    });
  });

  it("promotes a maximum-weight blocker immediately before it becomes stale", () => {
    const [notification] = reconcilePendingActionNotifications(
      [],
      [pending({ kind: "blocked_task", weight: 10, createdAt: NOW - 1 })],
      NOW,
    );
    expect(notification?.priority).toBe("urgent");
  });

  it("reappears from unresolved state after the persisted row is removed", () => {
    const first = reconcilePendingActionNotifications([], [pending()], NOW);
    const next = reconcilePendingActionNotifications([], [pending()], NOW);
    expect(next).toEqual(first);
  });

  it("does not resurrect a resolved approval from its read persisted event", () => {
    const resolved = persistedApproval();
    const first = reconcilePendingActionNotifications(
      [resolved],
      [pending()],
      NOW,
    );
    expect(first).toHaveLength(1);
    const projected = first[0];
    if (!projected) throw new Error("Expected the unresolved projection");
    expect(pendingActionIdFromNotification(projected)).toBe("request-1");

    resolved.readAt = NOW + 1_000;

    expect(reconcilePendingActionNotifications([resolved], [], NOW)).toEqual(
      [],
    );
  });

  it("covers task approvals and free prompts without inventing one response", () => {
    expect(
      derivePendingActionActivation(
        pending({ kind: "task_approval", options: undefined }),
      ),
    ).toEqual({ mode: "prefill", text: "Approve: Send the weekly report?" });
    expect(
      derivePendingActionActivation(
        pending({ kind: "pending_prompt", options: undefined }),
      ),
    ).toEqual({ mode: "open-chat" });
  });

  it("preserves typed choices and their canonical chat replies", () => {
    const item = pending({
      kind: "choice",
      options: [
        { id: "approve", label: "Yes" },
        { id: "later", label: "Ask me later" },
      ],
    });
    expect(derivePendingActionActivation(item)).toEqual({
      mode: "choices",
      options: item.options,
    });
    const [approve, later] = item.options ?? [];
    expect(approve).toBeDefined();
    expect(later).toBeDefined();
    if (!approve || !later) throw new Error("Expected two response options");
    expect(derivePendingActionOptionReply(item, approve)).toBe(
      "Approve: Send the weekly report?",
    );
    expect(derivePendingActionOptionReply(item, later)).toBe("Ask me later");
  });

  it("promotes stale blockers and keeps pending actions oldest-first", () => {
    const projected = reconcilePendingActionNotifications(
      [],
      [
        pending({ id: "newer", createdAt: NOW - 10_000 }),
        pending({
          id: "oldest",
          createdAt: NOW - 31 * 60_000,
          title: "Oldest blocker",
        }),
        pending({ id: "older", createdAt: NOW - 20_000 }),
      ],
      NOW,
    );
    const ordered = orderDashboardNotifications(projected);
    expect(ordered.map(pendingActionIdFromNotification)).toEqual([
      "oldest",
      "older",
      "newer",
    ]);
    expect(ordered[0]?.priority).toBe("urgent");
  });
});
