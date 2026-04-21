import { client } from "@elizaos/app-core/api";
import {
  EmptyWidgetState,
  WidgetSection,
} from "@elizaos/app-core/components/chat/widgets/shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "@elizaos/app-core/components/chat/widgets/types";
import { useApp } from "@elizaos/app-core/state";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared/contracts/lifeops";
import { Button } from "@elizaos/ui";
import { CalendarDays, SquareArrowOutUpRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useGoogleLifeOpsConnector } from "../../../../hooks/useGoogleLifeOpsConnector.js";

const CALENDAR_REFRESH_INTERVAL_MS = 15_000;
const CALENDAR_EVENT_LIMIT = 5;

function capabilitySet(
  status: LifeOpsGoogleConnectorStatus | null,
): Set<LifeOpsGoogleCapability> {
  return new Set(status?.grantedCapabilities ?? []);
}

/**
 * Returns a compact time label for a calendar event:
 * - Today: HH:MM (e.g. "2:30 PM")
 * - This week: weekday (e.g. "Wed")
 * - Later: date (e.g. "May 12")
 */
function formatCompactEventTime(
  startAt: string,
  timeZone: string,
): string | null {
  const parsed = Date.parse(startAt);
  if (!Number.isFinite(parsed)) return null;

  const eventDate = new Date(parsed);
  const now = new Date();

  const isSameDay = eventDate.toDateString() === now.toDateString();
  const endOfWeek = new Date(now);
  endOfWeek.setDate(now.getDate() + 7);

  try {
    if (isSameDay) {
      return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      }).format(eventDate);
    }
    if (eventDate < endOfWeek) {
      return new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        timeZone,
      }).format(eventDate);
    }
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      timeZone,
    }).format(eventDate);
  } catch {
    return null;
  }
}

function CalendarEventRow({
  event,
  timeZone,
  onClick,
}: {
  event: LifeOpsCalendarEvent;
  timeZone: string;
  onClick: () => void;
}) {
  const timeLabel = formatCompactEventTime(event.startAt, timeZone);

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-0.5 py-0.5 text-left hover:bg-bg-accent/30"
    >
      <span className="min-w-0 flex-1 truncate text-2xs text-txt">
        {event.title}
      </span>
      {timeLabel ? (
        <span className="shrink-0 text-3xs text-muted tabular-nums">
          {timeLabel}
        </span>
      ) : null}
    </button>
  );
}

export function LifeOpsCalendarWidget(_props: ChatSidebarWidgetProps) {
  const { setTab, t } = useApp();
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );

  const ownerConnector = useGoogleLifeOpsConnector({
    pollWhileDisconnected: false,
    side: "owner",
    pollIntervalMs: CALENDAR_REFRESH_INTERVAL_MS,
  });
  const agentConnector = useGoogleLifeOpsConnector({
    pollWhileDisconnected: false,
    side: "agent",
    pollIntervalMs: CALENDAR_REFRESH_INTERVAL_MS,
  });

  const dataStatus = useMemo(() => {
    const candidates = [ownerConnector.status, agentConnector.status].filter(
      (s): s is LifeOpsGoogleConnectorStatus => s?.connected === true,
    );
    return candidates.find((s) => s.preferredByAgent) ?? candidates[0] ?? null;
  }, [ownerConnector.status, agentConnector.status]);

  const [feed, setFeed] = useState<LifeOpsCalendarFeed | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!dataStatus?.connected) {
        setFeed(null);
        setFeedError(null);
        return;
      }
      const capabilities = capabilitySet(dataStatus);
      if (
        !capabilities.has("google.calendar.read") &&
        !capabilities.has("google.calendar.write")
      ) {
        setFeed(null);
        return;
      }
      try {
        const result = await client.getLifeOpsCalendarFeed({
          mode: dataStatus.mode,
          side: dataStatus.side,
          timeZone,
        });
        if (!active) return;
        setFeed(result);
        setFeedError(null);
      } catch (cause) {
        if (!active) return;
        setFeedError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : t("lifeopsoverview.googleFeedsFailed", {
                defaultValue: "Google widget feeds failed to refresh.",
              }),
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [dataStatus, t, timeZone]);

  const capabilities = useMemo(() => capabilitySet(dataStatus), [dataStatus]);
  const hasCalendar =
    dataStatus?.connected === true &&
    (capabilities.has("google.calendar.read") ||
      capabilities.has("google.calendar.write"));

  if (!hasCalendar) return null;

  const events = (feed?.events ?? []).slice(0, CALENDAR_EVENT_LIMIT);

  return (
    <WidgetSection
      title={t("lifeopswidget.calendar.title", { defaultValue: "LifeOps" })}
      icon={<CalendarDays className="h-4 w-4" />}
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            window.location.hash = "#lifeops/calendar";
            setTab("lifeops");
          }}
          aria-label={t("lifeopswidget.openView", {
            defaultValue: "Open LifeOps view",
          })}
          className="h-6 w-6 p-0"
        >
          <SquareArrowOutUpRight className="h-3.5 w-3.5" />
        </Button>
      }
      testId="chat-widget-lifeops-calendar"
    >
      {feedError ? (
        <div className="px-0.5 text-3xs text-danger">{feedError}</div>
      ) : events.length === 0 ? (
        <EmptyWidgetState
          icon={<CalendarDays className="h-8 w-8" />}
          title={t("lifeopsoverview.noUpcomingEvents", {
            defaultValue: "No upcoming events",
          })}
        />
      ) : (
        <div className="flex flex-col">
          {events.map((event) => (
            <CalendarEventRow
              key={event.id}
              event={event}
              timeZone={timeZone}
              onClick={() => {
                window.location.hash = `#lifeops/calendar/${event.id}`;
                setTab("lifeops");
              }}
            />
          ))}
        </div>
      )}
    </WidgetSection>
  );
}

export const LIFEOPS_CALENDAR_WIDGET: ChatSidebarWidgetDefinition = {
  id: "lifeops.calendar",
  pluginId: "lifeops",
  order: 84,
  defaultEnabled: true,
  Component: LifeOpsCalendarWidget,
};
