/**
 * Hook that subscribes to WebSocket activity events and maintains a ring buffer
 * of recent entries for the chat widget rail.
 */

import { activityEventToPlaintext } from "@elizaos/core";
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
          timestamp: Date.now(),
          eventType: activity.eventType,
          sessionId: activity.sessionId,
          summary: activity.plaintext,
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
          timestamp: Date.now(),
          eventType: activity?.eventType ?? "proactive-message",
          summary: activity?.plaintext ?? summary,
        });
      },
    );

    const unbindAgent = client.onWsEvent(
      "agent_event",
      (data: Record<string, unknown>) => {
        const activity = activityEventToPlaintext(data, { maxLength: 120 });
        if (!activity) {
          return;
        }
        pushEvent({
          timestamp: Date.now(),
          eventType: activity.eventType,
          summary: activity.plaintext,
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
