import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsConnectorSide,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailTriageFeed,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/app-lifeops/contracts";
import { Badge } from "@elizaos/ui";
import { CalendarDays, Mail, Plug2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { client } from "../../../../api";
import {
  useGoogleLifeOpsConnector,
  useLifeOpsAppState,
} from "../../../../hooks";
import { WidgetSection } from "../shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "../types";

const GOOGLE_WIDGET_REFRESH_INTERVAL_MS = 15_000;
const GOOGLE_WIDGET_EVENT_LIMIT = 3;
const GOOGLE_WIDGET_MESSAGE_LIMIT = 3;

function capabilitySet(
  status: LifeOpsGoogleConnectorStatus | null,
): Set<LifeOpsGoogleCapability> {
  return new Set(status?.grantedCapabilities ?? []);
}

function modeLabel(mode: LifeOpsGoogleConnectorStatus["mode"]): string {
  switch (mode) {
    case "cloud_managed":
      return "Cloud";
    case "remote":
      return "Remote";
    default:
      return "Local";
  }
}

function readIdentityLabel(identity: Record<string, unknown> | null): {
  primary: string;
  secondary: string | null;
} {
  if (!identity) {
    return { primary: "Disconnected", secondary: null };
  }
  const name =
    typeof identity.name === "string" && identity.name.trim().length > 0
      ? identity.name.trim()
      : null;
  const email =
    typeof identity.email === "string" && identity.email.trim().length > 0
      ? identity.email.trim()
      : null;
  return {
    primary: name ?? email ?? "Google connected",
    secondary: name && email ? email : null,
  };
}

function sideLabel(side: LifeOpsConnectorSide): string {
  return side === "owner" ? "Owner" : "Agent";
}

function formatGoogleConnectorError(message: string | null): string | null {
  if (!message) {
    return null;
  }
  const normalized = message.trim().toLowerCase();
  if (
    normalized.includes("google connector needs re-authentication") ||
    normalized.includes("insufficient authentication scopes")
  ) {
    return "Reconnect Google to refresh calendar and Gmail permissions.";
  }
  return message;
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

function formatReceivedAt(value: string): string | null {
  const receivedAt = Date.parse(value);
  if (!Number.isFinite(receivedAt)) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(receivedAt));
}

function SectionHeading({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 px-0.5">
      <span className="text-muted">{icon}</span>
      <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
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
    <div className="rounded-lg border border-border/50 bg-bg/70 p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-txt">
          {event.title}
        </span>
        {timeLabel ? (
          <Badge variant="secondary" className="text-3xs">
            {timeLabel}
          </Badge>
        ) : null}
      </div>
      {event.location.trim().length > 0 ? (
        <div className="mt-1 truncate text-xs-tight text-muted">
          {event.location}
        </div>
      ) : null}
    </div>
  );
}

function GmailRow({ message }: { message: LifeOpsGmailMessageSummary }) {
  const receivedLabel = formatReceivedAt(message.receivedAt);
  return (
    <div className="rounded-lg border border-border/50 bg-bg/70 p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-txt">
          {message.subject}
        </span>
        {message.likelyReplyNeeded ? (
          <Badge variant="secondary" className="text-3xs">
            Reply
          </Badge>
        ) : null}
      </div>
      <div className="mt-1 truncate text-xs-tight text-muted">
        {message.from}
      </div>
      {message.snippet.trim().length > 0 ? (
        <div className="mt-1 line-clamp-2 text-xs-tight leading-5 text-muted">
          {message.snippet}
        </div>
      ) : null}
      {receivedLabel ? (
        <div className="mt-2 text-2xs uppercase tracking-[0.08em] text-muted/80">
          {receivedLabel}
        </div>
      ) : null}
    </div>
  );
}

function GoogleAccountCard({
  side,
  status,
}: {
  side: LifeOpsConnectorSide;
  status: LifeOpsGoogleConnectorStatus;
}) {
  const capabilities = capabilitySet(status);
  const identityLabel = readIdentityLabel(status?.identity ?? null);

  return (
    <div className="rounded-lg border border-border/50 bg-bg/70 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="text-3xs">
          {sideLabel(side)}
        </Badge>
        {status?.preferredByAgent ? (
          <Badge variant="secondary" className="text-3xs">
            Default
          </Badge>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-txt">
          {identityLabel.primary}
        </span>
        <Badge variant="secondary" className="text-3xs">
          {modeLabel(status.mode)}
        </Badge>
      </div>
      {identityLabel.secondary ? (
        <div className="mt-1 truncate text-xs-tight text-muted">
          {identityLabel.secondary}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(capabilities.has("google.calendar.read") ||
          capabilities.has("google.calendar.write")) && (
          <Badge variant="secondary" className="text-3xs">
            Calendar
          </Badge>
        )}
        {capabilities.has("google.gmail.triage") ? (
          <Badge variant="secondary" className="text-3xs">
            Gmail
          </Badge>
        ) : null}
        {status.reason === "needs_reauth" ? (
          <Badge variant="outline" className="text-3xs">
            Reauth needed
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

export function GoogleSidebarWidget(_props: ChatSidebarWidgetProps) {
  const lifeOpsApp = useLifeOpsAppState();
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
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
  const connectedConnectors = useMemo(
    () =>
      [ownerConnector, agentConnector].filter(
        (connector) => connector.status?.connected === true,
      ),
    [agentConnector, ownerConnector],
  );
  const dataConnector = useMemo(() => {
    const connectors = connectedConnectors;
    return (
      connectors.find(
        (connector) =>
          connector.status?.connected === true &&
          connector.status.preferredByAgent,
      ) ??
      connectors.find((connector) => connector.status?.connected === true) ??
      null
    );
  }, [connectedConnectors]);
  const dataStatus = dataConnector?.status ?? null;

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
                timeZone,
              })
            : Promise.resolve<LifeOpsCalendarFeed | null>(null),
          nextCapabilities.has("google.gmail.triage")
            ? client.getLifeOpsGmailTriage({
                mode: dataStatus.mode,
                side: dataStatus.side,
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
            : "Google widget feeds failed to refresh.",
        );
      }
    })();

    return () => {
      active = false;
    };
  }, [dataStatus, timeZone]);

  const capabilities = useMemo(() => capabilitySet(dataStatus), [dataStatus]);
  const showCalendar =
    dataStatus?.connected === true &&
    (capabilities.has("google.calendar.read") ||
      capabilities.has("google.calendar.write"));
  const showInbox =
    dataStatus?.connected === true && capabilities.has("google.gmail.triage");
  const calendarEvents = calendarFeed?.events ?? [];
  const gmailMessages = gmailFeed?.messages ?? [];
  const connectorError = formatGoogleConnectorError(
    ownerConnector.error ?? agentConnector.error ?? feedError ?? null,
  );

  if (lifeOpsApp.loading || !lifeOpsApp.enabled) {
    return null;
  }

  if (connectedConnectors.length === 0) {
    return null;
  }

  return (
    <WidgetSection
      title="Google"
      icon={<Plug2 className="h-4 w-4" />}
      testId="chat-widget-google"
    >
      <div className="flex flex-col gap-4">
        {connectedConnectors.map((connector) =>
          connector.status ? (
            <GoogleAccountCard
              key={connector.status.side}
              side={connector.status.side}
              status={connector.status}
            />
          ) : null,
        )}

        {showCalendar ? (
          <div className="flex flex-col gap-2">
            <SectionHeading
              icon={<CalendarDays className="h-3.5 w-3.5" />}
              title={`Calendar (${sideLabel(dataStatus?.side ?? "owner")})`}
            />
            {connectorError ? null : calendarEvents.length === 0 ? (
              <div className="px-0.5 text-xs-tight text-muted">
                No upcoming events
              </div>
            ) : (
              calendarEvents
                .slice(0, GOOGLE_WIDGET_EVENT_LIMIT)
                .map((event) => (
                  <CalendarRow
                    key={event.id}
                    event={event}
                    timeZone={timeZone}
                  />
                ))
            )}
          </div>
        ) : null}

        {showInbox ? (
          <div className="flex flex-col gap-2">
            <SectionHeading
              icon={<Mail className="h-3.5 w-3.5" />}
              title={`Inbox (${sideLabel(dataStatus?.side ?? "owner")})`}
            />
            {connectorError ? null : gmailMessages.length === 0 ? (
              <div className="px-0.5 text-xs-tight text-muted">
                No priority mail
              </div>
            ) : (
              gmailMessages
                .slice(0, GOOGLE_WIDGET_MESSAGE_LIMIT)
                .map((message) => (
                  <GmailRow key={message.id} message={message} />
                ))
            )}
          </div>
        ) : null}

        {connectorError ? (
          <div className="text-xs-tight text-danger">{connectorError}</div>
        ) : null}
      </div>
    </WidgetSection>
  );
}

export const LIFEOPS_WIDGETS: ChatSidebarWidgetDefinition[] = [
  {
    id: "lifeops.google",
    pluginId: "lifeops",
    order: 150,
    defaultEnabled: true,
    Component: GoogleSidebarWidget,
  },
];
