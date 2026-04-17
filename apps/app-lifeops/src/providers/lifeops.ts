import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  logger,
} from "@elizaos/core";
import type {
  LifeOpsGmailTriageSummary,
  LifeOpsNextCalendarEventContext,
} from "@elizaos/shared/contracts/lifeops";
import { hasLifeOpsAccess } from "../actions/lifeops-google-helpers.js";
import {
  type LifeOpsOwnerProfile,
  readLifeOpsOwnerProfile,
} from "../lifeops/owner-profile.js";
import { LifeOpsService } from "../lifeops/service.js";

const INTERNAL_URL = new URL("http://127.0.0.1/");

function formatCount(label: string, count: number): string {
  return `${label}: ${count}`;
}

function summarizeOccurrences(
  title: string,
  occurrences: Array<{ title: string; state: string }>,
): string[] {
  if (occurrences.length === 0) {
    return [];
  }
  return [
    title,
    ...occurrences
      .slice(0, 3)
      .map((occurrence) => `- ${occurrence.title} (${occurrence.state})`),
  ];
}

function formatRelativeMinutes(minutes: number): string {
  if (minutes <= 0) return "now";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = Math.round(minutes % 60);
  if (remaining === 0) return `${hours}h`;
  return `${hours}h ${remaining}m`;
}

function summarizeNextEvent(
  context: LifeOpsNextCalendarEventContext,
): string[] {
  if (!context.event) {
    return [];
  }
  const event = context.event;
  const timing =
    context.startsInMinutes !== null
      ? ` (${formatRelativeMinutes(context.startsInMinutes)})`
      : "";
  const lines = [`Next event: ${event.title}${timing}`];
  if (context.attendeeNames.length > 0) {
    lines.push(`  With: ${context.attendeeNames.slice(0, 3).join(", ")}`);
  }
  if (context.location) {
    lines.push(`  At: ${context.location}`);
  }
  return lines;
}

function summarizeGmailTriage(summary: LifeOpsGmailTriageSummary): string[] {
  const parts: string[] = [];
  if (summary.unreadCount > 0) parts.push(`${summary.unreadCount} unread`);
  if (summary.importantNewCount > 0)
    parts.push(`${summary.importantNewCount} important`);
  if (summary.likelyReplyNeededCount > 0)
    parts.push(`${summary.likelyReplyNeededCount} needing reply`);
  if (parts.length === 0) {
    return [];
  }
  return [`Inbox: ${parts.join(", ")}`];
}

function summarizeOwnerProfile(profile: LifeOpsOwnerProfile): string[] {
  return [
    `Owner profile: name=${profile.name} | relationship=${profile.relationshipStatus} | partner=${profile.partnerName} | orientation=${profile.orientation} | gender=${profile.gender} | age=${profile.age} | location=${profile.location} | travelPrefs=${profile.travelBookingPreferences}`,
  ];
}

export const lifeOpsProvider: Provider = {
  name: "lifeops",
  description:
    "Owner, explicitly granted users, and the agent only. Provides the current LifeOps overview, upcoming calendar event, and email triage summary. Use LIFE for habits, reminders, alarms, and goals. Use CALENDAR_ACTION for Google Calendar reads/search/create-event tasks. Use GMAIL_ACTION for Gmail triage, search, draft, and send flows. Use INBOX for cross-channel briefs, urgent-first inbox ranking, unread summaries, and reply workflow management. Use DOSSIER for pre-meeting prep briefs. Use PROPOSE_MEETING_TIMES when the user wants candidate slots or bundled meetings. Use UPDATE_MEETING_PREFERENCES for protected windows like sleep/no-call rules. Use UPDATE_OWNER_PROFILE to silently store stable travel or personal preferences when clearly stated. Use PUBLISH_DEVICE_INTENT for cross-device reminder ladders and device-level nudges. Use LIFEOPS_COMPUTER_USE for browser or portal tasks like uploads and form completion. Use CALL_USER or CALL_EXTERNAL for real phone-call escalation after explicit confirmation. Available in private owner or granted conversations, including Discord.",
  descriptionCompressed: "LifeOps overview, upcoming calendar, email triage. Owner/granted only.",
  dynamic: true,
  position: 12,
  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      return { text: "", values: {}, data: {} };
    }

    const service = new LifeOpsService(runtime);
    const ownerProfile = await readLifeOpsOwnerProfile(runtime);
    const overview = await service.getOverview();
    const ownerLines = summarizeOccurrences(
      "Owner active items:",
      overview.owner.occurrences,
    );
    const agentLines = summarizeOccurrences(
      "Agent ops:",
      overview.agentOps.occurrences,
    );

    const calendarLines: string[] = [];
    const emailLines: string[] = [];
    const accountLines: string[] = [];
    let nextEventContext: LifeOpsNextCalendarEventContext | null = null;
    let gmailSummary: LifeOpsGmailTriageSummary | null = null;

    try {
      const accounts = await service.getGoogleConnectorAccounts(INTERNAL_URL);
      const connectedAccounts = accounts.filter((a) => a.connected);

      if (connectedAccounts.length > 1) {
        accountLines.push("Available Google accounts:");
        for (const account of connectedAccounts) {
          const email =
            (account.identity as Record<string, unknown> | null)?.email ??
            "unknown";
          const grantId = account.grant?.id ?? "unknown";
          accountLines.push(`- ${email} (grantId: ${grantId})`);
        }
      }

      const status = connectedAccounts[0];
      if (status?.connected) {
        const capabilities = status.grantedCapabilities ?? [];
        const hasCalendar = capabilities.some((c) =>
          c.startsWith("google.calendar"),
        );
        const hasGmail = capabilities.some((c) => c.startsWith("google.gmail"));

        if (hasCalendar) {
          try {
            nextEventContext =
              await service.getNextCalendarEventContext(INTERNAL_URL);
            calendarLines.push(...summarizeNextEvent(nextEventContext));
          } catch (cause) {
            logger.warn(
              { err: cause },
              "[LifeOpsProvider] calendar fetch failed — omitting calendar context",
            );
            calendarLines.push(
              `Calendar connector degraded: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }

        if (hasGmail) {
          try {
            const triage = await service.getGmailTriage(INTERNAL_URL, {
              maxResults: 5,
            });
            gmailSummary = triage.summary;
            emailLines.push(...summarizeGmailTriage(triage.summary));
          } catch (cause) {
            logger.warn(
              { err: cause },
              "[LifeOpsProvider] gmail triage fetch failed — omitting email context",
            );
            emailLines.push(
              `Gmail connector degraded: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }
      }
    } catch (cause) {
      logger.debug(
        { err: cause },
        "[LifeOpsProvider] Google connector unavailable — skipping calendar/email context",
      );
      accountLines.push(
        `Google connector status unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    return {
      text: [
        "## Life Ops",
        "Use LIFE when the user wants to create, manage, complete, or query tasks, habits, goals, reminders, alarms, escalation, or routines.",
        "Use CALENDAR_ACTION for calendar questions, event search, next-event context, and creating Google Calendar events.",
        "Use GMAIL_ACTION for inbox triage, emails needing a reply, Gmail search, reply drafts, and confirmed send flows.",
        "Use INBOX for executive-assistant inbox work: daily briefs, urgent-vs-low ranking, unread summaries across channels, missed-call follow-up, and reply workflows.",
        "Use SEARCH_ACROSS_CHANNELS when the owner wants cross-platform context or a person/topic searched across Gmail, chat connectors, calendar, and memory.",
        "Use DOSSIER for meeting prep briefs, dossiers, itineraries with context, and pre-event briefing requests.",
        "Use PROPOSE_MEETING_TIMES when the request is to find options, bundle people into shared slots, or propose times without a fixed meeting already chosen.",
        "Use UPDATE_MEETING_PREFERENCES for durable scheduling rules like sleep windows, no-call hours, blackout windows, or preferred hours.",
        "Use UPDATE_OWNER_PROFILE to silently store stable owner-only profile details when the canonical owner clearly reveals them. This includes reusable travel-preference checklists for future bookings. Do not ask just to fill blanks.",
        "Use PUBLISH_DEVICE_INTENT for multi-device reminders, push ladders, document-signing nudges, and device-level warnings. Use LIFEOPS_COMPUTER_USE for portal uploads, browser workflows, and file-handling tasks on the owner's machine.",
        "Use CALL_USER or CALL_EXTERNAL for phone-call escalation or booking calls. These actions can draft or request confirmation first; they do not require the dial to happen on the first turn.",
        "Treat owner instructions phrased as standing policies, triggers, or conditionals like 'if this happens, do x' or 'when that arrives, handle it' as executable requests, not hypotheticals.",
        "When the owner clearly asks for one of these LifeOps executive-assistant operations, call the best-fit action instead of staying in advice-only chat. If details are missing, let the action ask the minimum follow-up question.",
        "Route examples: sleep/no-call windows -> UPDATE_MEETING_PREFERENCES; daily brief additions, missed-call repair, or group-chat handoff -> INBOX; travel preference memory -> UPDATE_OWNER_PROFILE; clinic-doc reminders or multi-device meeting ladders -> PUBLISH_DEVICE_INTENT; portal upload or browser filing -> LIFEOPS_COMPUTER_USE; if the agent gets stuck and should phone the owner -> CALL_USER.",
        "When the owner asks about their stable personal details for LifeOps, answer from the stored owner profile values below. If a field is not n/a, treat it as known instead of saying it is missing.",
        "Owner life-ops are private to the owner, explicitly granted users, and the agent. Agent ops are internal and should stay separated unless explicitly requested.",
        ...summarizeOwnerProfile(ownerProfile),
        formatCount(
          "Owner open occurrences",
          overview.owner.summary.activeOccurrenceCount,
        ),
        formatCount(
          "Owner active goals",
          overview.owner.summary.activeGoalCount,
        ),
        formatCount(
          "Owner live reminders",
          overview.owner.summary.activeReminderCount,
        ),
        ...ownerLines,
        ...accountLines,
        ...calendarLines,
        ...emailLines,
        formatCount(
          "Agent open occurrences",
          overview.agentOps.summary.activeOccurrenceCount,
        ),
        formatCount(
          "Agent active goals",
          overview.agentOps.summary.activeGoalCount,
        ),
        ...agentLines,
      ].join("\n"),
      values: {
        ownerOpenOccurrences: overview.owner.summary.activeOccurrenceCount,
        ownerActiveGoals: overview.owner.summary.activeGoalCount,
        ownerProfileName: ownerProfile.name,
        ownerRelationshipStatus: ownerProfile.relationshipStatus,
        ownerPartnerName: ownerProfile.partnerName,
        ownerOrientation: ownerProfile.orientation,
        ownerGender: ownerProfile.gender,
        ownerAge: ownerProfile.age,
        ownerLocation: ownerProfile.location,
        agentOpenOccurrences: overview.agentOps.summary.activeOccurrenceCount,
        agentActiveGoals: overview.agentOps.summary.activeGoalCount,
      },
      data: {
        ownerProfile,
        overview,
        nextEventContext,
        gmailSummary,
      },
    };
  },
};
