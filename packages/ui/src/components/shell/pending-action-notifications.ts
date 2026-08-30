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
const inMemoryResolvedPendingActionIds = new Map<string, ReadonlySet<string>>();

type PersistedPendingActionResolutionState = "pending" | "resolved";

interface PersistedPendingActionResolutionEntry {
  state: PersistedPendingActionResolutionState;
  observedAt: number;
}

interface PersistedPendingActionResolutionDocument {
  version: 1;
  entries: Record<string, PersistedPendingActionResolutionEntry>;
}

export interface PendingActionResolutionStorage {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PersistedResolvedPendingActionIds =
  | { status: "missing"; ids: ReadonlySet<string> }
  | { status: "valid"; ids: ReadonlySet<string> }
  | {
      status: "invalid";
      ids: ReadonlySet<string>;
      keys: readonly string[];
    }
  | { status: "unavailable" };

export type PersistResolvedPendingActionIdsResult =
  | {
      status: "persisted" | "partial";
      ids: ReadonlySet<string>;
    }
  | { status: "unavailable" };

const STORAGE_RETRY_DELAY_MS = 5_000;
const MAX_STORAGE_RETRY_ATTEMPTS = 3;

function resolvedPendingActionIdEntryPrefix(key: string): string {
  return `${key}:id:`;
}

function resolvedPendingActionIdEntryKey(key: string, id: string): string {
  return `${resolvedPendingActionIdEntryPrefix(key)}${encodeURIComponent(id)}`;
}

function decodePersistedPendingActionResolutionDocument(
  raw: string,
): PersistedPendingActionResolutionDocument | null {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    if (parsed.some((id) => typeof id !== "string" || id.length === 0)) {
      return null;
    }
    return {
      version: 1,
      entries: Object.fromEntries(
        parsed.map((id) => [id, { state: "resolved", observedAt: 0 }]),
      ),
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    return null;
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (typeof entries !== "object" || entries === null) return null;
  for (const [id, entry] of Object.entries(entries)) {
    if (
      id.length === 0 ||
      typeof entry !== "object" ||
      entry === null ||
      ((entry as { state?: unknown }).state !== "pending" &&
        (entry as { state?: unknown }).state !== "resolved") ||
      typeof (entry as { observedAt?: unknown }).observedAt !== "number" ||
      !Number.isFinite((entry as { observedAt: number }).observedAt)
    ) {
      return null;
    }
  }
  return parsed as PersistedPendingActionResolutionDocument;
}

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
  let legacyRaw: string | null;
  let entryKeys: string[];
  try {
    legacyRaw = storage.getItem(key);
    const prefix = resolvedPendingActionIdEntryPrefix(key);
    entryKeys = Array.from({ length: storage.length }, (_, index) =>
      storage.key(index),
    ).flatMap((candidate) =>
      candidate?.startsWith(prefix) ? [candidate] : [],
    );
  } catch {
    // error-policy:J4 restricted storage degrades to the in-memory fence; the
    // canonical pending read model remains authoritative and visible.
    return { status: "unavailable" };
  }
  if (legacyRaw === null && entryKeys.length === 0) {
    return { status: "missing", ids: EMPTY_RESOLVED_PENDING_ACTION_IDS };
  }
  const entries: Record<string, PersistedPendingActionResolutionEntry> = {};
  const invalidKeys: string[] = [];
  if (legacyRaw !== null) {
    try {
      const legacy = decodePersistedPendingActionResolutionDocument(legacyRaw);
      if (legacy === null) invalidKeys.push(key);
      else Object.assign(entries, legacy.entries);
    } catch {
      invalidKeys.push(key);
    }
  }
  const prefix = resolvedPendingActionIdEntryPrefix(key);
  for (const entryKey of entryKeys) {
    let raw: string | null;
    try {
      raw = storage.getItem(entryKey);
    } catch {
      // error-policy:J4 restricted storage degrades to the in-memory fence;
      // canonical polling remains visible instead of crashing Home.
      return { status: "unavailable" };
    }
    if (raw === null) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const id = decodeURIComponent(entryKey.slice(prefix.length));
      if (
        id.length === 0 ||
        typeof parsed !== "object" ||
        parsed === null ||
        ((parsed as { state?: unknown }).state !== "pending" &&
          (parsed as { state?: unknown }).state !== "resolved") ||
        typeof (parsed as { observedAt?: unknown }).observedAt !== "number" ||
        !Number.isFinite((parsed as { observedAt: number }).observedAt)
      ) {
        invalidKeys.push(entryKey);
        continue;
      }
      entries[id] = parsed as PersistedPendingActionResolutionEntry;
    } catch {
      invalidKeys.push(entryKey);
    }
  }
  const ids = new Set(
    Object.entries(entries).flatMap(([id, entry]) =>
      entry.state === "resolved" ? [id] : [],
    ),
  );
  if (invalidKeys.length > 0) {
    // error-policy:J3 persisted browser bytes are untrusted; repair only the
    // malformed records while retaining independently valid fences.
    return { status: "invalid", ids, keys: invalidKeys };
  }
  return { status: "valid", ids };
}

export function persistResolvedPendingActionIds(
  storage: PendingActionResolutionStorage,
  key: string,
  previousIds: ReadonlySet<string>,
  nextIds: ReadonlySet<string>,
  observedAt: number,
): PersistResolvedPendingActionIdsResult {
  const confirmedIds = new Set(previousIds);
  let partial = false;
  let attemptedTransitions = 0;
  let confirmedTransitions = 0;
  for (const id of previousIds) {
    if (!nextIds.has(id)) {
      attemptedTransitions += 1;
      try {
        const entryKey = resolvedPendingActionIdEntryKey(key, id);
        storage.setItem(
          entryKey,
          JSON.stringify({ state: "pending", observedAt }),
        );
        const written = storage.getItem(entryKey);
        if (
          written === null ||
          (JSON.parse(written) as { state?: unknown }).state !== "pending"
        ) {
          partial = true;
          continue;
        }
        confirmedIds.delete(id);
        confirmedTransitions += 1;
      } catch {
        partial = true;
      }
    }
  }
  for (const id of nextIds) {
    if (!previousIds.has(id)) {
      attemptedTransitions += 1;
      try {
        const entryKey = resolvedPendingActionIdEntryKey(key, id);
        storage.setItem(
          entryKey,
          JSON.stringify({ state: "resolved", observedAt }),
        );
        const written = storage.getItem(entryKey);
        if (
          written === null ||
          (JSON.parse(written) as { state?: unknown }).state !== "resolved"
        ) {
          partial = true;
          continue;
        }
        confirmedIds.add(id);
        confirmedTransitions += 1;
      } catch {
        partial = true;
      }
    }
  }

  try {
    const prefix = resolvedPendingActionIdEntryPrefix(key);
    const entries = Array.from({ length: storage.length }, (_, index) =>
      storage.key(index),
    ).flatMap((entryKey) => {
      if (!entryKey?.startsWith(prefix)) return [];
      const raw = storage.getItem(entryKey);
      if (raw === null) return [];
      const parsed = JSON.parse(raw) as { observedAt?: unknown };
      return typeof parsed.observedAt === "number" &&
        Number.isFinite(parsed.observedAt)
        ? [{ entryKey, observedAt: parsed.observedAt }]
        : [];
    });
    entries
      .sort((left, right) => left.observedAt - right.observedAt)
      .slice(0, -MAX_PERSISTED_RESOLVED_PENDING_ACTION_IDS)
      .forEach(({ entryKey }) => {
        storage.removeItem(entryKey);
      });
  } catch {
    partial = true;
  }

  if (partial && attemptedTransitions > 0 && confirmedTransitions === 0) {
    return { status: "unavailable" };
  }
  return {
    status: partial ? "partial" : "persisted",
    ids: confirmedIds,
  };
}

function resolutionIdSetsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function removeInvalidResolvedPendingActionIds(
  storage: PendingActionResolutionStorage,
  keys: readonly string[],
): boolean {
  try {
    for (const key of keys) storage.removeItem(key);
    return true;
  } catch {
    // error-policy:J4 restricted storage keeps the in-memory fence active.
    return false;
  }
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
  const [storageRetryRequestedAt, setStorageRetryRequestedAt] = useState(0);
  const mountedRef = useRef(true);
  const storageRetryCountRef = useRef(0);
  const persistedResolutionIdsRef = useRef<{
    ownerKey: string | null;
    ids: ReadonlySet<string>;
  }>({ ownerKey: null, ids: EMPTY_RESOLVED_PENDING_ACTION_IDS });
  const { state: authStatus } = useAuthStatus({ observeOnly: true });
  const authenticated = authStatus.phase === "authenticated";
  const ownerKey = authenticated
    ? resolvedPendingActionIdsStorageKey(
        authStatus.identity.id,
        client.getBaseUrl(),
      )
    : null;
  const requestScope =
    authStatus.phase === "authenticated"
      ? `${ownerKey}:${authStatus.session.id}`
      : null;
  const requestScopeRef = useRef(requestScope);
  requestScopeRef.current = requestScope;
  const requestGenerationRef = useRef(0);
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
      persistedResolutionIdsRef.current = {
        ownerKey: null,
        ids: EMPTY_RESOLVED_PENDING_ACTION_IDS,
      };
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
      removeInvalidResolvedPendingActionIds(
        window.localStorage,
        persisted.keys,
      );
    }
    const resolvedActionIds =
      persisted.status === "valid" || persisted.status === "invalid"
        ? persisted.ids
        : persisted.status === "unavailable"
          ? (inMemoryResolvedPendingActionIds.get(ownerKey) ??
            EMPTY_RESOLVED_PENDING_ACTION_IDS)
          : EMPTY_RESOLVED_PENDING_ACTION_IDS;
    inMemoryResolvedPendingActionIds.set(ownerKey, resolvedActionIds);
    persistedResolutionIdsRef.current = {
      ownerKey,
      ids: resolvedActionIds,
    };
    setSnapshot({
      ownerKey,
      pending: [],
      resolvedActionIds,
    });
  }, [ownerKey]);

  useEffect(() => {
    if (snapshot.ownerKey === null) return;
    const persistedPrevious =
      persistedResolutionIdsRef.current.ownerKey === snapshot.ownerKey
        ? persistedResolutionIdsRef.current.ids
        : EMPTY_RESOLVED_PENDING_ACTION_IDS;
    inMemoryResolvedPendingActionIds.set(
      snapshot.ownerKey,
      snapshot.resolvedActionIds,
    );
    if (resolutionIdSetsEqual(persistedPrevious, snapshot.resolvedActionIds)) {
      storageRetryCountRef.current = 0;
      return;
    }
    const result = persistResolvedPendingActionIds(
      window.localStorage,
      snapshot.ownerKey,
      persistedPrevious,
      snapshot.resolvedActionIds,
      Date.now(),
    );
    if (result.status !== "unavailable") {
      persistedResolutionIdsRef.current = {
        ownerKey: snapshot.ownerKey,
        ids: result.ids,
      };
      if (resolutionIdSetsEqual(result.ids, snapshot.resolvedActionIds)) {
        storageRetryCountRef.current = 0;
        if (storageRetryRequestedAt !== 0) setStorageRetryRequestedAt(0);
        return;
      }
    }
    if (storageRetryCountRef.current >= MAX_STORAGE_RETRY_ATTEMPTS) return;
    storageRetryCountRef.current += 1;
    const retry = window.setTimeout(() => {
      setStorageRetryRequestedAt(Date.now());
    }, STORAGE_RETRY_DELAY_MS);
    return () => window.clearTimeout(retry);
  }, [snapshot.ownerKey, snapshot.resolvedActionIds, storageRetryRequestedAt]);

  const load = useCallback(async () => {
    const requestGeneration = ++requestGenerationRef.current;
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
    const activeRequestScope = requestScope;
    try {
      const { pending: next } = await client.listPendingActions();
      if (
        !mountedRef.current ||
        requestScopeRef.current !== activeRequestScope ||
        requestGenerationRef.current !== requestGeneration
      ) {
        return;
      }
      setSnapshot((previous) => {
        if (previous.ownerKey !== ownerKey) return previous;
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
      // A successful empty poll does not change the rendered projection, so
      // keep its freshness clock at the stable empty sentinel. Updating this
      // timestamp every 20 seconds rebuilt the entire notification shade even
      // when it contained only ordinary persisted notifications. Non-empty
      // pending actions still refresh their observation time on every
      // successful canonical read so their stale boundary remains accurate.
      setObservedAt(next.length > 0 ? Date.now() : 0);
    } catch {
      // error-policy:J4 the last confirmed projection stays visible while the
      // next bounded poll retries; a transport failure never fabricates empty.
    } finally {
      if (
        mountedRef.current &&
        requestScopeRef.current === activeRequestScope &&
        requestGenerationRef.current === requestGeneration
      ) {
        setLoaded(true);
      }
    }
  }, [authenticated, ownerKey, requestScope, resolutionFenceLoaded]);

  useEffect(() => {
    void load();
  }, [load]);
  useIntervalWhenDocumentVisible(
    () => void load(),
    20_000,
    authenticated && resolutionFenceLoaded,
  );

  const snapshotMatchesOwner = snapshot.ownerKey === ownerKey;
  return {
    pending: snapshotMatchesOwner ? snapshot.pending : [],
    resolvedActionIds: snapshotMatchesOwner
      ? snapshot.resolvedActionIds
      : EMPTY_RESOLVED_PENDING_ACTION_IDS,
    loaded: snapshotMatchesOwner && loaded,
    observedAt,
  };
}
