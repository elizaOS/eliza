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
  persistResolvedPendingActionIds,
  readPersistedResolvedPendingActionIds,
  reconcilePendingActionNotifications,
  reconcileResolvedPendingActionIds,
  resolvedPendingActionIdsStorageKey,
} from "./pending-action-notifications";

const NOW = 2_000_000;

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class UnavailableStorage extends MemoryStorage {
  override getItem(_key: string): string | null {
    throw new DOMException("Storage disabled", "SecurityError");
  }

  override setItem(_key: string, _value: string): void {
    throw new DOMException("Storage full", "QuotaExceededError");
  }

  override removeItem(_key: string): void {
    throw new DOMException("Storage disabled", "SecurityError");
  }
}

class FailOneSetStorage extends MemoryStorage {
  private setCount = 0;

  constructor(private readonly failAtSet: number) {
    super();
  }

  override setItem(key: string, value: string): void {
    this.setCount += 1;
    if (this.setCount === this.failAtSet) {
      throw new DOMException("Transient write failure", "QuotaExceededError");
    }
    super.setItem(key, value);
  }
}

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
    unrelated.readAt = null;
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

  it("does not resurrect an unchanged unread row after canonical resolution", () => {
    const unresolved = pending();
    const persisted = persistedApproval();
    persisted.readAt = null;
    expect(
      reconcilePendingActionNotifications([persisted], [unresolved], NOW),
    ).toHaveLength(1);

    const resolvedActionIds = reconcileResolvedPendingActionIds(
      [unresolved],
      [],
      new Set(),
    );
    expect(
      reconcilePendingActionNotifications(
        [persisted],
        [],
        NOW,
        resolvedActionIds,
      ),
    ).toEqual([]);
  });

  it("keeps canonical resolution terminal across a component remount", () => {
    const storage = new MemoryStorage();
    const key = resolvedPendingActionIdsStorageKey(
      "owner-1",
      "https://bot.example.test",
    );
    const unresolved = pending();
    const persisted = persistedApproval();
    persisted.readAt = null;
    const mountedResolvedIds = reconcileResolvedPendingActionIds(
      [unresolved],
      [],
      new Set(),
    );
    expect(
      persistResolvedPendingActionIds(
        storage,
        key,
        new Set(),
        mountedResolvedIds,
        NOW,
      ),
    ).toEqual({ status: "persisted", ids: new Set(["request-1"]) });

    const remounted = readPersistedResolvedPendingActionIds(storage, key);
    expect(remounted.status).toBe("valid");
    if (remounted.status !== "valid") {
      throw new Error("Expected a durable resolution fence");
    }
    expect(
      reconcilePendingActionNotifications([persisted], [], NOW, remounted.ids),
    ).toEqual([]);
  });

  it("clears a durable tombstone when the canonical action reappears", () => {
    const next = reconcileResolvedPendingActionIds(
      [],
      [pending()],
      new Set(["request-1"]),
    );
    expect([...next]).toEqual([]);
  });

  it("merges independent tab transitions without losing either tombstone", () => {
    const storage = new MemoryStorage();
    const key = resolvedPendingActionIdsStorageKey("owner-1", "");
    expect(
      persistResolvedPendingActionIds(
        storage,
        key,
        new Set(),
        new Set(["resolved-a"]),
        NOW,
      ),
    ).toEqual({ status: "persisted", ids: new Set(["resolved-a"]) });
    const tabB = persistResolvedPendingActionIds(
      storage,
      key,
      new Set(),
      new Set(["resolved-b"]),
      NOW + 1,
    );
    expect(tabB).toEqual({
      status: "persisted",
      ids: new Set(["resolved-b"]),
    });
    if (tabB.status === "unavailable") {
      throw new Error("Expected Tab B transition acknowledgement");
    }

    persistResolvedPendingActionIds(
      storage,
      key,
      tabB.ids,
      new Set(["resolved-b"]),
      NOW + 2,
    );

    const merged = readPersistedResolvedPendingActionIds(storage, key);
    expect(merged.status).toBe("valid");
    if (merged.status !== "valid") throw new Error("Expected merged fences");
    expect([...merged.ids].sort()).toEqual(["resolved-a", "resolved-b"]);

    persistResolvedPendingActionIds(
      storage,
      key,
      new Set(["resolved-a"]),
      new Set(),
      NOW + 3,
    );
    const cleared = readPersistedResolvedPendingActionIds(storage, key);
    expect(cleared.status).toBe("valid");
    if (cleared.status !== "valid") throw new Error("Expected cleared fence");
    expect([...cleared.ids]).toEqual(["resolved-b"]);
  });

  it("reports unavailable storage without crashing the notification surface", () => {
    const storage = new UnavailableStorage();
    const key = resolvedPendingActionIdsStorageKey("owner-1", "");
    expect(readPersistedResolvedPendingActionIds(storage, key)).toEqual({
      status: "unavailable",
    });
    expect(
      persistResolvedPendingActionIds(
        storage,
        key,
        new Set(),
        new Set(["request-1"]),
        NOW,
      ),
    ).toEqual({ status: "unavailable" });
  });

  it("retries from read-back state after a partial transition write", () => {
    const storage = new FailOneSetStorage(2);
    const key = resolvedPendingActionIdsStorageKey("owner-1", "");
    const desired = new Set(["resolved-a", "resolved-b"]);

    const partial = persistResolvedPendingActionIds(
      storage,
      key,
      new Set(),
      desired,
      NOW,
    );
    expect(partial).toEqual({
      status: "partial",
      ids: new Set(["resolved-a"]),
    });
    if (partial.status === "unavailable") {
      throw new Error("Expected readable partial state");
    }

    expect(
      persistResolvedPendingActionIds(
        storage,
        key,
        partial.ids,
        desired,
        NOW + 1,
      ),
    ).toEqual({ status: "persisted", ids: desired });
    expect(readPersistedResolvedPendingActionIds(storage, key)).toEqual({
      status: "valid",
      ids: desired,
    });
  });

  it("isolates durable resolution fences by owner and authority", () => {
    expect(
      resolvedPendingActionIdsStorageKey("owner-1", "https://bot.example.test"),
    ).not.toBe(
      resolvedPendingActionIdsStorageKey("owner-2", "https://bot.example.test"),
    );
    expect(
      resolvedPendingActionIdsStorageKey("owner-1", "https://bot.example.test"),
    ).not.toBe(
      resolvedPendingActionIdsStorageKey(
        "owner-1",
        "https://other.example.test",
      ),
    );
  });

  it("reports malformed lifecycle storage explicitly before repair", () => {
    const storage = new MemoryStorage();
    const key = resolvedPendingActionIdsStorageKey("owner-1", "");
    storage.setItem(key, '{"not":"an id list"}');
    expect(readPersistedResolvedPendingActionIds(storage, key)).toEqual({
      status: "invalid",
      ids: new Set(),
      keys: [key],
    });
  });

  it("retains valid per-action fences while repairing a malformed record", () => {
    const storage = new MemoryStorage();
    const key = resolvedPendingActionIdsStorageKey("owner-1", "");
    persistResolvedPendingActionIds(
      storage,
      key,
      new Set(),
      new Set(["resolved-valid"]),
      NOW,
    );
    storage.setItem(key, '{"not":"an id list"}');

    expect(readPersistedResolvedPendingActionIds(storage, key)).toEqual({
      status: "invalid",
      ids: new Set(["resolved-valid"]),
      keys: [key],
    });
  });

  it("preserves both runtime and legacy unread approval rows", () => {
    const runtimeUnread = persistedApproval();
    runtimeUnread.readAt = null;
    const legacyUnread = persistedApproval();
    legacyUnread.id = "22222222-2222-4222-8222-222222222222";
    legacyUnread.groupKey = "approval:request-2";
    legacyUnread.data = { requestId: "request-2" };

    expect(
      reconcilePendingActionNotifications(
        [runtimeUnread, legacyUnread],
        [],
        NOW,
      ),
    ).toEqual([runtimeUnread, legacyUnread]);
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
