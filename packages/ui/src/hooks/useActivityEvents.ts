/**
 * Hook that subscribes to WebSocket activity events and maintains a ring buffer
 * of recent entries for the chat widget rail.
 */

import { activityEventToPlaintext } from "@elizaos/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api";
import { parseProactiveMessageEvent } from "../state/parsers";

const RING_BUFFER_CAP = 200;

export interface ActivityEventSource {
  type: "pty-session-event" | "proactive-message" | "agent_event";
  stream?: string;
  data?: unknown;
  seq?: number;
  ts?: number;
  runId?: string;
  agentId?: string;
  roomId?: string;
  sessionKey?: string;
}

export interface ActivityEvent {
  id: string;
  timestamp: number;
  eventType: string;
  sessionId?: string;
  summary: string;
  source?: ActivityEventSource;
}

let nextEventId = 0;

function makeEventId(): string {
  nextEventId += 1;
  return `evt-${nextEventId}-${Date.now()}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function agentEventSource(data: Record<string, unknown>): ActivityEventSource {
  return {
    type: "agent_event",
    stream: readString(data.stream),
    data: data.payload ?? data.data,
    seq: readFiniteNumber(data.seq),
    ts: readFiniteNumber(data.ts),
    runId: readString(data.runId),
    agentId: readString(data.agentId),
    roomId: readString(data.roomId),
    sessionKey: readString(data.sessionKey),
  };
}

function workbenchFallbackActivity(
  source: ActivityEventSource,
): { eventType: string; plaintext: string; sessionId?: string } | null {
  if (source.stream !== "workbench") {
    return null;
  }
  const payload = readRecord(source.data);
  if (payload?.type !== "workbench.todo.changed") {
    return null;
  }
  const operation = readString(payload.operation) ?? "updated";
  const todo = readRecord(payload.todo);
  const name = readString(todo?.name);
  return {
    eventType: "workbench.todo.changed",
    plaintext: name ? `Todo ${operation}: ${name}` : `Todo ${operation}`,
  };
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
        const activity = activityEventToPlaintext(data, { maxLength: 120 });
        if (!activity) return;

        pushEvent({
          timestamp: readFiniteNumber(data.ts) ?? Date.now(),
          eventType: activity.eventType,
          sessionId: activity.sessionId,
          summary: activity.plaintext,
          source: {
            type: "pty-session-event",
            data,
            ts: readFiniteNumber(data.ts),
            sessionKey: readString(data.sessionId),
          },
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
        const activity = activityEventToPlaintext(
          { type: "proactive-message", message: { text: summary } },
          { maxLength: 120 },
        );
        pushEvent({
          timestamp: readFiniteNumber(data.ts) ?? Date.now(),
          eventType: activity?.eventType ?? "proactive-message",
          summary: activity?.plaintext ?? summary,
          source: {
            type: "proactive-message",
            data,
            ts: readFiniteNumber(data.ts),
          },
        });
      },
    );

    const unbindAgent = client.onWsEvent(
      "agent_event",
      (data: Record<string, unknown>) => {
        const source = agentEventSource(data);
        const activity =
          activityEventToPlaintext(data, { maxLength: 120 }) ??
          workbenchFallbackActivity(source);
        if (!activity) {
          return;
        }
        pushEvent({
          timestamp: source.ts ?? Date.now(),
          eventType: activity.eventType,
          sessionId: activity.sessionId ?? source.sessionKey,
          summary: activity.plaintext,
          source,
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
