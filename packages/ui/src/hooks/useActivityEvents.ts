/**
 * Hook that subscribes to WebSocket activity events and maintains a ring buffer
 * of recent entries for the chat widget rail.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api";
import { parseProactiveMessageEvent } from "../state/parsers";

const RING_BUFFER_CAP = 200;

export interface ActivityEvent {
  id: string;
  timestamp: number;
  eventType: string;
  sessionId?: string;
  summary: string;
}

let nextEventId = 0;

function makeEventId(): string {
  nextEventId += 1;
  return `evt-${nextEventId}-${Date.now()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeAssistantActivityEvent(data: Record<string, unknown>): {
  eventType: string;
  summary: string;
} | null {
  if (data.type !== "agent_event" || data.stream !== "assistant") {
    return null;
  }
  const payload = isRecord(data.payload) ? data.payload : null;
  if (!payload) {
    return null;
  }

  const source = typeof payload.source === "string" ? payload.source : "";
  const text =
    typeof payload.text === "string" ? payload.text.trim().slice(0, 120) : "";
  if (!text) {
    return null;
  }

  switch (source) {
    case "lifeops-reminder":
      return { eventType: "reminder", summary: text };
    case "lifeops-workflow":
      return { eventType: "workflow", summary: text };
    case "proactive-gm":
    case "proactive-gn":
    case "proactive-goal-check-in":
      return { eventType: "check-in", summary: text };
    case "proactive-nudge":
    case "proactive-social-overuse":
      return { eventType: "nudge", summary: text };
    default:
      return null;
  }
}

/**
 * Subscribe to task/proactive websocket events plus assistant activity events,
 * returning a capped list of recent activity entries.
 */
export function useActivityEvents() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const bufferRef = useRef<ActivityEvent[]>([]);
  const flushHandleRef = useRef<number | null>(null);

  const cancelPendingFlush = useCallback(() => {
    if (flushHandleRef.current === null) {
      return;
    }
    cancelAnimationFrame(flushHandleRef.current);
    flushHandleRef.current = null;
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushHandleRef.current !== null) {
      return;
    }
    flushHandleRef.current = requestAnimationFrame(() => {
      flushHandleRef.current = null;
      setEvents([...bufferRef.current]);
    });
  }, []);

  const pushEvent = useCallback(
    (entry: Omit<ActivityEvent, "id">) => {
      const event: ActivityEvent = { ...entry, id: makeEventId() };
      const buf = bufferRef.current;
      buf.unshift(event);
      if (buf.length > RING_BUFFER_CAP) {
        buf.length = RING_BUFFER_CAP;
      }
      scheduleFlush();
    },
    [scheduleFlush],
  );

  useEffect(() => {
    const unbindPty = client.onWsEvent(
      "pty-session-event",
      (data: Record<string, unknown>) => {
        // Validate the WS boundary instead of casting: strings stay strings,
        // anything else becomes undefined so a malformed event can't poison the rail.
        const str = (v: unknown): string | undefined =>
          typeof v === "string" ? v : undefined;
        const eventType = str(data.eventType) ?? str(data.type) ?? "";
        const sessionId = str(data.sessionId);
        const d = isRecord(data.data) ? data.data : undefined;

        let summary = eventType;
        if (eventType === "task_registered") {
          summary = `Task started: ${str(d?.label) ?? sessionId ?? "unknown"}`;
        } else if (eventType === "task_complete" || eventType === "stopped") {
          summary = `Task ${eventType === "task_complete" ? "completed" : "stopped"}`;
        } else if (eventType === "tool_running") {
          const tool = str(d?.description) ?? str(d?.toolName) ?? "tool";
          summary = `Running ${tool}`.slice(0, 80);
        } else if (eventType === "blocked") {
          summary = "Waiting for input";
        } else if (eventType === "blocked_auto_resolved") {
          summary = "Decision auto-approved";
        } else if (eventType === "escalation") {
          summary = "Escalated — needs attention";
        } else if (eventType === "error") {
          summary = "Error occurred";
        }

        pushEvent({
          timestamp: Date.now(),
          eventType,
          sessionId: sessionId ?? undefined,
          summary,
        });
      },
    );

    const unbindProactive = client.onWsEvent(
      "proactive-message",
      (data: Record<string, unknown>) => {
        // The server broadcasts `message` as an object {id, role, text, ...};
        // parse it with the canonical typed parser and surface the real text
        // (the old hand-rolled `typeof data.message === "string"` was always
        // false, so the rail only ever showed the generic placeholder).
        const parsed = parseProactiveMessageEvent(data);
        if (!parsed) return;
        const summary =
          parsed.message.text.trim().slice(0, 120) || "Proactive message";
        pushEvent({
          timestamp: Date.now(),
          eventType: "proactive-message",
          summary,
        });
      },
    );

    const unbindAgent = client.onWsEvent(
      "agent_event",
      (data: Record<string, unknown>) => {
        const activity = summarizeAssistantActivityEvent(data);
        if (!activity) {
          return;
        }
        pushEvent({
          timestamp: Date.now(),
          eventType: activity.eventType,
          summary: activity.summary,
        });
      },
    );

    return () => {
      unbindPty();
      unbindProactive();
      unbindAgent();
      cancelPendingFlush();
    };
  }, [pushEvent, cancelPendingFlush]);

  const clearEvents = useCallback(() => {
    bufferRef.current = [];
    cancelPendingFlush();
    setEvents([]);
  }, [cancelPendingFlush]);

  return { events, clearEvents } as const;
}
