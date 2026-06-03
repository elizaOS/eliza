// Loads + live-updates one task room, mirroring the proven OrchestratorWorkbench
// pattern (three tiers: initial fetch on selection, reconcile poll, SSE
// change-ping → debounced tail refetch). Returns the odysseus conversation
// (block list) plus activity state. The SessionEvent contract is unchanged —
// this is the "reuse existing ACP" path from the port roadmap (Phase 1).

import type {
  CodingAgentTaskEventRecord,
  CodingAgentTaskMessageRecord,
  CodingAgentTaskThreadDetail,
} from "@elizaos/ui";
import { client } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildConversation,
  type ConversationBlock,
} from "../../orchestrator-stream";

const POLL_INTERVAL_MS = 5_000;
const ACTIVE_POLL_INTERVAL_MS = 1_500;
const TIMELINE_PAGE_LIMIT = 50;
const REFETCH_DEBOUNCE_MS = 150;

function mergeById<T extends { id: string; timestamp: number }>(
  previous: T[],
  incoming: T[],
): T[] {
  const byId = new Map<string, T>();
  for (const item of previous) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function resolveSenderName(
  message: CodingAgentTaskMessageRecord,
  sessionLabelById: Map<string, string>,
  mainAgentName: string,
): string {
  if (message.senderKind === "sub_agent") {
    const label = message.sessionId
      ? sessionLabelById.get(message.sessionId)?.trim()
      : undefined;
    return label || "Sub-agent";
  }
  if (message.senderKind === "orchestrator") return mainAgentName;
  if (message.senderKind === "user") return "You";
  return "System";
}

export interface TaskRoom {
  detail: CodingAgentTaskThreadDetail | null;
  conversation: ConversationBlock[];
  isActive: boolean;
  loading: boolean;
}

export function useTaskRoom(selectedId: string | null): TaskRoom {
  const [detail, setDetail] = useState<CodingAgentTaskThreadDetail | null>(
    null,
  );
  const [messages, setMessages] = useState<CodingAgentTaskMessageRecord[]>([]);
  const [events, setEvents] = useState<CodingAgentTaskEventRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const reqRef = useRef(0);
  const selectedRef = useRef<string | null>(selectedId);
  const refetchTimer = useRef<number | null>(null);
  selectedRef.current = selectedId;

  const fetchDetail = useCallback(async (id: string, reset: boolean) => {
    const token = ++reqRef.current;
    const [nextDetail, messagePage, eventPage] = await Promise.all([
      client.getCodingAgentTaskThread(id),
      client.listOrchestratorTaskMessages(id, { limit: TIMELINE_PAGE_LIMIT }),
      client.listOrchestratorTaskEvents(id, { limit: TIMELINE_PAGE_LIMIT }),
    ]);
    if (token !== reqRef.current || id !== selectedRef.current) return;
    setDetail(nextDetail);
    if (reset) {
      setMessages(mergeById([], messagePage.items));
      setEvents(mergeById([], eventPage.items));
    } else {
      setMessages((prev) => mergeById(prev, messagePage.items));
      setEvents((prev) => mergeById(prev, eventPage.items));
    }
  }, []);

  // Selection change → reset room + initial fetch.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setMessages([]);
      setEvents([]);
      return;
    }
    setLoading(true);
    void fetchDetail(selectedId, true)
      .catch(() => {})
      .finally(() => {
        if (selectedRef.current === selectedId) setLoading(false);
      });
  }, [selectedId, fetchDetail]);

  const isActive =
    detail != null &&
    (detail.activeSessionCount > 0 ||
      detail.status === "active" ||
      detail.status === "validating");

  // Reconcile poll (safety net for dropped SSE).
  useEffect(() => {
    if (!selectedId) return;
    const ms = isActive ? ACTIVE_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    const timer = window.setInterval(
      () => void fetchDetail(selectedId, false).catch(() => {}),
      ms,
    );
    return () => window.clearInterval(timer);
  }, [selectedId, isActive, fetchDetail]);

  // Live SSE change-ping → debounced tail refetch.
  useEffect(() => {
    if (!selectedId) return;
    const scheduleRefetch = () => {
      if (refetchTimer.current != null)
        window.clearTimeout(refetchTimer.current);
      refetchTimer.current = window.setTimeout(() => {
        void fetchDetail(selectedId, false).catch(() => {});
      }, REFETCH_DEBOUNCE_MS);
    };
    const unsubscribe = client.streamOrchestratorTask(
      selectedId,
      scheduleRefetch,
    );
    return () => {
      unsubscribe();
      if (refetchTimer.current != null) {
        window.clearTimeout(refetchTimer.current);
        refetchTimer.current = null;
      }
    };
  }, [selectedId, fetchDetail]);

  const sessionLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of detail?.sessions ?? []) {
      const label = s.label?.trim();
      if (s.sessionId && label) map.set(s.sessionId, label);
    }
    return map;
  }, [detail?.sessions]);

  const finishedSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of detail?.sessions ?? []) {
      if (s.sessionId && (s.stoppedAt != null || s.status === "completed")) {
        ids.add(s.sessionId);
      }
    }
    return ids;
  }, [detail?.sessions]);

  const mainAgentName = detail?.sessions?.[0]?.label?.trim() || "Orchestrator";

  const conversation = useMemo(
    () =>
      buildConversation(
        messages,
        events,
        (m) => resolveSenderName(m, sessionLabelById, mainAgentName),
        finishedSessionIds,
      ),
    [messages, events, sessionLabelById, mainAgentName, finishedSessionIds],
  );

  return { detail, conversation, isActive, loading };
}
