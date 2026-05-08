import {
  Badge,
  Button,
  client,
  Input,
  SegmentedControl,
  Textarea,
  useApp,
} from "@elizaos/app-core";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsConnectorSide,
  LifeOpsGmailBulkOperation,
  LifeOpsGmailDraftTone,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailRecommendation,
  LifeOpsGmailRecommendationsFeed,
  LifeOpsGmailReplyDraft,
  LifeOpsGmailTriageFeed,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
} from "../contracts/index.js";
import { useGoogleLifeOpsConnector } from "../hooks/useGoogleLifeOpsConnector.js";

type CalendarWindow = "today" | "week";

const CONNECTOR_REFRESH_INTERVAL_MS = 30_000;
const GMAIL_MESSAGE_LIMIT = 12;
const GMAIL_BULK_MESSAGE_LIMIT = 50;
const TODAY_WINDOW_DAYS = 1;
const WEEK_WINDOW_DAYS = 7;

type GmailMessageFeed = Pick<
  LifeOpsGmailTriageFeed,
  "messages" | "source" | "syncedAt"
>;

type TranslateFn = (
  key: string,
  options?: Record<string, unknown> & { defaultValue?: string },
) => string;

function capabilitySet(
  status: LifeOpsGoogleConnectorStatus | null,
): Set<LifeOpsGoogleCapability> {
  return new Set(status?.grantedCapabilities ?? []);
}

function sideLabel(side: LifeOpsConnectorSide, t: TranslateFn): string {
  return side === "owner"
    ? t("lifeopsworkspace.user", {
        defaultValue: "User",
      })
    : t("chat.agentType", {
        defaultValue: "Agent",
      });
}

function connectorStatusLabel(
  status: LifeOpsGoogleConnectorStatus | null,
  t: TranslateFn,
): string {
  if (status?.connected) {
    return t("lifeopsworkspace.connected", {
      defaultValue: "Connected",
    });
  }
  switch (status?.reason) {
    case "needs_reauth":
      return t("lifeopsworkspace.needsReauth", {
        defaultValue: "Needs reauth",
      });
    case "config_missing":
      return t("lifeopsworkspace.needsSetup", {
        defaultValue: "Needs setup",
      });
    case "token_missing":
      return t("lifeopsworkspace.tokenMissing", {
        defaultValue: "Token missing",
      });
    default:
      return t("lifeopsworkspace.notConnected", {
        defaultValue: "Not connected",
      });
  }
}

function readIdentityLabel(
  identity: Record<string, unknown> | null,
  t: TranslateFn,
): {
  primary: string;
  secondary: string | null;
} {
  if (!identity) {
    return {
      primary: t("lifeopsworkspace.notConnected", {
        defaultValue: "Not connected",
      }),
      secondary: null,
    };
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
    primary:
      name ??
      email ??
      t("lifeopsworkspace.connected", {
        defaultValue: "Connected",
      }),
    secondary: name && email ? email : null,
  };
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

function formatDayLabel(value: string, timeZone: string): string {
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

function formatEventWindow(
  event: LifeOpsCalendarEvent,
  t: TranslateFn,
  timeZone: string,
): string {
  if (event.isAllDay) {
    return t("lifeopsworkspace.allDay", {
      defaultValue: "All day",
    });
  }
  return `${formatTimeOfDay(event.startAt, timeZone)} - ${formatTimeOfDay(
    event.endAt,
    timeZone,
  )}`;
}

function eventOriginLabel(event: LifeOpsCalendarEvent): string | null {
  const parts = [event.calendarSummary, event.accountEmail].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" · ");
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
    const dayKey = toLocalDateKey(new Date(event.startAt), timeZone);
    const existing = grouped.get(dayKey);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    grouped.set(dayKey, {
      label: formatDayLabel(event.startAt, timeZone),
      events: [event],
    });
  }
  return [...grouped.entries()].map(([dayKey, value]) => ({
    dayKey,
    label: value.label,
    events: value.events,
  }));
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

function parseGmailLabelIds(value: string): string[] {
  return value
    .split(",")
    .map((labelId) => labelId.trim())
    .filter((labelId) => labelId.length > 0);
}

function isDestructiveGmailOperation(
  operation: LifeOpsGmailBulkOperation,
): boolean {
  return (
    operation === "trash" ||
    operation === "delete" ||
    operation === "report_spam"
  );
}

function gmailOperationLabel(
  operation: LifeOpsGmailBulkOperation,
  t: TranslateFn,
): string {
  switch (operation) {
    case "archive":
      return t("lifeopsworkspace.archive", { defaultValue: "Archive" });
    case "trash":
      return t("lifeopsworkspace.trash", { defaultValue: "Trash" });
    case "report_spam":
      return t("lifeopsworkspace.reportSpam", {
        defaultValue: "Report spam",
      });
    case "mark_read":
      return t("lifeopsworkspace.markRead", { defaultValue: "Mark read" });
    case "mark_unread":
      return t("lifeopsworkspace.markUnread", {
        defaultValue: "Mark unread",
      });
    case "apply_label":
      return t("lifeopsworkspace.applyLabel", {
        defaultValue: "Apply label",
      });
    case "remove_label":
      return t("lifeopsworkspace.removeLabel", {
        defaultValue: "Remove label",
      });
    case "delete":
      return t("lifeopsworkspace.delete", { defaultValue: "Delete" });
  }
}

type SideWorkspaceState = ReturnType<typeof useLifeOpsSideWorkspace>;

function useLifeOpsSideWorkspace({
  side,
  calendarWindow,
  timeZone,
}: {
  side: LifeOpsConnectorSide;
  calendarWindow: CalendarWindow;
  timeZone: string;
}) {
  const { setActionNotice, t } = useApp();
  const connector = useGoogleLifeOpsConnector({
    pollWhileDisconnected: false,
    side,
    pollIntervalMs: CONNECTOR_REFRESH_INTERVAL_MS,
  });
  const status = connector.status;
  const activeGrantId = status?.grant?.id;
  const capabilities = useMemo(() => capabilitySet(status), [status]);
  const connected = status?.connected === true;
  const calendarEnabled =
    connected &&
    (capabilities.has("google.calendar.read") ||
      capabilities.has("google.calendar.write"));
  const emailEnabled =
    connected &&
    (capabilities.has("google.gmail.triage") ||
      capabilities.has("google.gmail.send"));
  const emailManageEnabled =
    connected && capabilities.has("google.gmail.manage");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calendarFeed, setCalendarFeed] = useState<LifeOpsCalendarFeed | null>(
    null,
  );
  const [gmailFeed, setGmailFeed] = useState<GmailMessageFeed | null>(null);
  const [gmailRecommendations, setGmailRecommendations] =
    useState<LifeOpsGmailRecommendationsFeed | null>(null);
  const [gmailQuery, setGmailQuery] = useState("in:inbox");
  const [gmailReplyNeededOnly, setGmailReplyNeededOnly] = useState(false);
  const [gmailIncludeSpamTrash, setGmailIncludeSpamTrash] = useState(false);
  const [gmailSelectedMessageIds, setGmailSelectedMessageIds] = useState<
    string[]
  >([]);
  const [gmailLabelIds, setGmailLabelIds] = useState("");
  const [gmailManageConfirmed, setGmailManageConfirmed] = useState(false);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string | null>(
    null,
  );
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    null,
  );
  const [draftTone, setDraftTone] = useState<LifeOpsGmailDraftTone>("neutral");
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [managing, setManaging] = useState(false);
  const [draft, setDraft] = useState<LifeOpsGmailReplyDraft | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [sendConfirmed, setSendConfirmed] = useState(false);
  const [eventTitle, setEventTitle] = useState("");
  const [eventDate, setEventDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [eventTime, setEventTime] = useState("09:00");
  const [eventDurationMinutes, setEventDurationMinutes] = useState("30");
  const [eventLocation, setEventLocation] = useState("");
  const [creatingEvent, setCreatingEvent] = useState(false);
  const windowDays =
    calendarWindow === "week" ? WEEK_WINDOW_DAYS : TODAY_WINDOW_DAYS;

  const load = useCallback(
    async (options?: { forceSync?: boolean }) => {
      if (!connected || !status) {
        setLoading(false);
        setError(null);
        setCalendarFeed(null);
        setGmailFeed(null);
        setGmailRecommendations(null);
        setGmailSelectedMessageIds([]);
        setDraft(null);
        setDraftBody("");
        setSendConfirmed(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const [nextCalendarFeed, nextGmailFeed] = await Promise.all([
          calendarEnabled
            ? client.getLifeOpsCalendarFeed({
                side: status.side,
                mode: status.mode,
                grantId: activeGrantId,
                timeMin: startOfLocalDay().toISOString(),
                timeMax: addDays(startOfLocalDay(), windowDays).toISOString(),
                timeZone,
                forceSync: options?.forceSync,
              })
            : Promise.resolve<LifeOpsCalendarFeed | null>(null),
          emailEnabled
            ? client.getLifeOpsGmailTriage({
                side: status.side,
                mode: status.mode,
                grantId: activeGrantId,
                maxResults: GMAIL_MESSAGE_LIMIT,
                forceSync: options?.forceSync,
              })
            : Promise.resolve<LifeOpsGmailTriageFeed | null>(null),
        ]);
        setCalendarFeed(nextCalendarFeed);
        setGmailFeed(nextGmailFeed);
        setGmailRecommendations(null);
      } catch (cause) {
        setError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : t("lifeopsworkspace.loadFailed", {
                defaultValue: "Workspace failed to load.",
              }),
        );
      } finally {
        setLoading(false);
      }
    },
    [
      activeGrantId,
      calendarEnabled,
      connected,
      emailEnabled,
      status,
      t,
      timeZone,
      windowDays,
    ],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const calendarEvents = useMemo(
    () =>
      [...(calendarFeed?.events ?? [])].sort((left, right) =>
        left.startAt.localeCompare(right.startAt),
      ),
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
  const selectedGmailMessage = useMemo(
    () =>
      gmailMessages.find((message) => message.id === selectedMessageId) ??
      gmailMessages[0] ??
      null,
    [gmailMessages, selectedMessageId],
  );
  const identity = useMemo(
    () => readIdentityLabel(status?.identity ?? null, t),
    [status?.identity, t],
  );

  useEffect(() => {
    if (calendarEvents.length === 0) {
      setSelectedCalendarId(null);
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
    if (gmailMessages.length === 0) {
      setSelectedMessageId(null);
      setGmailSelectedMessageIds([]);
      setDraft(null);
      setDraftBody("");
      setSendConfirmed(false);
      return;
    }
    if (
      selectedMessageId &&
      gmailMessages.some((message) => message.id === selectedMessageId)
    ) {
      return;
    }
    setSelectedMessageId(gmailMessages[0].id);
    setSendConfirmed(false);
  }, [gmailMessages, selectedMessageId]);

  useEffect(() => {
    const visibleIds = new Set(gmailMessages.map((message) => message.id));
    setGmailSelectedMessageIds((current) =>
      current.filter((messageId) => visibleIds.has(messageId)),
    );
  }, [gmailMessages]);

  const handleSelectGmailMessage = useCallback((messageId: string) => {
    setSelectedMessageId(messageId);
    setSendConfirmed(false);
  }, []);

  const refresh = useCallback(async () => {
    await connector.refresh({ silent: true });
    await load({ forceSync: true });
    setGmailSelectedMessageIds([]);
    setGmailManageConfirmed(false);
  }, [connector, load]);

  const handleCreateEvent = useCallback(async () => {
    if (!status || !calendarEnabled) {
      return;
    }
    const startAt = combineDateTime(eventDate, eventTime);
    const durationMinutes = Number(eventDurationMinutes);
    if (!eventTitle.trim() || !startAt || !Number.isFinite(durationMinutes)) {
      setError(
        t("lifeopsworkspace.createEventValidation", {
          defaultValue: "Enter a title, date, time, and duration.",
        }),
      );
      return;
    }

    setCreatingEvent(true);
    setError(null);
    try {
      const result = await client.createLifeOpsCalendarEvent({
        side: status.side,
        mode: status.mode,
        grantId: activeGrantId,
        title: eventTitle.trim(),
        location: eventLocation.trim() || undefined,
        startAt,
        timeZone,
        durationMinutes,
      });
      setActionNotice(
        t("lifeopsworkspace.createdEvent", {
          defaultValue: "Created {{title}}",
          title: result.event.title,
        }),
        "success",
        2400,
      );
      setEventTitle("");
      setEventLocation("");
      await refresh();
      setSelectedCalendarId(result.event.id);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("lifeopsworkspace.createEventFailed", {
              defaultValue: "Could not create the event.",
            }),
      );
    } finally {
      setCreatingEvent(false);
    }
  }, [
    calendarEnabled,
    eventDate,
    eventDurationMinutes,
    eventLocation,
    eventTime,
    eventTitle,
    activeGrantId,
    refresh,
    setActionNotice,
    status,
    t,
    timeZone,
  ]);

  const handleGenerateDraft = useCallback(async () => {
    if (!status || !emailEnabled || !selectedGmailMessage) {
      return;
    }
    setDrafting(true);
    setError(null);
    try {
      const response = await client.createLifeOpsGmailReplyDraft({
        side: status.side,
        mode: status.mode,
        grantId: activeGrantId,
        messageId: selectedGmailMessage.id,
        tone: draftTone,
        includeQuotedOriginal: true,
      });
      setDraft(response.draft);
      setDraftBody(response.draft.bodyText);
      setSendConfirmed(false);
      setActionNotice(
        t("lifeopsworkspace.draftedReply", {
          defaultValue: "Drafted {{subject}}",
          subject: selectedGmailMessage.subject,
        }),
        "success",
        2200,
      );
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("lifeopsworkspace.draftReplyFailed", {
              defaultValue: "Could not draft the reply.",
            }),
      );
    } finally {
      setDrafting(false);
    }
  }, [
    draftTone,
    emailEnabled,
    activeGrantId,
    selectedGmailMessage,
    setActionNotice,
    status,
    t,
  ]);

  const handleSearchGmail = useCallback(async () => {
    if (!status || !emailEnabled) {
      return;
    }
    const query = gmailQuery.trim();
    if (!query) {
      setError(
        t("lifeopsworkspace.gmailSearchValidation", {
          defaultValue: "Enter a Gmail search query.",
        }),
      );
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await client.getLifeOpsGmailSearch({
        side: status.side,
        mode: status.mode,
        grantId: activeGrantId,
        query,
        maxResults: GMAIL_BULK_MESSAGE_LIMIT,
        forceSync: true,
        replyNeededOnly: gmailReplyNeededOnly,
        includeSpamTrash: gmailIncludeSpamTrash,
      });
      setGmailFeed(result);
      setGmailRecommendations(null);
      setGmailSelectedMessageIds([]);
      setGmailManageConfirmed(false);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("lifeopsworkspace.gmailSearchFailed", {
              defaultValue: "Could not search Gmail.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [
    emailEnabled,
    gmailIncludeSpamTrash,
    gmailQuery,
    gmailReplyNeededOnly,
    activeGrantId,
    status,
    t,
  ]);

  const handleShowNeedsResponse = useCallback(async () => {
    if (!status || !emailEnabled) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await client.getLifeOpsGmailNeedsResponse({
        side: status.side,
        mode: status.mode,
        grantId: activeGrantId,
        maxResults: GMAIL_BULK_MESSAGE_LIMIT,
        forceSync: true,
      });
      setGmailFeed(result);
      setGmailRecommendations(null);
      setGmailSelectedMessageIds([]);
      setGmailManageConfirmed(false);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("lifeopsworkspace.gmailNeedsResponseFailed", {
              defaultValue: "Could not load Gmail messages that need response.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [activeGrantId, emailEnabled, status, t]);

  const handleLoadRecommendations = useCallback(async () => {
    if (!status || !emailEnabled) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await client.getLifeOpsGmailRecommendations({
        side: status.side,
        mode: status.mode,
        grantId: activeGrantId,
        query: gmailQuery.trim() || undefined,
        maxResults: GMAIL_BULK_MESSAGE_LIMIT,
        forceSync: true,
        replyNeededOnly: gmailReplyNeededOnly,
        includeSpamTrash: gmailIncludeSpamTrash,
      });
      setGmailRecommendations(result);
      setGmailManageConfirmed(false);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("lifeopsworkspace.gmailRecommendationsFailed", {
              defaultValue: "Could not load Gmail recommendations.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [
    emailEnabled,
    gmailIncludeSpamTrash,
    gmailQuery,
    gmailReplyNeededOnly,
    activeGrantId,
    status,
    t,
  ]);

  const handleSendDraft = useCallback(async () => {
    if (!status || !selectedGmailMessage || draftBody.trim().length === 0) {
      return;
    }
    if (!sendConfirmed) {
      setError(
        t("lifeopsworkspace.sendConfirmationRequired", {
          defaultValue: "Confirm this Gmail send before sending.",
        }),
      );
      return;
    }
    setSending(true);
    setError(null);
    try {
      await client.sendLifeOpsGmailReply({
        side: status.side,
        mode: status.mode,
        grantId: activeGrantId,
        messageId: selectedGmailMessage.id,
        bodyText: draftBody,
        confirmSend: true,
        subject: draft?.subject,
        to: draft?.to,
        cc: draft?.cc,
      });
      setActionNotice(
        t("lifeopsworkspace.sentReply", {
          defaultValue: "Sent {{subject}}",
          subject: selectedGmailMessage.subject,
        }),
        "success",
        2400,
      );
      setDraft(null);
      setDraftBody("");
      setSendConfirmed(false);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("lifeopsworkspace.sendReplyFailed", {
              defaultValue: "Could not send the reply.",
            }),
      );
    } finally {
      setSending(false);
    }
  }, [
    draft,
    draftBody,
    activeGrantId,
    refresh,
    selectedGmailMessage,
    sendConfirmed,
    setActionNotice,
    status,
    t,
  ]);

  const toggleGmailMessageSelection = useCallback((messageId: string) => {
    setGmailManageConfirmed(false);
    setGmailSelectedMessageIds((current) =>
      current.includes(messageId)
        ? current.filter((id) => id !== messageId)
        : [...current, messageId],
    );
  }, []);

  const handleManageMessage = useCallback(
    async (
      operation: LifeOpsGmailBulkOperation,
      options: {
        messageIds?: string[];
        labelIds?: string[];
        requiresConfirmation?: boolean;
      } = {},
    ) => {
      if (!status || !emailManageEnabled) {
        return;
      }
      const messageIds =
        options.messageIds ??
        (gmailSelectedMessageIds.length > 0
          ? gmailSelectedMessageIds
          : selectedGmailMessage
            ? [selectedGmailMessage.id]
            : []);
      if (messageIds.length === 0) {
        setError(
          t("lifeopsworkspace.gmailSelectMessages", {
            defaultValue: "Select at least one Gmail message.",
          }),
        );
        return;
      }
      const labelIds =
        options.labelIds ??
        (operation === "apply_label" || operation === "remove_label"
          ? parseGmailLabelIds(gmailLabelIds)
          : []);
      if (
        (operation === "apply_label" || operation === "remove_label") &&
        labelIds.length === 0
      ) {
        setError(
          t("lifeopsworkspace.gmailLabelValidation", {
            defaultValue: "Enter at least one Gmail label ID.",
          }),
        );
        return;
      }
      const requiresConfirmation =
        options.requiresConfirmation === true ||
        messageIds.length > 1 ||
        isDestructiveGmailOperation(operation);
      if (requiresConfirmation && !gmailManageConfirmed) {
        setError(
          t("lifeopsworkspace.gmailManageConfirmationRequired", {
            defaultValue:
              "Confirm this bulk or destructive Gmail update before running it.",
          }),
        );
        return;
      }
      setManaging(true);
      setError(null);
      try {
        const result = await client.manageLifeOpsGmailMessages({
          side: status.side,
          mode: status.mode,
          grantId: activeGrantId,
          messageIds,
          operation,
          labelIds,
          confirmDestructive: isDestructiveGmailOperation(operation),
        });
        setActionNotice(
          t("lifeopsworkspace.gmailManaged", {
            defaultValue: "{{operation}} applied to {{count}} message",
            operation: result.operation,
            count: result.affectedCount,
          }),
          "success",
          2200,
        );
        setGmailSelectedMessageIds([]);
        setGmailManageConfirmed(false);
        setDraft(null);
        setDraftBody("");
        setSendConfirmed(false);
        await refresh();
      } catch (cause) {
        setError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : t("lifeopsworkspace.gmailManageFailed", {
                defaultValue: "Could not update the Gmail message.",
              }),
        );
      } finally {
        setManaging(false);
      }
    },
    [
      emailManageEnabled,
      activeGrantId,
      gmailLabelIds,
      gmailManageConfirmed,
      gmailSelectedMessageIds,
      refresh,
      selectedGmailMessage,
      setActionNotice,
      status,
      t,
    ],
  );

  const handleApplyRecommendation = useCallback(
    async (recommendation: LifeOpsGmailRecommendation) => {
      if (!recommendation.operation) {
        return;
      }
      await handleManageMessage(recommendation.operation, {
        messageIds: recommendation.messageIds,
        labelIds: recommendation.labelIds,
        requiresConfirmation: recommendation.requiresConfirmation,
      });
    },
    [handleManageMessage],
  );

  return {
    side,
    identity,
    status,
    connected,
    statusLabel: connectorStatusLabel(status, t),
    loading,
    error,
    calendarEnabled,
    emailEnabled,
    emailManageEnabled,
    calendarEvents,
    groupedCalendarEvents,
    selectedCalendarEvent,
    setSelectedCalendarId,
    refresh,
    gmailMessages,
    selectedGmailMessage,
    setSelectedMessageId: handleSelectGmailMessage,
    gmailRecommendations,
    gmailQuery,
    setGmailQuery,
    gmailReplyNeededOnly,
    setGmailReplyNeededOnly,
    gmailIncludeSpamTrash,
    setGmailIncludeSpamTrash,
    gmailSelectedMessageIds,
    toggleGmailMessageSelection,
    gmailLabelIds,
    setGmailLabelIds,
    gmailManageConfirmed,
    setGmailManageConfirmed,
    draftTone,
    setDraftTone,
    draft,
    draftBody,
    setDraftBody,
    sendConfirmed,
    setSendConfirmed,
    drafting,
    sending,
    managing,
    eventTitle,
    setEventTitle,
    eventDate,
    setEventDate,
    eventTime,
    setEventTime,
    eventDurationMinutes,
    setEventDurationMinutes,
    eventLocation,
    setEventLocation,
    creatingEvent,
    handleCreateEvent,
    handleGenerateDraft,
    handleSearchGmail,
    handleShowNeedsResponse,
    handleLoadRecommendations,
    handleSendDraft,
    handleManageMessage,
    handleApplyRecommendation,
  } as const;
}

function SectionShell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-3xl border border-border/16 bg-card/18">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
        <div className="text-sm font-semibold text-txt">{title}</div>
        {actions}
      </div>
      <div className="border-t border-border/12 px-4 py-4">{children}</div>
    </section>
  );
}

function LockedSection({
  title,
  hint,
  owner,
  agent,
  t,
}: {
  title: string;
  hint: string;
  owner: SideWorkspaceState;
  agent: SideWorkspaceState;
  t: TranslateFn;
}) {
  return (
    <SectionShell title={title}>
      <div className="mb-3 text-xs leading-5 text-muted">{hint}</div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[owner, agent].map((workspace) => (
          <div key={workspace.side} className="rounded-2xl bg-bg/36 px-4 py-4">
            <div className="text-sm font-semibold text-txt">
              {sideLabel(workspace.side, t)}
            </div>
            <div className="mt-1 text-xs text-muted">
              {workspace.statusLabel}
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

function AccountBadge({ label }: { label: string | null | undefined }) {
  if (!label) {
    return null;
  }
  return (
    <Badge variant="outline" className="text-3xs">
      {label}
    </Badge>
  );
}

function CalendarColumn({
  workspace,
  timeZone,
  t,
}: {
  workspace: SideWorkspaceState;
  timeZone: string;
  t: TranslateFn;
}) {
  const [composerOpen, setComposerOpen] = useState(false);
  const eventCount = workspace.calendarEvents.length;

  return (
    <div className="space-y-4 rounded-2xl bg-bg/36 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-txt">
            {sideLabel(workspace.side, t)}
          </div>
          <div className="mt-1 truncate text-xs text-muted">
            {workspace.identity.secondary ?? workspace.identity.primary}
          </div>
        </div>
        <Badge variant="outline" className="text-2xs">
          {eventCount}
        </Badge>
      </div>

      {workspace.error ? (
        <div className="rounded-2xl bg-danger/10 px-3 py-2 text-xs text-danger">
          {workspace.error}
        </div>
      ) : null}

      {!workspace.calendarEnabled ? (
        <div className="text-xs text-muted">
          {t("lifeopsworkspace.grantCalendarAccess", {
            defaultValue:
              "Grant calendar access for this Google account in Setup.",
          })}
        </div>
      ) : workspace.loading && eventCount === 0 ? (
        <div className="text-xs text-muted">
          {t("lifeopsworkspace.loadingEvents", {
            defaultValue: "Loading events…",
          })}
        </div>
      ) : eventCount === 0 ? (
        <div className="text-xs text-muted">
          {t("lifeopsworkspace.nothingScheduled", {
            defaultValue: "Nothing scheduled. Use New event below to add one.",
          })}
        </div>
      ) : (
        <div className="space-y-3">
          {workspace.groupedCalendarEvents.map((group) => (
            <div key={group.dayKey} className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                {group.label}
              </div>
              <div className="overflow-hidden rounded-2xl bg-bg/45">
                {group.events.map((event, index) => (
                  <button
                    key={event.id}
                    type="button"
                    onClick={() => workspace.setSelectedCalendarId(event.id)}
                    className={`flex w-full items-start justify-between gap-3 px-3 py-3 text-left ${
                      index > 0 ? "border-t border-border/12" : ""
                    } ${
                      workspace.selectedCalendarEvent?.id === event.id
                        ? "bg-accent/8"
                        : "hover:bg-bg-hover/30"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-txt">
                        {event.title}
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {formatEventWindow(event, t, timeZone)}
                      </div>
                      {event.location.trim().length > 0 ? (
                        <div className="mt-1 truncate text-xs text-muted/90">
                          {event.location}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <AccountBadge label={eventOriginLabel(event)} />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {workspace.selectedCalendarEvent ? (
        <div className="space-y-2 rounded-2xl bg-card/18 px-3 py-3 text-xs text-muted">
          <div className="text-sm font-semibold text-txt">
            {workspace.selectedCalendarEvent.title}
          </div>
          <div>
            {formatLocalDateTime(
              workspace.selectedCalendarEvent.startAt,
              timeZone,
            )}
          </div>
          {workspace.selectedCalendarEvent.location.trim().length > 0 ? (
            <div>{workspace.selectedCalendarEvent.location}</div>
          ) : null}
          {workspace.selectedCalendarEvent.conferenceLink ? (
            <div className="truncate">
              {workspace.selectedCalendarEvent.conferenceLink}
            </div>
          ) : null}
          <AccountBadge
            label={eventOriginLabel(workspace.selectedCalendarEvent)}
          />
        </div>
      ) : null}

      {workspace.calendarEnabled ? (
        <div className="space-y-3">
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            onClick={() => setComposerOpen((current) => !current)}
          >
            {composerOpen
              ? t("lifeopsworkspace.hideNewEvent", {
                  defaultValue: "Hide new event",
                })
              : t("lifeopsworkspace.newEvent", {
                  defaultValue: "New event",
                })}
          </Button>

          {composerOpen ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                value={workspace.eventTitle}
                onChange={(event) =>
                  workspace.setEventTitle(event.target.value)
                }
                placeholder={t("common.title", {
                  defaultValue: "Title",
                })}
                aria-label={t("lifeopsworkspace.eventTitle", {
                  defaultValue: "Event title",
                })}
                className="sm:col-span-2"
              />
              <Input
                type="date"
                value={workspace.eventDate}
                onChange={(event) => workspace.setEventDate(event.target.value)}
                aria-label={t("lifeopsworkspace.eventDate", {
                  defaultValue: "Event date",
                })}
              />
              <Input
                type="time"
                value={workspace.eventTime}
                onChange={(event) => workspace.setEventTime(event.target.value)}
                aria-label={t("lifeopsworkspace.eventStartTime", {
                  defaultValue: "Event start time",
                })}
              />
              <Input
                type="number"
                min={5}
                step={5}
                value={workspace.eventDurationMinutes}
                onChange={(event) =>
                  workspace.setEventDurationMinutes(event.target.value)
                }
                placeholder={t("lifeopsworkspace.durationMinutes", {
                  defaultValue: "Duration in minutes",
                })}
                aria-label={t("lifeopsworkspace.durationMinutes", {
                  defaultValue: "Duration in minutes",
                })}
              />
              <Input
                value={workspace.eventLocation}
                onChange={(event) =>
                  workspace.setEventLocation(event.target.value)
                }
                placeholder={t("lifeopsworkspace.locationOptional", {
                  defaultValue: "Location (optional)",
                })}
                aria-label={t("common.location", {
                  defaultValue: "Location",
                })}
              />
              <Button
                size="sm"
                className="h-9 rounded-xl px-3 text-xs font-semibold sm:col-span-2"
                disabled={
                  workspace.creatingEvent || !workspace.eventTitle.trim()
                }
                onClick={() => void workspace.handleCreateEvent()}
              >
                {workspace.creatingEvent
                  ? t("lifeopsworkspace.creating", {
                      defaultValue: "Creating…",
                    })
                  : t("lifeopsworkspace.createEvent", {
                      defaultValue: "Create event",
                    })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GmailControls({
  workspace,
  t,
}: {
  workspace: SideWorkspaceState;
  t: TranslateFn;
}) {
  return (
    <div className="space-y-2 rounded-2xl bg-card/18 px-3 py-3">
      <div className="flex flex-wrap gap-2">
        <Input
          value={workspace.gmailQuery}
          onChange={(event) => workspace.setGmailQuery(event.target.value)}
          placeholder={t("lifeopsworkspace.gmailSearchPlaceholder", {
            defaultValue: "Gmail query, e.g. in:inbox newer_than:7d",
          })}
          aria-label={t("lifeopsworkspace.gmailSearchQuery", {
            defaultValue: "Gmail search query",
          })}
          className="h-8 min-w-48 flex-1 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled={
            workspace.loading || workspace.gmailQuery.trim().length === 0
          }
          onClick={() => void workspace.handleSearchGmail()}
        >
          {t("lifeopsworkspace.searchGmail", {
            defaultValue: "Search Gmail",
          })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled={workspace.loading}
          onClick={() => void workspace.refresh()}
        >
          {t("lifeopsworkspace.refreshInbox", {
            defaultValue: "Refresh inbox",
          })}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={workspace.gmailReplyNeededOnly}
            onChange={(event) =>
              workspace.setGmailReplyNeededOnly(event.target.checked)
            }
          />
          {t("lifeopsworkspace.replyNeededOnly", {
            defaultValue: "Reply-needed only",
          })}
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={workspace.gmailIncludeSpamTrash}
            onChange={(event) =>
              workspace.setGmailIncludeSpamTrash(event.target.checked)
            }
          />
          {t("lifeopsworkspace.includeSpamTrash", {
            defaultValue: "Include spam/trash",
          })}
        </label>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled={workspace.loading}
          onClick={() => void workspace.handleShowNeedsResponse()}
        >
          {t("lifeopsworkspace.needsResponse", {
            defaultValue: "Needs response",
          })}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          disabled={workspace.loading}
          onClick={() => void workspace.handleLoadRecommendations()}
        >
          {t("lifeopsworkspace.recommendations", {
            defaultValue: "Recommendations",
          })}
        </Button>
      </div>
    </div>
  );
}

function GmailRecommendationsPanel({
  workspace,
  t,
}: {
  workspace: SideWorkspaceState;
  t: TranslateFn;
}) {
  const recommendations = workspace.gmailRecommendations?.recommendations ?? [];
  const needsConfirmation = recommendations.some(
    (recommendation) =>
      recommendation.requiresConfirmation ||
      recommendation.kind === "review_spam" ||
      (recommendation.operation
        ? recommendation.messageIds.length > 1 ||
          isDestructiveGmailOperation(recommendation.operation)
        : false),
  );
  if (recommendations.length === 0) {
    return (
      <div className="rounded-2xl bg-card/18 px-3 py-3 text-xs text-muted">
        {t("lifeopsworkspace.noGmailRecommendations", {
          defaultValue: "No Gmail recommendations for this query.",
        })}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-2xl bg-card/18 px-3 py-3">
      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
        {t("lifeopsworkspace.gmailRecommendations", {
          defaultValue: "Gmail recommendations",
        })}
      </div>
      {needsConfirmation ? (
        <label className="inline-flex items-center gap-1.5 text-xs text-muted">
          <input
            type="checkbox"
            checked={workspace.gmailManageConfirmed}
            onChange={(event) =>
              workspace.setGmailManageConfirmed(event.target.checked)
            }
          />
          {t("lifeopsworkspace.confirmGmailRecommendation", {
            defaultValue: "Confirm recommendation update",
          })}
        </label>
      ) : null}
      {recommendations.map((recommendation) => (
        <div
          key={recommendation.id}
          className="space-y-2 rounded-2xl bg-bg/40 px-3 py-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-txt">
                {recommendation.title}
              </div>
              <div className="mt-1 text-xs text-muted">
                {recommendation.rationale}
              </div>
            </div>
            <Badge variant="outline" className="text-3xs">
              {recommendation.affectedCount}
            </Badge>
          </div>
          {recommendation.sampleMessages.length > 0 ? (
            <div className="space-y-1">
              {recommendation.sampleMessages.slice(0, 3).map((message) => (
                <div key={message.messageId} className="text-xs text-muted">
                  <span className="font-medium text-txt/85">
                    {message.subject}
                  </span>{" "}
                  {message.from}
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {recommendation.operation ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 rounded-xl px-3 text-xs font-semibold"
                disabled={
                  workspace.managing ||
                  ((recommendation.requiresConfirmation ||
                    recommendation.messageIds.length > 1 ||
                    isDestructiveGmailOperation(recommendation.operation)) &&
                    !workspace.gmailManageConfirmed)
                }
                onClick={() =>
                  void workspace.handleApplyRecommendation(recommendation)
                }
              >
                {gmailOperationLabel(recommendation.operation, t)}
              </Button>
            ) : null}
            {recommendation.kind === "review_spam"
              ? recommendation.sampleMessages.map((message) => (
                  <Button
                    key={message.messageId}
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-xl px-3 text-xs font-semibold"
                    disabled={
                      workspace.managing || !workspace.gmailManageConfirmed
                    }
                    onClick={() =>
                      void workspace.handleManageMessage("report_spam", {
                        messageIds: [message.messageId],
                      })
                    }
                  >
                    {t("lifeopsworkspace.reportSampleSpam", {
                      defaultValue: "Report sample spam",
                    })}
                  </Button>
                ))
              : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmailColumn({
  workspace,
  timeZone,
  t,
}: {
  workspace: SideWorkspaceState;
  timeZone: string;
  t: TranslateFn;
}) {
  const messageCount = workspace.gmailMessages.length;
  const selectedBulkMessageIds =
    workspace.gmailSelectedMessageIds.length > 0
      ? workspace.gmailSelectedMessageIds
      : workspace.selectedGmailMessage
        ? [workspace.selectedGmailMessage.id]
        : [];
  const selectedBulkCount = selectedBulkMessageIds.length;
  const labelIds = parseGmailLabelIds(workspace.gmailLabelIds);
  const isManageDisabled = (operation: LifeOpsGmailBulkOperation): boolean => {
    if (workspace.managing || selectedBulkCount === 0) {
      return true;
    }
    if (
      (operation === "apply_label" || operation === "remove_label") &&
      labelIds.length === 0
    ) {
      return true;
    }
    if (
      (selectedBulkCount > 1 || isDestructiveGmailOperation(operation)) &&
      !workspace.gmailManageConfirmed
    ) {
      return true;
    }
    return false;
  };

  return (
    <div className="space-y-4 rounded-2xl bg-bg/36 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-txt">
            {sideLabel(workspace.side, t)}
          </div>
          <div className="mt-1 truncate text-xs text-muted">
            {workspace.identity.secondary ?? workspace.identity.primary}
          </div>
        </div>
        <Badge variant="outline" className="text-2xs">
          {messageCount}
        </Badge>
      </div>

      {workspace.error ? (
        <div className="rounded-2xl bg-danger/10 px-3 py-2 text-xs text-danger">
          {workspace.error}
        </div>
      ) : null}

      {!workspace.emailEnabled ? (
        <div className="text-xs text-muted">
          {t("lifeopsworkspace.grantGmailAccess", {
            defaultValue:
              "Grant Gmail access for this Google account in Setup.",
          })}
        </div>
      ) : messageCount === 0 ? (
        <div className="space-y-3">
          <GmailControls workspace={workspace} t={t} />
          <div className="text-xs text-muted">
            {workspace.loading
              ? t("lifeopsworkspace.loadingRecentMail", {
                  defaultValue: "Loading recent mail…",
                })
              : t("lifeopsworkspace.inboxClear", {
                  defaultValue: "Inbox clear. Nothing to triage right now.",
                })}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <GmailControls workspace={workspace} t={t} />
          <div className="overflow-hidden rounded-2xl bg-bg/45">
            {workspace.gmailMessages.map((message, index) => (
              <div
                key={message.id}
                className={`flex w-full items-start justify-between gap-3 px-3 py-3 text-left ${
                  index > 0 ? "border-t border-border/12" : ""
                } ${
                  workspace.selectedGmailMessage?.id === message.id
                    ? "bg-accent/8"
                    : "hover:bg-bg-hover/30"
                }`}
              >
                <label className="mt-1 inline-flex shrink-0 items-center">
                  <input
                    type="checkbox"
                    checked={workspace.gmailSelectedMessageIds.includes(
                      message.id,
                    )}
                    onChange={() =>
                      workspace.toggleGmailMessageSelection(message.id)
                    }
                    aria-label={t("lifeopsworkspace.selectGmailMessage", {
                      defaultValue: "Select Gmail message {{subject}}",
                      subject: message.subject,
                    })}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => workspace.setSelectedMessageId(message.id)}
                  className="min-w-0 flex flex-1 items-start justify-between gap-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-txt">
                      {message.subject}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted">
                      {message.from}
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted/90">
                      {message.snippet}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {message.likelyReplyNeeded ? (
                      <Badge variant="secondary" className="text-3xs">
                        {t("lifeopsworkspace.reply", {
                          defaultValue: "Reply",
                        })}
                      </Badge>
                    ) : null}
                    {message.isUnread ? (
                      <Badge variant="outline" className="text-3xs">
                        {t("lifeopsworkspace.unread", {
                          defaultValue: "Unread",
                        })}
                      </Badge>
                    ) : null}
                    <AccountBadge label={message.accountEmail} />
                    <div className="text-[11px] text-muted">
                      {formatLocalDateTime(message.receivedAt, timeZone)}
                    </div>
                  </div>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {workspace.selectedGmailMessage ? (
        <div className="space-y-3 rounded-2xl bg-card/18 px-3 py-3">
          <div className="space-y-1 text-xs text-muted">
            <div className="text-sm font-semibold text-txt">
              {workspace.selectedGmailMessage.subject}
            </div>
            <div>{workspace.selectedGmailMessage.from}</div>
            <div>{workspace.selectedGmailMessage.snippet}</div>
          </div>

          {workspace.emailManageEnabled ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>
                  {t("lifeopsworkspace.gmailManageTarget", {
                    defaultValue:
                      selectedBulkCount > 1
                        ? "{{count}} selected messages"
                        : "Selected message",
                    count: selectedBulkCount,
                  })}
                </span>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={workspace.gmailManageConfirmed}
                    onChange={(event) =>
                      workspace.setGmailManageConfirmed(event.target.checked)
                    }
                  />
                  {t("lifeopsworkspace.confirmGmailManage", {
                    defaultValue: "Confirm bulk/destructive update",
                  })}
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    "archive",
                    "mark_read",
                    "mark_unread",
                    "report_spam",
                    "trash",
                  ] as const
                ).map((operation) => (
                  <Button
                    key={operation}
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-xl px-3 text-xs font-semibold"
                    disabled={isManageDisabled(operation)}
                    onClick={() =>
                      void workspace.handleManageMessage(operation)
                    }
                  >
                    {gmailOperationLabel(operation, t)}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Input
                  value={workspace.gmailLabelIds}
                  onChange={(event) =>
                    workspace.setGmailLabelIds(event.target.value)
                  }
                  placeholder={t("lifeopsworkspace.gmailLabelIds", {
                    defaultValue: "Label ID(s), comma-separated",
                  })}
                  aria-label={t("lifeopsworkspace.gmailLabelIds", {
                    defaultValue: "Label ID(s), comma-separated",
                  })}
                  className="h-8 min-w-48 flex-1 text-xs"
                />
                {(["apply_label", "remove_label"] as const).map((operation) => (
                  <Button
                    key={operation}
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-xl px-3 text-xs font-semibold"
                    disabled={isManageDisabled(operation)}
                    onClick={() =>
                      void workspace.handleManageMessage(operation)
                    }
                  >
                    {gmailOperationLabel(operation, t)}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          <SegmentedControl<LifeOpsGmailDraftTone>
            aria-label={t("lifeopsworkspace.draftToneAria", {
              defaultValue: "{{side}} draft tone",
              side: sideLabel(workspace.side, t),
            })}
            value={workspace.draftTone}
            onValueChange={workspace.setDraftTone}
            items={[
              {
                value: "brief",
                label: t("lifeopsworkspace.brief", {
                  defaultValue: "Brief",
                }),
              },
              {
                value: "neutral",
                label: t("lifeopsworkspace.neutral", {
                  defaultValue: "Neutral",
                }),
              },
              {
                value: "warm",
                label: t("lifeopsworkspace.warm", {
                  defaultValue: "Warm",
                }),
              },
            ]}
            className="border-border/28 bg-card/24 p-0.5"
            buttonClassName="min-h-8 px-3 py-1.5 text-xs"
          />

          <Textarea
            value={workspace.draftBody}
            onChange={(event) => {
              workspace.setDraftBody(event.target.value);
              workspace.setSendConfirmed(false);
            }}
            placeholder={t("lifeopsworkspace.reply", {
              defaultValue: "Reply",
            })}
            className="min-h-32"
          />

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={workspace.drafting}
              onClick={() => void workspace.handleGenerateDraft()}
            >
              {workspace.drafting
                ? t("lifeopsworkspace.drafting", {
                    defaultValue: "Drafting...",
                  })
                : t("lifeopsworkspace.draftReply", {
                    defaultValue: "Draft reply",
                  })}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={
                workspace.sending ||
                workspace.draftBody.trim().length === 0 ||
                !workspace.sendConfirmed
              }
              onClick={() => void workspace.handleSendDraft()}
            >
              {workspace.sending
                ? t("lifeopsworkspace.sending", {
                    defaultValue: "Sending...",
                  })
                : t("common.send", {
                    defaultValue: "Send",
                  })}
            </Button>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={workspace.sendConfirmed}
              onChange={(event) =>
                workspace.setSendConfirmed(event.target.checked)
              }
            />
            {t("lifeopsworkspace.confirmSendGmailReply", {
              defaultValue: "Confirm sending this Gmail reply now",
            })}
          </label>

          {workspace.draft ? (
            <div className="text-xs text-muted">
              {t("lifeopsworkspace.gmailDraftCreatedNoAutoSend", {
                defaultValue:
                  "Draft created. It will not send until you confirm and press Send.",
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {workspace.gmailRecommendations ? (
        <GmailRecommendationsPanel workspace={workspace} t={t} />
      ) : null}
    </div>
  );
}

export function LifeOpsWorkspaceView() {
  const { t } = useApp();
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
  const [calendarWindow, setCalendarWindow] = useState<CalendarWindow>("today");
  const owner = useLifeOpsSideWorkspace({
    side: "owner",
    calendarWindow,
    timeZone,
  });
  const agent = useLifeOpsSideWorkspace({
    side: "agent",
    calendarWindow,
    timeZone,
  });
  const workspaceReady = owner.connected && agent.connected;

  if (!workspaceReady) {
    return (
      <div className="space-y-6">
        <LockedSection
          title={t("lifeopsworkspace.calendar", {
            defaultValue: "Calendar",
          })}
          hint={t("lifeopsworkspace.calendarLockedHint", {
            defaultValue:
              "Connect Google for both User and Agent in Setup above to see today's events and create new ones here.",
          })}
          owner={owner}
          agent={agent}
          t={t}
        />
        <LockedSection
          title={t("lifeopsworkspace.email", {
            defaultValue: "Email",
          })}
          hint={t("lifeopsworkspace.emailLockedHint", {
            defaultValue:
              "Connect Google for both User and Agent in Setup above to triage replies and draft responses here.",
          })}
          owner={owner}
          agent={agent}
          t={t}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionShell
        title={t("lifeopsworkspace.calendar", {
          defaultValue: "Calendar",
        })}
        actions={
          <SegmentedControl<CalendarWindow>
            aria-label={t("lifeopsworkspace.calendarWindow", {
              defaultValue: "Calendar window",
            })}
            value={calendarWindow}
            onValueChange={setCalendarWindow}
            items={[
              {
                value: "today",
                label: t("lifeopsworkspace.today", {
                  defaultValue: "Today",
                }),
              },
              {
                value: "week",
                label: t("lifeopsworkspace.week", {
                  defaultValue: "Week",
                }),
              },
            ]}
            className="border-border/28 bg-card/24 p-0.5"
            buttonClassName="min-h-8 px-3 py-1.5 text-xs"
          />
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <CalendarColumn workspace={owner} timeZone={timeZone} t={t} />
          <CalendarColumn workspace={agent} timeZone={timeZone} t={t} />
        </div>
      </SectionShell>

      <SectionShell
        title={t("lifeopsworkspace.email", {
          defaultValue: "Email",
        })}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <EmailColumn workspace={owner} timeZone={timeZone} t={t} />
          <EmailColumn workspace={agent} timeZone={timeZone} t={t} />
        </div>
      </SectionShell>
    </div>
  );
}
