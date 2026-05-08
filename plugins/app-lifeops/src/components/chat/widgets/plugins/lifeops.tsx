import { client, useApp } from "@elizaos/app-core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailTriageFeed,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared";
import { CalendarDays, Mail } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useGoogleLifeOpsConnector } from "../../../../hooks/useGoogleLifeOpsConnector.js";

const GOOGLE_WIDGET_REFRESH_INTERVAL_MS = 15_000;
const GOOGLE_WIDGET_EVENT_LIMIT = 3;
const GOOGLE_WIDGET_MESSAGE_LIMIT = 3;

function capabilitySet(
  status: LifeOpsGoogleConnectorStatus | null,
): Set<LifeOpsGoogleCapability> {
  return new Set(status?.grantedCapabilities ?? []);
}

function formatEventTime(
  event: LifeOpsCalendarEvent,
  timeZone: string,
): string | null {
  const start = Date.parse(event.startAt);
  if (!Number.isFinite(start)) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(new Date(start));
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(start));
  }
}

export function GlanceHeading({
  icon,
  title,
}: {
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-0.5">
      <span className="text-muted">{icon}</span>
      <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
        {title}
      </span>
    </div>
  );
}

function CalendarRow({
  event,
  timeZone,
}: {
  event: LifeOpsCalendarEvent;
  timeZone: string;
}) {
  const timeLabel = formatEventTime(event, timeZone);
  return (
    <div className="flex items-center gap-2 px-0.5 py-0.5">
      <span className="min-w-0 flex-1 truncate text-2xs text-txt">
        {event.title}
      </span>
      {timeLabel ? (
        <span className="shrink-0 text-3xs text-muted">{timeLabel}</span>
      ) : null}
    </div>
  );
}

function GmailRow({
  message,
  replyNeededLabel,
}: {
  message: LifeOpsGmailMessageSummary;
  replyNeededLabel: string;
}) {
  return (
    <div className="flex items-center gap-2 px-0.5 py-0.5">
      <span className="min-w-0 flex-1 truncate text-2xs text-txt">
        {message.subject}
      </span>
      {message.likelyReplyNeeded ? (
        <span className="shrink-0 text-3xs uppercase tracking-wider text-accent">
          {replyNeededLabel}
        </span>
      ) : null}
    </div>
  );
}

export function GoogleGlanceSection({ timeZone }: { timeZone: string }) {
  const { t } = useApp();
  const ownerConnector = useGoogleLifeOpsConnector({
    pollWhileDisconnected: false,
    side: "owner",
    pollIntervalMs: GOOGLE_WIDGET_REFRESH_INTERVAL_MS,
  });
  const agentConnector = useGoogleLifeOpsConnector({
    pollWhileDisconnected: false,
    side: "agent",
    pollIntervalMs: GOOGLE_WIDGET_REFRESH_INTERVAL_MS,
  });
  const [calendarFeed, setCalendarFeed] = useState<LifeOpsCalendarFeed | null>(
    null,
  );
  const [gmailFeed, setGmailFeed] = useState<LifeOpsGmailTriageFeed | null>(
    null,
  );
  const [feedError, setFeedError] = useState<string | null>(null);

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
        setFeedError(null);
        return;
      }

      try {
        const nextCapabilities = capabilitySet(dataStatus);
        const [calendarResult, gmailResult] = await Promise.all([
          nextCapabilities.has("google.calendar.read") ||
          nextCapabilities.has("google.calendar.write")
            ? client.getLifeOpsCalendarFeed({
                mode: dataStatus.mode,
                side: dataStatus.side,
                grantId: dataStatus.grant?.id,
                timeZone,
              })
            : Promise.resolve<LifeOpsCalendarFeed | null>(null),
          nextCapabilities.has("google.gmail.triage")
            ? client.getLifeOpsGmailTriage({
                mode: dataStatus.mode,
                side: dataStatus.side,
                grantId: dataStatus.grant?.id,
                maxResults: GOOGLE_WIDGET_MESSAGE_LIMIT,
              })
            : Promise.resolve<LifeOpsGmailTriageFeed | null>(null),
        ]);
        if (!active) {
          return;
        }
        setCalendarFeed(calendarResult);
        setGmailFeed(gmailResult);
        setFeedError(null);
      } catch (cause) {
        if (!active) {
          return;
        }
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
  const showCalendar =
    dataStatus?.connected === true &&
    (capabilities.has("google.calendar.read") ||
      capabilities.has("google.calendar.write"));
  const showInbox =
    dataStatus?.connected === true && capabilities.has("google.gmail.triage");
  const calendarEvents = calendarFeed?.events ?? [];
  const gmailMessages = gmailFeed?.messages ?? [];
  const connectorError = useMemo(() => {
    const message =
      ownerConnector.error ?? agentConnector.error ?? feedError ?? null;
    if (!message) {
      return null;
    }
    const normalized = message.trim().toLowerCase();
    if (
      normalized.includes("google connector needs re-authentication") ||
      normalized.includes("insufficient authentication scopes")
    ) {
      return t("lifeopsoverview.reconnectGoogle", {
        defaultValue:
          "Reconnect Google to refresh calendar and Gmail permissions.",
      });
    }
    return message;
  }, [agentConnector.error, feedError, ownerConnector.error, t]);

  if (!dataStatus?.connected) {
    return null;
  }

  return (
    <>
      {showCalendar ? (
        <div className="flex flex-col gap-1">
          <GlanceHeading
            icon={<CalendarDays className="h-3 w-3" />}
            title={t("lifeopsoverview.calendar", {
              defaultValue: "Calendar",
            })}
          />
          {connectorError ? null : calendarEvents.length === 0 ? (
            <div className="px-0.5 text-3xs text-muted">
              {t("lifeopsoverview.noUpcomingEvents", {
                defaultValue: "No upcoming events",
              })}
            </div>
          ) : (
            calendarEvents
              .slice(0, GOOGLE_WIDGET_EVENT_LIMIT)
              .map((event) => (
                <CalendarRow key={event.id} event={event} timeZone={timeZone} />
              ))
          )}
        </div>
      ) : null}

      {showInbox ? (
        <div className="flex flex-col gap-1">
          <GlanceHeading
            icon={<Mail className="h-3 w-3" />}
            title={t("lifeopsoverview.inbox", {
              defaultValue: "Inbox",
            })}
          />
          {connectorError ? null : gmailMessages.length === 0 ? (
            <div className="px-0.5 text-3xs text-muted">
              {t("lifeopsoverview.noPriorityMail", {
                defaultValue: "No priority mail",
              })}
            </div>
          ) : (
            gmailMessages
              .slice(0, GOOGLE_WIDGET_MESSAGE_LIMIT)
              .map((message) => (
                <GmailRow
                  key={message.id}
                  message={message}
                  replyNeededLabel={t("lifeopsoverview.replyNeeded", {
                    defaultValue: "Reply",
                  })}
                />
              ))
          )}
        </div>
      ) : null}

      {connectorError ? (
        <div className="px-0.5 text-3xs text-danger">{connectorError}</div>
      ) : null}
    </>
  );
}
