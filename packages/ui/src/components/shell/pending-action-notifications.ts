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
import { useAuthStatus } from "../../hooks/useAuthStatus";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";

export const PENDING_ACTION_STALE_MS = 30 * 60_000;
const PENDING_ACTION_NOTIFICATION_NAMESPACE = "pending-action-notification";
const EMPTY_RESOLVED_PENDING_ACTION_IDS: ReadonlySet<string> = new Set();
const RESOLVED_PENDING_ACTION_IDS_STORAGE_NAMESPACE =
  "eliza:pending-actions:resolved";
const MAX_PERSISTED_RESOLVED_PENDING_ACTION_IDS = 512;

export interface PendingActionResolutionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PersistedResolvedPendingActionIds =
  | { status: "missing"; ids: ReadonlySet<string> }
  | { status: "valid"; ids: ReadonlySet<string> }
  | { status: "invalid" };

export function resolvedPendingActionIdsStorageKey(
  ownerId: string,
  apiBaseUrl: string,
): string {
  const authority = apiBaseUrl.trim() || "same-origin";
  return `${RESOLVED_PENDING_ACTION_IDS_STORAGE_NAMESPACE}:${encodeURIComponent(ownerId)}:${encodeURIComponent(authority)}`;
}

/**
 * Reads the durable resolution fence. Invalid client-controlled bytes are an
 * explicit repair signal rather than a healthy empty snapshot.
 */
export function readPersistedResolvedPendingActionIds(
  storage: PendingActionResolutionStorage,
  key: string,
): PersistedResolvedPendingActionIds {
  const raw = storage.getItem(key);
  if (raw === null) {
    return { status: "missing", ids: EMPTY_RESOLVED_PENDING_ACTION_IDS };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      return { status: "invalid" };
    }
    return {
      status: "valid",
      ids: new Set(parsed.slice(-MAX_PERSISTED_RESOLVED_PENDING_ACTION_IDS)),
    };
  } catch {
    // error-policy:J3 persisted browser bytes are untrusted; the caller must
    // explicitly repair this invalid signal before canonical polling resumes.
    return { status: "invalid" };
  }
}

export function persistResolvedPendingActionIds(
  storage: PendingActionResolutionStorage,
  key: string,
  ids: ReadonlySet<string>,
): void {
  storage.setItem(
    key,
    JSON.stringify([...ids].slice(-MAX_PERSISTED_RESOLVED_PENDING_ACTION_IDS)),
  );
}

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
  resolvedActionIds: ReadonlySet<string> = EMPTY_RESOLVED_PENDING_ACTION_IDS,
): AgentNotification[] {
  const pendingIds = new Set(pending.map((item) => item.id));
  const ordinaryNotifications = notifications.filter((notification) => {
    const actionId = persistedNotificationActionId(notification);
    if (actionId === null) return true;
    if (pendingIds.has(actionId)) return false;
    if (resolvedActionIds.has(actionId)) return false;
    return notification.readAt === null || notification.readAt === undefined;
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

/**
 * Retains canonical pending-to-absent transitions for the authenticated shell
 * so a delayed unread event cannot resurrect work that already resolved.
 * Reappearing IDs clear their tombstone because the canonical read model wins.
 */
export function reconcileResolvedPendingActionIds(
  previousPending: readonly PendingUserAction[],
  nextPending: readonly PendingUserAction[],
  previousResolved: ReadonlySet<string>,
): ReadonlySet<string> {
  const nextIds = new Set(nextPending.map((item) => item.id));
  let resolved: Set<string> | null = null;
  const writable = () => {
    resolved ??= new Set(previousResolved);
    return resolved;
  };

  for (const item of previousPending) {
    if (!nextIds.has(item.id) && !previousResolved.has(item.id)) {
      writable().add(item.id);
    }
  }
  for (const item of nextPending) {
    if (previousResolved.has(item.id)) writable().delete(item.id);
  }

  return resolved ?? previousResolved;
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
  resolvedActionIds: ReadonlySet<string>;
  loaded: boolean;
  observedAt: number;
} {
  const [snapshot, setSnapshot] = useState<{
    ownerKey: string | null;
    pending: PendingUserAction[];
    resolvedActionIds: ReadonlySet<string>;
  }>({
    ownerKey: null,
    pending: [],
    resolvedActionIds: EMPTY_RESOLVED_PENDING_ACTION_IDS,
  });
  const [loaded, setLoaded] = useState(false);
  const [observedAt, setObservedAt] = useState(0);
  const mountedRef = useRef(true);
  const { state: authStatus } = useAuthStatus({ observeOnly: true });
  const authenticated = authStatus.phase === "authenticated";
  const ownerKey = authenticated
    ? resolvedPendingActionIdsStorageKey(
        authStatus.identity.id,
        client.getBaseUrl(),
      )
    : null;
  const resolutionFenceLoaded = snapshot.ownerKey === ownerKey;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setLoaded(false);
    if (ownerKey === null) {
      setSnapshot({
        ownerKey: null,
        pending: [],
        resolvedActionIds: EMPTY_RESOLVED_PENDING_ACTION_IDS,
      });
      setLoaded(true);
      return;
    }

    const persisted = readPersistedResolvedPendingActionIds(
      window.localStorage,
      ownerKey,
    );
    if (persisted.status === "invalid") {
      // error-policy:J3 the resolution fence is rebuildable from canonical
      // transitions; discard malformed storage before treating it as empty.
      window.localStorage.removeItem(ownerKey);
    }
    setSnapshot({
      ownerKey,
      pending: [],
      resolvedActionIds:
        persisted.status === "valid"
          ? persisted.ids
          : EMPTY_RESOLVED_PENDING_ACTION_IDS,
    });
  }, [ownerKey]);

  useEffect(() => {
    if (snapshot.ownerKey === null) return;
    persistResolvedPendingActionIds(
      window.localStorage,
      snapshot.ownerKey,
      snapshot.resolvedActionIds,
    );
  }, [snapshot.ownerKey, snapshot.resolvedActionIds]);

  const load = useCallback(async () => {
    if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
      if (mountedRef.current) {
        setSnapshot({
          ownerKey,
          pending: [],
          resolvedActionIds: EMPTY_RESOLVED_PENDING_ACTION_IDS,
        });
        setLoaded(true);
      }
      return;
    }
    if (!resolutionFenceLoaded) return;
    try {
      const { pending: next } = await client.listPendingActions();
      if (!mountedRef.current) return;
      setSnapshot((previous) => {
        const pendingEqual = pendingActionsEqual(previous.pending, next);
        const resolvedActionIds = reconcileResolvedPendingActionIds(
          previous.pending,
          next,
          previous.resolvedActionIds,
        );
        if (pendingEqual && resolvedActionIds === previous.resolvedActionIds) {
          return previous;
        }
        return {
          ownerKey: previous.ownerKey,
          pending: pendingEqual ? previous.pending : next,
          resolvedActionIds,
        };
      });
      setObservedAt(Date.now());
    } catch {
      // error-policy:J4 the last confirmed projection stays visible while the
      // next bounded poll retries; a transport failure never fabricates empty.
    } finally {
      if (mountedRef.current) setLoaded(true);
    }
  }, [authenticated, ownerKey, resolutionFenceLoaded]);

  useEffect(() => {
    void load();
  }, [load]);
  useIntervalWhenDocumentVisible(() => void load(), 20_000);

  return {
    pending: snapshot.pending,
    resolvedActionIds: snapshot.resolvedActionIds,
    loaded,
    observedAt,
  };
}
