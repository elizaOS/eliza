/**
 * Projects the canonical pending-user-action read model into the Home
 * notification shade. The projection stays live until the underlying action
 * resolves, so opening or clearing an ordinary persisted notification cannot
 * hide work that still blocks the agent.
 */

import {
  type AgentNotification,
  type PendingUserAction,
  type PendingUserActionOption,
  stringToUuid,
} from "@elizaos/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api";
import { supportsFullAppShellRoutes } from "../../api/app-shell-capabilities";
import { useIsAuthenticated } from "../../hooks/useAuthStatus";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";

export const PENDING_ACTION_STALE_MS = 30 * 60_000;
const PENDING_ACTION_NOTIFICATION_NAMESPACE = "pending-action-notification";

export type PendingActionActivation =
  | { mode: "choices"; options: readonly PendingUserActionOption[] }
  | { mode: "prefill"; text: string }
  | { mode: "open-chat" };

export function derivePendingActionActivation(
  item: PendingUserAction,
): PendingActionActivation {
  if (item.options && item.options.length > 0) {
    return { mode: "choices", options: item.options };
  }
  if (item.kind === "approval" || item.kind === "task_approval") {
    return { mode: "prefill", text: `Approve: ${item.title}` };
  }
  return { mode: "open-chat" };
}

export function derivePendingActionOptionReply(
  item: PendingUserAction,
  option: PendingUserActionOption,
): string {
  if (option.id === "approve") return `Approve: ${item.title}`;
  if (option.id === "reject") return `Reject: ${item.title}`;
  return option.label;
}

export function pendingActionNotificationId(actionId: string) {
  return stringToUuid(`${PENDING_ACTION_NOTIFICATION_NAMESPACE}:${actionId}`);
}

export function pendingActionIdFromNotification(
  notification: AgentNotification,
): string | null {
  const actionId = notification.data?.pendingActionId;
  return typeof actionId === "string" ? actionId : null;
}

function persistedNotificationActionId(
  notification: AgentNotification,
): string | null {
  const requestId = notification.data?.requestId;
  if (typeof requestId === "string") return requestId;
  return notification.groupKey?.startsWith("approval:")
    ? notification.groupKey.slice("approval:".length)
    : null;
}

/**
 * Reconcile state-backed pending actions into the normal notification rows.
 * Persisted approval events are replaced while their request remains pending,
 * preventing duplicate cards without making a dismissible event authoritative
 * for unresolved state.
 */
export function reconcilePendingActionNotifications(
  notifications: readonly AgentNotification[],
  pending: readonly PendingUserAction[],
  now: number,
): AgentNotification[] {
  const pendingIds = new Set(pending.map((item) => item.id));
  const ordinaryNotifications = notifications.filter((notification) => {
    const actionId = persistedNotificationActionId(notification);
    return actionId === null || !pendingIds.has(actionId);
  });
  const projected = pending.map((item): AgentNotification => {
    const activation = derivePendingActionActivation(item);
    const body =
      item.description ??
      (activation.mode === "choices"
        ? "Choose a response."
        : activation.mode === "prefill"
          ? "Review and respond in chat."
          : "Answer in chat.");
    const stale =
      item.weight === 10 || now - item.createdAt >= PENDING_ACTION_STALE_MS;
    return {
      id: pendingActionNotificationId(item.id),
      title: item.title,
      body,
      category: "approval",
      priority: stale ? "urgent" : "high",
      source: item.source,
      deepLink: "/chat",
      groupKey: `pending-action:${item.id}`,
      data: {
        pendingActionId: item.id,
        pendingActionKind: item.kind,
      },
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
    };
  });
  return [...ordinaryNotifications, ...projected];
}

function pendingActionsEqual(
  previous: readonly PendingUserAction[],
  next: readonly PendingUserAction[],
): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((item, index) => {
    const other = next[index];
    if (!other) return false;
    return (
      item.id === other.id &&
      item.kind === other.kind &&
      item.source === other.source &&
      item.title === other.title &&
      item.description === other.description &&
      item.createdAt === other.createdAt &&
      item.expiresAt === other.expiresAt &&
      item.weight === other.weight &&
      JSON.stringify(item.options ?? []) === JSON.stringify(other.options ?? [])
    );
  });
}

/** Polls the canonical pending-action surface only on supported agent shells. */
export function usePendingActions(): {
  pending: readonly PendingUserAction[];
  loaded: boolean;
  observedAt: number;
} {
  const [pending, setPending] = useState<PendingUserAction[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [observedAt, setObservedAt] = useState(0);
  const mountedRef = useRef(true);
  const authenticated = useIsAuthenticated();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
      if (mountedRef.current) {
        setPending([]);
        setLoaded(true);
      }
      return;
    }
    try {
      const { pending: next } = await client.listPendingActions();
      if (!mountedRef.current) return;
      setPending((previous) =>
        pendingActionsEqual(previous, next) ? previous : next,
      );
      setObservedAt(Date.now());
    } catch {
      // error-policy:J4 the last confirmed projection stays visible while the
      // next bounded poll retries; a transport failure never fabricates empty.
    } finally {
      if (mountedRef.current) setLoaded(true);
    }
  }, [authenticated]);

  useEffect(() => {
    void load();
  }, [load]);
  useIntervalWhenDocumentVisible(() => void load(), 20_000);

  return { pending, loaded, observedAt };
}
