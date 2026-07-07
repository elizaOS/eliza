/**
 * CalendarView — the GUI data wrapper for the calendar surface.
 *
 * It owns the live calendar feed (via {@link useCalendarWeek}: the event list,
 * the day/week/month view mode, prev/today/next nav, and the loading/error
 * state), derives a presentational agenda from it, and renders the one
 * {@link CalendarSpatialView} inside a {@link SpatialSurface}.
 *
 * Selecting an event routes a chat-about-event notice through the shared
 * `setActionNotice` affordance — the same honest behavior the previous
 * CalendarSection-backed wrapper used (this view owns no event editor drawer).
 * Creating an event surfaces the same notice, pointing the user at the
 * assistant.
 */

import type { LifeOpsCalendarEvent, MeetingSession } from "@elizaos/shared";
import { client } from "@elizaos/ui/api";
import { useAppSelector } from "@elizaos/ui/state";
import { useCallback, useEffect, useMemo, useState } from "react";
// View bundles externalize @elizaos/shared and the loader does not provide it,
// so the runtime `parseMeetingUrl` value comes from a browser-safe local copy
// (the type-only import above is erased and stays on the shared contract).
import { parseMeetingUrl } from "./meeting-url";
// Side-effect import installs the calendar client methods onto the ui client
// prototype. The `/api/meetings` methods (requestMeetingBot / listMeetings) are
// the canonical `@elizaos/ui` ones, already installed via `@elizaos/ui/api`.
import "../../api/client-calendar.js";
import {
  type CalendarViewMode,
  useCalendarWeek,
} from "../../hooks/useCalendarWeek.js";
import {
  type CalendarEventRow,
  type CalendarRowMeetingState,
  type CalendarSnapshot,
  CalendarSpatialView,
} from "./CalendarSpatialView.tsx";

const ACTIVE_SESSIONS_POLL_MS = 15_000;

/** Session states that count as "the agent is (getting) in this meeting". */
const LIVE_SESSION_STATUSES: ReadonlySet<MeetingSession["status"]> = new Set([
  "requested",
  "joining",
  "awaiting_admission",
  "active",
]);

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function formatTimeOfDay(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  }).format(new Date(parsed));
}

function formatRangeLabel(start: Date, end: Date): string {
  const startLabel = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(start);
  const endLabel = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: TIME_ZONE,
  }).format(end);
  return startLabel === endLabel ? startLabel : `${startLabel} - ${endLabel}`;
}

function formatWhen(event: LifeOpsCalendarEvent): string {
  if (event.isAllDay) return "All day";
  const start = formatTimeOfDay(event.startAt);
  const end = formatTimeOfDay(event.endAt);
  return [start, end].filter(Boolean).join(" - ") || "Scheduled";
}

function detailFor(event: LifeOpsCalendarEvent): string | undefined {
  const origin =
    typeof event.calendarSummary === "string" && event.calendarSummary.trim()
      ? event.calendarSummary.trim()
      : null;
  return event.location?.trim() || origin || undefined;
}

function meetingStateFor(
  event: LifeOpsCalendarEvent,
  joiningIds: ReadonlySet<string>,
  liveEventIds: ReadonlySet<string>,
): CalendarRowMeetingState | undefined {
  if (!event.conferenceLink || !parseMeetingUrl(event.conferenceLink)) {
    return undefined;
  }
  if (liveEventIds.has(event.id)) return "live";
  if (joiningIds.has(event.id)) return "requesting";
  return "available";
}

function toRows(
  events: LifeOpsCalendarEvent[],
  selectedId: string | null,
  joiningIds: ReadonlySet<string>,
  liveEventIds: ReadonlySet<string>,
): CalendarEventRow[] {
  return events.map((event) => {
    const meeting = meetingStateFor(event, joiningIds, liveEventIds);
    return {
      id: event.id,
      title: event.title.trim() || "Untitled event",
      when: formatWhen(event),
      detail: detailFor(event),
      selected: event.id === selectedId,
      ...(meeting ? { meeting } : {}),
    };
  });
}

export function CalendarView() {
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const calendar = useCalendarWeek();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [joiningIds, setJoiningIds] = useState<ReadonlySet<string>>(new Set());
  const [liveEventIds, setLiveEventIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const refreshActiveSessions = useCallback(async () => {
    try {
      const { sessions } = await client.listMeetings({
        active: true,
      });
      const live = new Set<string>();
      for (const session of sessions) {
        if (
          session.calendarEventId &&
          LIVE_SESSION_STATUSES.has(session.status)
        ) {
          live.add(session.calendarEventId);
        }
      }
      setLiveEventIds(live);
    } catch {
      // The meetings plugin may not be loaded; the join button still works
      // and reports its own error on press.
    }
  }, []);

  useEffect(() => {
    void refreshActiveSessions();
    const timer = setInterval(
      () => void refreshActiveSessions(),
      ACTIVE_SESSIONS_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [refreshActiveSessions]);

  const sendAgentToMeeting = useCallback(
    async (event: LifeOpsCalendarEvent) => {
      const parsed = event.conferenceLink
        ? parseMeetingUrl(event.conferenceLink)
        : null;
      if (!parsed) {
        setActionNotice(
          "This event has no meeting link the agent can join.",
          "error",
          4000,
        );
        return;
      }
      setJoiningIds((current) => new Set(current).add(event.id));
      try {
        await client.requestMeetingBot({
          platform: parsed.platform,
          meetingUrl: parsed.meetingUrl,
          calendarEventId: event.id,
        });
        setActionNotice(
          `Agent is joining “${event.title.trim() || "this meeting"}”.`,
          "info",
          4000,
        );
        await refreshActiveSessions();
      } catch (cause) {
        setActionNotice(
          cause instanceof Error && cause.message.trim()
            ? cause.message.trim()
            : "Could not send the agent to this meeting.",
          "error",
          5000,
        );
      } finally {
        setJoiningIds((current) => {
          const next = new Set(current);
          next.delete(event.id);
          return next;
        });
      }
    },
    [refreshActiveSessions, setActionNotice],
  );

  const periodLabel = useMemo(
    () => formatRangeLabel(calendar.windowStart, calendar.windowEnd),
    [calendar.windowStart, calendar.windowEnd],
  );

  const events = useMemo(
    () => toRows(calendar.events, selectedId, joiningIds, liveEventIds),
    [calendar.events, selectedId, joiningIds, liveEventIds],
  );

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("join:")) {
        const id = action.slice("join:".length);
        const event = calendar.events.find((candidate) => candidate.id === id);
        if (event) void sendAgentToMeeting(event);
        return;
      }
      if (action.startsWith("select:")) {
        const id = action.slice("select:".length);
        setSelectedId(id);
        const event = calendar.events.find((candidate) => candidate.id === id);
        if (event) {
          setActionNotice(
            `Ask the assistant about “${event.title.trim() || "this event"}”.`,
            "info",
            4000,
          );
        }
        return;
      }
      if (action.startsWith("mode:")) {
        const mode = action.slice("mode:".length) as CalendarViewMode;
        if (mode === "day" || mode === "week" || mode === "month") {
          calendar.setViewMode(mode);
        }
        return;
      }
      switch (action) {
        case "prev":
          calendar.goPrevious();
          return;
        case "next":
          calendar.goNext();
          return;
        case "today":
          calendar.goToToday();
          return;
        case "new":
          setActionNotice(
            "Ask the assistant to create a calendar event.",
            "info",
            4000,
          );
          return;
      }
    },
    [calendar, sendAgentToMeeting, setActionNotice],
  );

  const snapshot: CalendarSnapshot = {
    events,
    periodLabel,
    mode: calendar.viewMode,
    loading: calendar.loading,
    error: calendar.error,
  };

  return <CalendarSpatialView snapshot={snapshot} onAction={onAction} />;
}

export default CalendarView;
