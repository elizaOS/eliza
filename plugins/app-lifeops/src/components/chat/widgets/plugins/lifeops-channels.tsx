import {
  type ChatSidebarWidgetDefinition,
  type ChatSidebarWidgetProps,
  client,
  type TriggerSummary,
  useApp,
  WidgetSection,
} from "@elizaos/app-core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailTriageFeed,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared";
import { CalendarDays, Clock, Mail } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useGoogleLifeOpsConnector } from "../../../../hooks/useGoogleLifeOpsConnector.js";
import {
  buildAutomationsHash,
  buildLifeOpsHash,
  primeAutomationsTrigger,
  primeLifeOpsEvent,
  primeLifeOpsMessage,
} from "../../../../lifeops-route.js";

function writeHash(nextHash: string): void {
  if (typeof window === "undefined") return;
  try {
    const url = `${window.location.pathname}${window.location.search}${nextHash}`;
    window.history.replaceState(null, "", url || window.location.href);
    // Fire hashchange manually so our own listeners pick it up; browsers
    // don't emit it for history.replaceState calls.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } catch {
    // Best-effort — URL manipulation failures shouldn't break the click.
  }
}

const REFRESH_INTERVAL_MS = 15_000;
const CALENDAR_ROW_LIMIT = 6;
const INBOX_ROW_LIMIT = 5;
const AUTOMATIONS_ROW_LIMIT = 5;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function capabilitySet(
  status: LifeOpsGoogleConnectorStatus | null,
): Set<LifeOpsGoogleCapability> {
  return new Set(status?.grantedCapabilities ?? []);
}

function useGoogleData(timeZone: string) {
  const ownerConnector = useGoogleLifeOpsConnector({
    pollWhileDisconnected: false,
    side: "owner",
    pollIntervalMs: REFRESH_INTERVAL_MS,
  });
  const agentConnector = useGoogleLifeOpsConnector({
    pollWhileDisconnected: false,
    side: "agent",
    pollIntervalMs: REFRESH_INTERVAL_MS,
  });
  const [calendarFeed, setCalendarFeed] = useState<LifeOpsCalendarFeed | null>(
    null,
  );
  const [gmailFeed, setGmailFeed] = useState<LifeOpsGmailTriageFeed | null>(
    null,
  );

  const dataStatus = useMemo(() => {
    const candidates = [ownerConnector.status, agentConnector.status].filter(
      (candidate): candidate is LifeOpsGoogleConnectorStatus =>
        candidate?.connected === true,
    );
    return (
      candidates.find((status) => status.preferredByAgent) ??
      candidates[0] ??
      null
    );
  }, [ownerConnector.status, agentConnector.status]);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!dataStatus?.connected) {
        setCalendarFeed(null);
        setGmailFeed(null);
        return;
      }
      try {
        const caps = capabilitySet(dataStatus);
        const [calendar, gmail] = await Promise.all([
          caps.has("google.calendar.read") || caps.has("google.calendar.write")
            ? client.getLifeOpsCalendarFeed({
                mode: dataStatus.mode,
                side: dataStatus.side,
                grantId: dataStatus.grant?.id,
                timeZone,
              })
            : Promise.resolve<LifeOpsCalendarFeed | null>(null),
          caps.has("google.gmail.triage")
            ? client.getLifeOpsGmailTriage({
                mode: dataStatus.mode,
                side: dataStatus.side,
                grantId: dataStatus.grant?.id,
                maxResults: INBOX_ROW_LIMIT,
              })
            : Promise.resolve<LifeOpsGmailTriageFeed | null>(null),
        ]);
        if (!active) return;
        setCalendarFeed(calendar);
        setGmailFeed(gmail);
      } catch {
        // Keep the last snapshot on transient failures.
      }
    })();
    return () => {
      active = false;
    };
  }, [dataStatus, timeZone]);

  return { dataStatus, calendarFeed, gmailFeed };
}

function formatShortTime(iso: string, timeZone: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  }
}

/**
 * Filters calendar events down to today, tomorrow, and the rest of the
 * current week (anything starting within the next 7 days).
 */
function pickThisWeekEvents(
  events: readonly LifeOpsCalendarEvent[],
): LifeOpsCalendarEvent[] {
  const now = Date.now();
  const horizon = now + SEVEN_DAYS_MS;
  return events
    .map((event) => ({ event, start: Date.parse(event.startAt) }))
    .filter(
      ({ start }) =>
        Number.isFinite(start) && start >= now - 60_000 && start <= horizon,
    )
    .sort((a, b) => a.start - b.start)
    .map(({ event }) => event);
}

function LifeOpsCalendarWidget(_props: ChatSidebarWidgetProps) {
  const { t, setTab } = useApp();
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
  const { dataStatus, calendarFeed } = useGoogleData(timeZone);
  const caps = capabilitySet(dataStatus);
  const showCalendar =
    dataStatus?.connected === true &&
    (caps.has("google.calendar.read") || caps.has("google.calendar.write"));

  const events = useMemo(
    () => pickThisWeekEvents(calendarFeed?.events ?? []),
    [calendarFeed?.events],
  );

  if (!showCalendar) return null;
  // Hide the widget entirely when there is nothing to show — the right rail
  // stays quiet. The user can still open /lifeops to diagnose why.
  if (events.length === 0) return null;

  const openLifeOps = () => {
    const hash = buildLifeOpsHash(
      typeof window === "undefined" ? "" : window.location.hash,
      { section: "calendar", eventId: null, messageId: null },
    );
    setTab("lifeops");
    writeHash(hash);
  };

  const openEventRow = (event: LifeOpsCalendarEvent) => {
    primeLifeOpsEvent(event);
    const hash = buildLifeOpsHash(
      typeof window === "undefined" ? "" : window.location.hash,
      { section: "calendar", eventId: event.id, messageId: null },
    );
    setTab("lifeops");
    writeHash(hash);
  };

  return (
    <WidgetSection
      title={t("lifeopschannels.calendar.title", { defaultValue: "Calendar" })}
      icon={<CalendarDays className="h-4 w-4" />}
      testId="chat-widget-lifeops-calendar"
      onTitleClick={openLifeOps}
    >
      {events.length === 0 ? (
        <div className="px-0.5 py-1 text-2xs text-muted">
          {t("lifeopschannels.calendar.empty", {
            defaultValue: "Nothing this week",
          })}
        </div>
      ) : (
        <div className="flex flex-col">
          {events.slice(0, CALENDAR_ROW_LIMIT).map((event) => {
            const when = formatShortTime(event.startAt, timeZone);
            return (
              <button
                key={event.id}
                type="button"
                onClick={() => openEventRow(event)}
                data-testid={`lifeops-calendar-row-${event.id}`}
                className="flex items-start gap-2 rounded-[var(--radius-sm)] px-0.5 py-0.5 text-left text-3xs transition-colors hover:bg-bg-hover/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-txt">{event.title}</span>
                  {event.calendarSummary ? (
                    <span className="block truncate text-[10px] text-muted">
                      {event.calendarSummary}
                    </span>
                  ) : null}
                </span>
                {when ? (
                  <span className="shrink-0 text-3xs text-muted">{when}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </WidgetSection>
  );
}

function LifeOpsInboxWidget(_props: ChatSidebarWidgetProps) {
  const { t, setTab } = useApp();
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
  const { dataStatus, gmailFeed } = useGoogleData(timeZone);
  const caps = capabilitySet(dataStatus);
  const showInbox =
    dataStatus?.connected === true && caps.has("google.gmail.triage");

  const messages = gmailFeed?.messages ?? [];
  if (!showInbox) return null;

  const openLifeOps = () => {
    const hash = buildLifeOpsHash(
      typeof window === "undefined" ? "" : window.location.hash,
      { section: "mail", eventId: null, messageId: null },
    );
    setTab("lifeops");
    writeHash(hash);
  };

  const openMessageRow = (message: LifeOpsGmailMessageSummary) => {
    primeLifeOpsMessage(message);
    const hash = buildLifeOpsHash(
      typeof window === "undefined" ? "" : window.location.hash,
      { section: "mail", eventId: null, messageId: message.id },
    );
    setTab("lifeops");
    writeHash(hash);
  };

  return (
    <WidgetSection
      title={t("lifeopschannels.inbox.title", { defaultValue: "Inbox" })}
      icon={<Mail className="h-4 w-4" />}
      testId="chat-widget-lifeops-inbox"
      onTitleClick={openLifeOps}
    >
      {messages.length === 0 ? (
        <div className="px-0.5 py-1 text-2xs text-muted">
          {t("lifeopschannels.inbox.empty", {
            defaultValue: "No priority mail",
          })}
        </div>
      ) : (
        <div className="flex flex-col">
          {messages.slice(0, INBOX_ROW_LIMIT).map((message) => (
            <button
              key={message.id}
              type="button"
              onClick={() => openMessageRow(message)}
              data-testid={`lifeops-inbox-row-${message.id}`}
              className="flex items-center gap-2 rounded-[var(--radius-sm)] px-0.5 py-0.5 text-left text-3xs transition-colors hover:bg-bg-hover/40"
            >
              <span className="min-w-0 flex-1 truncate text-txt">
                {message.subject}
              </span>
            </button>
          ))}
        </div>
      )}
    </WidgetSection>
  );
}

function formatAutomationNextRun(
  nextRunAtMs: number | undefined,
  timeZone: string,
): string | null {
  if (!nextRunAtMs || !Number.isFinite(nextRunAtMs)) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(new Date(nextRunAtMs));
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(nextRunAtMs));
  }
}

function LifeOpsAutomationsWidget(_props: ChatSidebarWidgetProps) {
  const { t, setTab } = useApp();
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await client.getTriggers();
        if (cancelled) return;
        setTriggers(response.triggers ?? []);
      } catch {
        // Transient errors preserve the last snapshot; next tick retries.
      }
    };
    void load();
    const timer = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const upcoming = useMemo(() => {
    // Show every enabled trigger. Triggers without a computed next-run
    // timestamp (manual / event-driven) sort last but still surface so the
    // widget reflects what actually exists in the system rather than only
    // what's about to fire.
    return triggers
      .filter((trigger) => trigger.enabled !== false)
      .sort((a, b) => {
        const aNext =
          typeof a.nextRunAtMs === "number" && Number.isFinite(a.nextRunAtMs)
            ? a.nextRunAtMs
            : Number.POSITIVE_INFINITY;
        const bNext =
          typeof b.nextRunAtMs === "number" && Number.isFinite(b.nextRunAtMs)
            ? b.nextRunAtMs
            : Number.POSITIVE_INFINITY;
        return aNext - bNext;
      })
      .slice(0, AUTOMATIONS_ROW_LIMIT);
  }, [triggers]);

  const openAutomationsPage = useCallback(() => {
    const hash = buildAutomationsHash(
      typeof window === "undefined" ? "" : window.location.hash,
      { triggerId: null },
    );
    setTab("automations");
    writeHash(hash);
  }, [setTab]);

  const openTriggerRow = useCallback(
    (trigger: TriggerSummary) => {
      primeAutomationsTrigger(trigger);
      const hash = buildAutomationsHash(
        typeof window === "undefined" ? "" : window.location.hash,
        { triggerId: trigger.id },
      );
      setTab("automations");
      writeHash(hash);
    },
    [setTab],
  );

  // Hide the widget entirely when there are no upcoming automations — the
  // right rail stays quiet. While the initial load is in flight we still
  // render nothing (returning `null`) to avoid a flash of empty chrome.
  if (upcoming.length === 0) return null;

  return (
    <WidgetSection
      title={t("lifeopschannels.automations.title", {
        defaultValue: "Automations",
      })}
      icon={<Clock className="h-4 w-4" />}
      testId="chat-widget-lifeops-automations"
      onTitleClick={openAutomationsPage}
    >
      <div className="flex flex-col">
        {upcoming.map((trigger) => {
          const when = formatAutomationNextRun(trigger.nextRunAtMs, timeZone);
          return (
            <button
              key={trigger.id}
              type="button"
              onClick={() => openTriggerRow(trigger)}
              data-testid={`lifeops-automation-row-${trigger.id}`}
              className="flex items-center gap-2 rounded-[var(--radius-sm)] px-0.5 py-0.5 text-left text-3xs transition-colors hover:bg-bg-hover/40"
            >
              <span className="min-w-0 flex-1 truncate text-txt">
                {trigger.displayName || trigger.id}
              </span>
              <span className="shrink-0 text-3xs text-muted">
                {when ??
                  t("lifeopschannels.automations.awaitingCircadian", {
                    defaultValue: "waiting on wake/sleep signal",
                  })}
              </span>
            </button>
          );
        })}
      </div>
    </WidgetSection>
  );
}

export const LIFEOPS_CHANNEL_WIDGETS: ChatSidebarWidgetDefinition[] = [
  {
    id: "lifeops.calendar",
    pluginId: "lifeops",
    order: 85,
    defaultEnabled: true,
    Component: LifeOpsCalendarWidget,
  },
  {
    id: "lifeops.inbox",
    pluginId: "lifeops",
    order: 86,
    defaultEnabled: true,
    Component: LifeOpsInboxWidget,
  },
  {
    id: "lifeops.automations",
    pluginId: "lifeops",
    order: 87,
    defaultEnabled: true,
    Component: LifeOpsAutomationsWidget,
  },
];
