import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGmailDraftTone,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailReplyDraft,
  LifeOpsGmailTriageFeed,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
  LifeOpsNextCalendarEventContext,
} from "@elizaos/shared/contracts/lifeops";
import {
  Badge,
  Button,
  Input,
  PagePanel,
  SegmentedControl,
  Textarea,
} from "@elizaos/app-core";
import { RefreshCw, Settings2 } from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { client } from "@elizaos/app-core";
import { useGoogleLifeOpsConnector } from "@elizaos/app-core";
import { useApp } from "@elizaos/app-core";

type WorkspacePane = "agenda" | "week" | "email";

const CONNECTOR_REFRESH_INTERVAL_MS = 30_000;
const GMAIL_MESSAGE_LIMIT = 20;
const AGENDA_WINDOW_DAYS = 1;
const WEEK_WINDOW_DAYS = 7;

function capabilitySet(
  status: LifeOpsGoogleConnectorStatus | null,
): Set<LifeOpsGoogleCapability> {
  return new Set(status?.grantedCapabilities ?? []);
}

function modeLabel(mode: LifeOpsConnectorMode): string {
  switch (mode) {
    case "cloud_managed":
      return "Cloud";
    case "remote":
      return "Remote";
    default:
      return "Local";
  }
}

function sideLabel(side: LifeOpsConnectorSide): string {
  return side === "owner" ? "Owner" : "Agent";
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

function toLocalDateKey(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date = new Date()): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function combineDateTime(dateValue: string, timeValue: string): string | null {
  if (!dateValue || !timeValue) {
    return null;
  }
  const parsed = new Date(`${dateValue}T${timeValue}`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function formatLocalDateTime(value: string | null, timeZone: string): string {
  if (!value) {
    return "—";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(parsed));
}

function formatLocalDate(value: string, timeZone: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(parsed));
}

function formatTimeOfDay(value: string, timeZone: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(parsed));
}

function groupEventsByDay(
  events: LifeOpsCalendarEvent[],
  timeZone: string,
): Array<{ dayKey: string; label: string; events: LifeOpsCalendarEvent[] }> {
  const grouped = new Map<
    string,
    { label: string; events: LifeOpsCalendarEvent[] }
  >();
  for (const event of [...events].sort((left, right) =>
    left.startAt.localeCompare(right.startAt),
  )) {
    const key = toLocalDateKey(new Date(event.startAt), timeZone);
    const current = grouped.get(key);
    if (current) {
      current.events.push(event);
      continue;
    }
    grouped.set(key, {
      label: formatLocalDate(event.startAt, timeZone),
      events: [event],
    });
  }
  return [...grouped.entries()].map(([dayKey, value]) => ({
    dayKey,
    label: value.label,
    events: value.events,
  }));
}

function formatEventWindow(
  event: LifeOpsCalendarEvent,
  timeZone: string,
): string {
  if (event.isAllDay) {
    return "All day";
  }
  return `${formatTimeOfDay(event.startAt, timeZone)} - ${formatTimeOfDay(event.endAt, timeZone)}`;
}

function filterMessages(
  messages: LifeOpsGmailMessageSummary[],
  query: string,
  replyNeededOnly: boolean,
): LifeOpsGmailMessageSummary[] {
  const normalized = query.trim().toLowerCase();
  return messages.filter((message) => {
    if (replyNeededOnly && !message.likelyReplyNeeded) {
      return false;
    }
    if (!normalized) {
      return true;
    }
    return [message.subject, message.from, message.snippet]
      .join(" ")
      .toLowerCase()
      .includes(normalized);
  });
}

function sortMessages(
  messages: LifeOpsGmailMessageSummary[],
): LifeOpsGmailMessageSummary[] {
  return [...messages].sort((left, right) => {
    if (left.likelyReplyNeeded !== right.likelyReplyNeeded) {
      return left.likelyReplyNeeded ? -1 : 1;
    }
    return right.receivedAt.localeCompare(left.receivedAt);
  });
}

function CalendarEventCard({
  event,
  selected,
  onSelect,
  timeZone,
}: {
  event: LifeOpsCalendarEvent;
  selected: boolean;
  onSelect: (eventId: string) => void;
  timeZone: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(event.id)}
      className={`w-full rounded-2xl border px-4 py-3 text-left transition-colors ${
        selected
          ? "border-accent/30 bg-accent/10"
          : "border-border/40 bg-card/72 hover:border-accent/20 hover:bg-bg-hover/70"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-txt">
            {event.title}
          </div>
          <div className="mt-1 text-xs-tight text-muted">
            {formatEventWindow(event, timeZone)}
          </div>
        </div>
        <Badge variant="secondary" className="text-3xs">
          {event.status}
        </Badge>
      </div>
      {event.location.trim().length > 0 ? (
        <div className="mt-2 truncate text-xs-tight text-muted">
          {event.location}
        </div>
      ) : null}
    </button>
  );
}

function GmailMessageCard({
  message,
  selected,
  onSelect,
  timeZone,
}: {
  message: LifeOpsGmailMessageSummary;
  selected: boolean;
  onSelect: (messageId: string) => void;
  timeZone: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(message.id)}
      className={`w-full rounded-2xl border px-4 py-3 text-left transition-colors ${
        selected
          ? "border-accent/30 bg-accent/10"
          : "border-border/40 bg-card/72 hover:border-accent/20 hover:bg-bg-hover/70"
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-txt">
          {message.subject}
        </div>
        {message.likelyReplyNeeded ? (
          <Badge variant="secondary" className="text-3xs">
            Reply needed
          </Badge>
        ) : null}
      </div>
      <div className="mt-1 truncate text-xs-tight text-muted">
        {message.from}
      </div>
      <div className="mt-2 line-clamp-2 text-xs-tight leading-5 text-muted">
        {message.snippet}
      </div>
      <div className="mt-2 text-2xs uppercase tracking-[0.08em] text-muted/80">
        {formatLocalDateTime(message.receivedAt, timeZone)}
      </div>
    </button>
  );
}

function DetailBlock({
  title,
  children,
}: ComponentPropsWithoutRef<"div"> & { title: string }) {
  return (
    <div className="rounded-2xl border border-border/40 bg-bg/72 p-4">
      <div className="text-xs-tight font-semibold uppercase tracking-[0.12em] text-muted">
        {title}
      </div>
      <div className="mt-2 space-y-2 text-xs leading-6 text-muted-strong">
        {children}
      </div>
    </div>
  );
}

export function LifeOpsWorkspaceView() {
  const { setActionNotice, setState } = useApp();
  const ownerConnector = useGoogleLifeOpsConnector({
    pollWhileDisconnected: false,
    side: "owner",
    pollIntervalMs: CONNECTOR_REFRESH_INTERVAL_MS,
  });
  const agentConnector = useGoogleLifeOpsConnector({
    pollWhileDisconnected: false,
    side: "agent",
    pollIntervalMs: CONNECTOR_REFRESH_INTERVAL_MS,
  });

  const connectedConnectors = useMemo(
    () =>
      [ownerConnector, agentConnector].filter(
        (connector) => connector.status?.connected === true,
      ),
    [agentConnector, ownerConnector],
  );
  const dataConnector = useMemo(() => {
    return (
      connectedConnectors.find(
        (connector) => connector.status?.preferredByAgent === true,
      ) ??
      connectedConnectors[0] ??
      null
    );
  }, [connectedConnectors]);
  const dataStatus = dataConnector?.status ?? null;
  const dataCapabilities = useMemo(
    () => capabilitySet(dataStatus),
    [dataStatus],
  );
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
  const [pane, setPane] = useState<WorkspacePane>("agenda");
  const [calendarFeed, setCalendarFeed] = useState<LifeOpsCalendarFeed | null>(
    null,
  );
  const [gmailFeed, setGmailFeed] = useState<LifeOpsGmailTriageFeed | null>(
    null,
  );
  const [calendarContext, setCalendarContext] =
    useState<LifeOpsNextCalendarEventContext | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string | null>(
    null,
  );
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    null,
  );
  const [mailSearch, setMailSearch] = useState("");
  const [replyNeededOnly, setReplyNeededOnly] = useState(true);
  const [draftTone, setDraftTone] = useState<LifeOpsGmailDraftTone>("neutral");
  const [draftIntent, setDraftIntent] = useState(
    "Draft a concise follow-up that moves the thread forward.",
  );
  const [draftIncludeQuotedOriginal, setDraftIncludeQuotedOriginal] =
    useState(true);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState<LifeOpsGmailReplyDraft | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [eventTime, setEventTime] = useState("09:00");
  const [eventDurationMinutes, setEventDurationMinutes] = useState("30");
  const [eventLocation, setEventLocation] = useState("");
  const [eventDescription, setEventDescription] = useState("");
  const [creatingEvent, setCreatingEvent] = useState(false);

  const calendarRange = useMemo(() => {
    const start = startOfLocalDay();
    const days = pane === "week" ? WEEK_WINDOW_DAYS : AGENDA_WINDOW_DAYS;
    return {
      timeMin: start.toISOString(),
      timeMax: addDays(start, days).toISOString(),
    };
  }, [pane]);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      ownerConnector.refresh({ silent: true }),
      agentConnector.refresh({ silent: true }),
    ]);
  }, [agentConnector, ownerConnector]);

  const loadWorkspace = useCallback(async () => {
    if (!dataStatus?.connected) {
      setLoading(false);
      setWorkspaceError(null);
      setCalendarFeed(null);
      setGmailFeed(null);
      setCalendarContext(null);
      return;
    }

    setLoading(true);
    setWorkspaceError(null);

    try {
      const [nextCalendarFeed, nextGmailFeed] = await Promise.all([
        dataCapabilities.has("google.calendar.read") ||
        dataCapabilities.has("google.calendar.write")
          ? client.getLifeOpsCalendarFeed({
              mode: dataStatus.mode,
              side: dataStatus.side,
              timeMin: calendarRange.timeMin,
              timeMax: calendarRange.timeMax,
              timeZone,
            })
          : Promise.resolve<LifeOpsCalendarFeed | null>(null),
        dataCapabilities.has("google.gmail.triage")
          ? client.getLifeOpsGmailTriage({
              mode: dataStatus.mode,
              side: dataStatus.side,
              maxResults: GMAIL_MESSAGE_LIMIT,
            })
          : Promise.resolve<LifeOpsGmailTriageFeed | null>(null),
      ]);
      setCalendarFeed(nextCalendarFeed);
      setGmailFeed(nextGmailFeed);
    } catch (cause) {
      setWorkspaceError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "LifeOps workspace failed to load.",
      );
    } finally {
      setLoading(false);
    }
  }, [calendarRange, dataCapabilities, dataStatus, timeZone]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const calendarEvents = useMemo(
    () => calendarFeed?.events ?? [],
    [calendarFeed],
  );
  const groupedCalendarEvents = useMemo(
    () => groupEventsByDay(calendarEvents, timeZone),
    [calendarEvents, timeZone],
  );
  const selectedCalendarEvent = useMemo(
    () =>
      calendarEvents.find((event) => event.id === selectedCalendarId) ??
      calendarEvents[0] ??
      null,
    [calendarEvents, selectedCalendarId],
  );
  const gmailMessages = useMemo(
    () => sortMessages(gmailFeed?.messages ?? []),
    [gmailFeed],
  );
  const filteredGmailMessages = useMemo(
    () => filterMessages(gmailMessages, mailSearch, replyNeededOnly),
    [gmailMessages, mailSearch, replyNeededOnly],
  );
  const selectedGmailMessage = useMemo(
    () =>
      filteredGmailMessages.find(
        (message) => message.id === selectedMessageId,
      ) ??
      filteredGmailMessages[0] ??
      null,
    [filteredGmailMessages, selectedMessageId],
  );

  useEffect(() => {
    if (calendarEvents.length === 0) {
      setSelectedCalendarId(null);
      setCalendarContext(null);
      return;
    }
    if (
      selectedCalendarId &&
      calendarEvents.some((event) => event.id === selectedCalendarId)
    ) {
      return;
    }
    setSelectedCalendarId(calendarEvents[0].id);
  }, [calendarEvents, selectedCalendarId]);

  useEffect(() => {
    if (filteredGmailMessages.length === 0) {
      setSelectedMessageId(null);
      setDraft(null);
      setDraftBody("");
      return;
    }
    if (
      selectedMessageId &&
      filteredGmailMessages.some((message) => message.id === selectedMessageId)
    ) {
      return;
    }
    setSelectedMessageId(filteredGmailMessages[0].id);
  }, [filteredGmailMessages, selectedMessageId]);

  useEffect(() => {
    if (!selectedCalendarEvent || !dataStatus?.connected) {
      setCalendarContext(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const context = await client.getLifeOpsNextCalendarEventContext({
          mode: dataStatus.mode,
          side: dataStatus.side,
          calendarId: selectedCalendarEvent.calendarId,
          timeMin: selectedCalendarEvent.startAt,
          timeMax: selectedCalendarEvent.endAt,
          timeZone,
        });
        if (active) {
          setCalendarContext(context);
        }
      } catch (cause) {
        if (!active) {
          return;
        }
        setCalendarContext(null);
        setWorkspaceError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Calendar detail context failed to load.",
        );
      }
    })();

    return () => {
      active = false;
    };
  }, [dataStatus, selectedCalendarEvent, timeZone]);

  const handleCreateEvent = useCallback(async () => {
    if (!dataStatus?.connected) {
      return;
    }
    const startAt = combineDateTime(eventDate, eventTime);
    const durationMinutes = Number(eventDurationMinutes);
    if (!eventTitle.trim() || !startAt || !Number.isFinite(durationMinutes)) {
      setWorkspaceError("Enter a title, date, time, and duration.");
      return;
    }
    setCreatingEvent(true);
    setWorkspaceError(null);
    try {
      const result = await client.createLifeOpsCalendarEvent({
        side: dataStatus.side,
        mode: dataStatus.mode,
        title: eventTitle.trim(),
        description: eventDescription.trim() || undefined,
        location: eventLocation.trim() || undefined,
        startAt,
        timeZone,
        durationMinutes,
      });
      setActionNotice(
        `Created calendar event: ${result.event.title}`,
        "success",
        2600,
      );
      setCalendarFeed((current) =>
        current
          ? {
              ...current,
              events: [result.event, ...current.events],
            }
          : current,
      );
      setSelectedCalendarId(result.event.id);
      await loadWorkspace();
    } catch (cause) {
      setWorkspaceError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Could not create the calendar event.",
      );
    } finally {
      setCreatingEvent(false);
    }
  }, [
    dataStatus,
    eventDate,
    eventDescription,
    eventDurationMinutes,
    eventLocation,
    eventTime,
    eventTitle,
    loadWorkspace,
    setActionNotice,
    timeZone,
  ]);

  const handleGenerateDraft = useCallback(async () => {
    if (!dataStatus?.connected || !selectedGmailMessage) {
      return;
    }
    setDrafting(true);
    setWorkspaceError(null);
    try {
      const response = await client.createLifeOpsGmailReplyDraft({
        side: dataStatus.side,
        mode: dataStatus.mode,
        messageId: selectedGmailMessage.id,
        tone: draftTone,
        intent: draftIntent.trim() || undefined,
        includeQuotedOriginal: draftIncludeQuotedOriginal,
      });
      setDraft(response.draft);
      setDraftBody(response.draft.bodyText);
      setActionNotice(
        `Prepared a reply draft for ${selectedGmailMessage.subject}`,
        "success",
        2200,
      );
    } catch (cause) {
      setWorkspaceError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Could not draft a reply.",
      );
    } finally {
      setDrafting(false);
    }
  }, [
    dataStatus,
    draftIncludeQuotedOriginal,
    draftIntent,
    draftTone,
    selectedGmailMessage,
    setActionNotice,
  ]);

  const handleSendDraft = useCallback(async () => {
    if (!dataStatus?.connected || !selectedGmailMessage || !draftBody.trim()) {
      return;
    }
    setSending(true);
    setWorkspaceError(null);
    try {
      await client.sendLifeOpsGmailReply({
        side: dataStatus.side,
        mode: dataStatus.mode,
        messageId: selectedGmailMessage.id,
        bodyText: draftBody,
        confirmSend: draft?.requiresConfirmation ?? true,
        subject: draft?.subject,
        to: draft?.to,
        cc: draft?.cc,
      });
      setActionNotice(
        `Sent reply for ${selectedGmailMessage.subject}`,
        "success",
        2600,
      );
      setDraft(null);
      setDraftBody("");
      await loadWorkspace();
    } catch (cause) {
      setWorkspaceError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Could not send the reply.",
      );
    } finally {
      setSending(false);
    }
  }, [
    dataStatus,
    draft,
    draftBody,
    loadWorkspace,
    selectedGmailMessage,
    setActionNotice,
  ]);

  const workspaceConnected = connectedConnectors.length > 0;
  const calendarSummary = calendarEvents.length;
  const mailSummary = gmailMessages.length;
  const replyNeededCount = gmailFeed?.summary.likelyReplyNeededCount ?? 0;

  const paneItems = [
    { value: "agenda", label: "Agenda" },
    { value: "week", label: "Week" },
    { value: "email", label: "Email" },
  ] as const;

  if (!workspaceConnected) {
    return (
      <div className="space-y-4">
        <PagePanel variant="section" className="p-4 lg:p-5">
          <PagePanel.Header
            eyebrow="LifeOps"
            heading="Calendar and Inbox Workspace"
            description="Connect Google for the owner or agent in LifeOps settings to bring calendar and Gmail into the operational surface."
            actions={
              <Button
                variant="outline"
                size="sm"
                className="rounded-full px-4 text-xs-tight font-semibold"
                onClick={() => setState("tab", "settings")}
              >
                Open settings
              </Button>
            }
          />
          <PagePanel.Empty
            variant="surface"
            className="min-h-[14rem] rounded-3xl"
            title="No Google connection yet"
            description="The workspace shows agenda, week, and reply-needed email views after a Google account is connected."
          />
        </PagePanel>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PagePanel variant="section" className="p-4 lg:p-5">
        <PagePanel.Header
          eyebrow="LifeOps"
          heading="Calendar and Inbox Workspace"
          description="Agenda, week, and reply-needed mail live in one operational surface."
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="rounded-full px-4 text-xs-tight font-semibold"
                onClick={() => void refreshAll()}
                disabled={ownerConnector.loading || agentConnector.loading}
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                Refresh
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full px-4 text-xs-tight font-semibold"
                onClick={() => setState("tab", "settings")}
              >
                <Settings2 className="mr-2 h-3.5 w-3.5" />
                Settings
              </Button>
            </div>
          }
        />

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-border/40 bg-bg/72 p-4">
            <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted">
              Connector
            </div>
            <div className="mt-2 text-sm font-semibold text-txt">
              {dataStatus ? sideLabel(dataStatus.side) : "Disconnected"}
            </div>
            <div className="mt-1 text-xs-tight text-muted">
              {dataStatus ? modeLabel(dataStatus.mode) : "No account selected"}
            </div>
          </div>
          <div className="rounded-2xl border border-border/40 bg-bg/72 p-4">
            <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted">
              Calendar
            </div>
            <div className="mt-2 text-sm font-semibold text-txt">
              {calendarSummary} event{calendarSummary === 1 ? "" : "s"}
            </div>
            <div className="mt-1 text-xs-tight text-muted">
              {pane === "week" ? "7 day window" : "Today’s agenda"}
            </div>
          </div>
          <div className="rounded-2xl border border-border/40 bg-bg/72 p-4">
            <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted">
              Inbox
            </div>
            <div className="mt-2 text-sm font-semibold text-txt">
              {replyNeededCount} reply needed
            </div>
            <div className="mt-1 text-xs-tight text-muted">
              {mailSummary} mail item{mailSummary === 1 ? "" : "s"} loaded
            </div>
          </div>
        </div>

        <div className="mt-4">
          <SegmentedControl
            aria-label="LifeOps workspace navigation"
            value={pane}
            onValueChange={(value) => setPane(value as WorkspacePane)}
            items={paneItems.map((item) => ({
              value: item.value,
              label: item.label,
            }))}
            buttonClassName="min-h-9 whitespace-nowrap px-3 py-2.5"
            data-testid="lifeops-workspace-nav"
          />
        </div>

        {workspaceError ? (
          <PagePanel.Notice tone="danger" className="mt-4">
            {workspaceError}
          </PagePanel.Notice>
        ) : null}

        {loading &&
        calendarEvents.length === 0 &&
        gmailMessages.length === 0 ? (
          <PagePanel.Loading
            variant="surface"
            heading="Loading LifeOps workspace"
            className="mt-4"
          />
        ) : null}
      </PagePanel>

      {pane === "email" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(20rem,0.85fr)_minmax(0,1fr)]">
          <PagePanel variant="section" className="p-4 lg:p-5">
            <PagePanel.Header
              eyebrow="Gmail"
              heading="Reply-needed mail"
              description="Filter to the threads that most likely need a response."
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full px-4 text-xs-tight font-semibold"
                  onClick={() => void loadWorkspace()}
                >
                  Refresh mail
                </Button>
              }
            />
            <div className="space-y-3">
              <Input
                data-testid="lifeops-mail-search"
                value={mailSearch}
                onChange={(event) => setMailSearch(event.target.value)}
                placeholder="Search subjects, senders, or snippets"
                aria-label="Search mail"
              />
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={replyNeededOnly}
                  onChange={(event) => setReplyNeededOnly(event.target.checked)}
                />
                Reply-needed only
              </label>
              <div className="space-y-2">
                {filteredGmailMessages.length === 0 ? (
                  <PagePanel.Empty
                    variant="surface"
                    className="min-h-[12rem] rounded-3xl"
                    title="No mail matches"
                    description="Clear the filter or turn off reply-needed only to inspect the loaded Gmail triage feed."
                  />
                ) : (
                  filteredGmailMessages.map((message) => (
                    <GmailMessageCard
                      key={message.id}
                      message={message}
                      selected={message.id === selectedGmailMessage?.id}
                      onSelect={setSelectedMessageId}
                      timeZone={timeZone}
                    />
                  ))
                )}
              </div>
            </div>
          </PagePanel>

          <PagePanel variant="section" className="p-4 lg:p-5">
            <PagePanel.Header
              eyebrow="Draft"
              heading={selectedGmailMessage?.subject ?? "Select a message"}
              description={selectedGmailMessage?.from ?? "No message selected"}
            />

            {selectedGmailMessage ? (
              <div className="space-y-3">
                <DetailBlock title="Message detail">
                  <div>
                    <span className="font-semibold text-txt">Subject:</span>{" "}
                    {selectedGmailMessage.subject}
                  </div>
                  <div>
                    <span className="font-semibold text-txt">From:</span>{" "}
                    {selectedGmailMessage.from}
                  </div>
                  <div>
                    <span className="font-semibold text-txt">Snippet:</span>{" "}
                    {selectedGmailMessage.snippet}
                  </div>
                  <div>
                    <span className="font-semibold text-txt">Received:</span>{" "}
                    {formatLocalDateTime(
                      selectedGmailMessage.receivedAt,
                      timeZone,
                    )}
                  </div>
                </DetailBlock>

                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="space-y-1 sm:col-span-1">
                    <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                      Tone
                    </span>
                    <select
                      value={draftTone}
                      onChange={(event) =>
                        setDraftTone(
                          event.target.value as LifeOpsGmailDraftTone,
                        )
                      }
                      className="min-h-11 w-full rounded-xl border border-border/60 bg-card/96 px-3 py-2 text-sm text-txt shadow-sm"
                    >
                      <option value="brief">Brief</option>
                      <option value="neutral">Neutral</option>
                      <option value="warm">Warm</option>
                    </select>
                  </label>
                  <label className="space-y-1 sm:col-span-2">
                    <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                      Intent
                    </span>
                    <Input
                      data-testid="lifeops-draft-intent"
                      value={draftIntent}
                      onChange={(event) => setDraftIntent(event.target.value)}
                      placeholder="What should the reply achieve?"
                    />
                  </label>
                </div>

                <label className="flex items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={draftIncludeQuotedOriginal}
                    onChange={(event) =>
                      setDraftIncludeQuotedOriginal(event.target.checked)
                    }
                  />
                  Include quoted original
                </label>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    className="rounded-full px-4 text-xs-tight font-semibold"
                    onClick={() => void handleGenerateDraft()}
                    disabled={
                      !dataCapabilities.has("google.gmail.triage") || drafting
                    }
                  >
                    {drafting ? "Drafting..." : "Generate draft"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full px-4 text-xs-tight font-semibold"
                    onClick={() => void loadWorkspace()}
                  >
                    Refresh triage
                  </Button>
                </div>

                <Textarea
                  data-testid="lifeops-draft-body"
                  value={draftBody}
                  onChange={(event) => setDraftBody(event.target.value)}
                  placeholder="Draft body appears here"
                  className="min-h-48"
                />

                {draft ? (
                  <DetailBlock title="Draft metadata">
                    <div>
                      <span className="font-semibold text-txt">
                        Send allowed:
                      </span>{" "}
                      {draft.sendAllowed ? "Yes" : "No"}
                    </div>
                    <div>
                      <span className="font-semibold text-txt">
                        Requires confirmation:
                      </span>{" "}
                      {draft.requiresConfirmation ? "Yes" : "No"}
                    </div>
                    {draft.previewLines.length > 0 ? (
                      <div className="space-y-1">
                        <div className="font-semibold text-txt">Preview:</div>
                        {draft.previewLines.map((line) => (
                          <div key={line}>{line}</div>
                        ))}
                      </div>
                    ) : null}
                  </DetailBlock>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    className="rounded-full px-4 text-xs-tight font-semibold"
                    onClick={() => void handleSendDraft()}
                    disabled={
                      !dataCapabilities.has("google.gmail.send") ||
                      sending ||
                      draftBody.trim().length === 0
                    }
                  >
                    {sending ? "Sending..." : "Send reply"}
                  </Button>
                </div>
              </div>
            ) : (
              <PagePanel.Empty
                variant="surface"
                className="min-h-[20rem] rounded-3xl"
                title="Select a message"
                description="Pick a reply-needed thread to draft or send a follow-up."
              />
            )}
          </PagePanel>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(20rem,0.85fr)_minmax(0,1fr)]">
          <PagePanel variant="section" className="p-4 lg:p-5">
            <PagePanel.Header
              eyebrow="Calendar"
              heading={pane === "week" ? "Week agenda" : "Today’s agenda"}
              description="The live Google calendar feed, grouped by day."
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full px-4 text-xs-tight font-semibold"
                  onClick={() => void loadWorkspace()}
                >
                  Refresh calendar
                </Button>
              }
            />
            <div className="space-y-3">
              {groupedCalendarEvents.length === 0 ? (
                <PagePanel.Empty
                  variant="surface"
                  className="min-h-[12rem] rounded-3xl"
                  title="No upcoming events"
                  description="The calendar feed is empty in this window."
                />
              ) : (
                groupedCalendarEvents.map((group) => (
                  <div key={group.dayKey} className="space-y-2">
                    <div className="text-xs-tight font-semibold uppercase tracking-[0.12em] text-muted">
                      {group.label}
                    </div>
                    <div className="space-y-2">
                      {group.events.map((event) => (
                        <CalendarEventCard
                          key={event.id}
                          event={event}
                          selected={event.id === selectedCalendarEvent?.id}
                          onSelect={setSelectedCalendarId}
                          timeZone={timeZone}
                        />
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </PagePanel>

          <PagePanel variant="section" className="p-4 lg:p-5">
            <PagePanel.Header
              eyebrow="Detail"
              heading={selectedCalendarEvent?.title ?? "Select an event"}
              description={
                selectedCalendarEvent
                  ? formatEventWindow(selectedCalendarEvent, timeZone)
                  : "No calendar event selected."
              }
            />

            {selectedCalendarEvent ? (
              <div className="space-y-3">
                <DetailBlock title="Event detail">
                  <div>
                    <span className="font-semibold text-txt">Location:</span>{" "}
                    {selectedCalendarEvent.location || "—"}
                  </div>
                  <div>
                    <span className="font-semibold text-txt">Starts:</span>{" "}
                    {formatLocalDateTime(
                      selectedCalendarEvent.startAt,
                      timeZone,
                    )}
                  </div>
                  <div>
                    <span className="font-semibold text-txt">Ends:</span>{" "}
                    {formatLocalDateTime(selectedCalendarEvent.endAt, timeZone)}
                  </div>
                  {selectedCalendarEvent.conferenceLink ? (
                    <div>
                      <span className="font-semibold text-txt">
                        Conference:
                      </span>{" "}
                      {selectedCalendarEvent.conferenceLink}
                    </div>
                  ) : null}
                  {selectedCalendarEvent.description.trim().length > 0 ? (
                    <div>
                      <span className="font-semibold text-txt">
                        Description:
                      </span>{" "}
                      {selectedCalendarEvent.description}
                    </div>
                  ) : null}
                </DetailBlock>

                {calendarContext ? (
                  <DetailBlock title="Preparation">
                    <div>
                      <span className="font-semibold text-txt">Starts in:</span>{" "}
                      {calendarContext.startsInMinutes === null
                        ? "—"
                        : `${calendarContext.startsInMinutes} minutes`}
                    </div>
                    {calendarContext.preparationChecklist.length > 0 ? (
                      <div className="space-y-1">
                        <div className="font-semibold text-txt">Checklist:</div>
                        {calendarContext.preparationChecklist.map((item) => (
                          <div key={item}>• {item}</div>
                        ))}
                      </div>
                    ) : null}
                    {calendarContext.linkedMail.length > 0 ? (
                      <div className="space-y-1">
                        <div className="font-semibold text-txt">
                          Linked mail:
                        </div>
                        {calendarContext.linkedMail.map((message) => (
                          <div key={message.id}>
                            {message.subject} - {message.from}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </DetailBlock>
                ) : null}

                <DetailBlock title="Quick create">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                        Title
                      </span>
                      <Input
                        data-testid="lifeops-create-event-title"
                        value={eventTitle}
                        onChange={(event) => setEventTitle(event.target.value)}
                        placeholder="Weekly planning"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                        Date
                      </span>
                      <Input
                        data-testid="lifeops-create-event-date"
                        type="date"
                        value={eventDate}
                        onChange={(event) => setEventDate(event.target.value)}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                        Time
                      </span>
                      <Input
                        data-testid="lifeops-create-event-time"
                        type="time"
                        value={eventTime}
                        onChange={(event) => setEventTime(event.target.value)}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                        Duration
                      </span>
                      <Input
                        data-testid="lifeops-create-event-duration"
                        type="number"
                        min={5}
                        step={5}
                        value={eventDurationMinutes}
                        onChange={(event) =>
                          setEventDurationMinutes(event.target.value)
                        }
                      />
                    </label>
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                        Location
                      </span>
                      <Input
                        data-testid="lifeops-create-event-location"
                        value={eventLocation}
                        onChange={(event) =>
                          setEventLocation(event.target.value)
                        }
                        placeholder="Conference room or link"
                      />
                    </label>
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                        Description
                      </span>
                      <Textarea
                        data-testid="lifeops-create-event-description"
                        value={eventDescription}
                        onChange={(event) =>
                          setEventDescription(event.target.value)
                        }
                        placeholder="Add prep notes"
                        className="min-h-28"
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="default"
                      size="sm"
                      className="rounded-full px-4 text-xs-tight font-semibold"
                      onClick={() => void handleCreateEvent()}
                      disabled={
                        creatingEvent ||
                        !dataCapabilities.has("google.calendar.write")
                      }
                    >
                      {creatingEvent ? "Creating..." : "Create event"}
                    </Button>
                  </div>
                </DetailBlock>
              </div>
            ) : (
              <PagePanel.Empty
                variant="surface"
                className="min-h-[20rem] rounded-3xl"
                title="Select a day"
                description="Pick an event to inspect detail and linked context."
              />
            )}
          </PagePanel>
        </div>
      )}
    </div>
  );
}
