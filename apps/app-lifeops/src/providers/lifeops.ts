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
    "Owner, explicitly granted users, and the agent only. Provides LifeOps overview plus live calendar and Gmail context. Route executable personal follow-through like todos, habits, goals, reminders, alarms, and live todo-status questions to LIFE; live schedule and event requests to CALENDAR_ACTION; Gmail and email-specific work to GMAIL_ACTION; cross-channel inbox triage, digests, and reply workflows to INBOX; subscription audits, cancellations, and cancellation-status checks to SUBSCRIPTIONS; meeting-prep and person-background briefs to DOSSIER; X/Twitter reads and search to X_READ; fixed-duration or generic focus blocks to BLOCK_WEBSITES; task-gated focus blocks only to BLOCK_UNTIL_TASK_COMPLETE; stable owner profile or travel preferences only to UPDATE_OWNER_PROFILE. Available in private owner or granted conversations, including Discord.",
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
        "Use LIFE for executable personal follow-through: todos, habits, goals, reminders, alarms, escalation, and live status questions like 'what's on my todo list today?'. Examples: 'add a todo', 'remember to call mom on Sunday', 'track my gym sessions three times a week', 'set a goal to save $5,000'. Do not use REPLY, UPDATE_ENTITY, or UPDATE_OWNER_PROFILE for these.",
        "Use CALENDAR_ACTION for live calendar reads and writes. Examples: 'what's my next meeting?', 'show me my calendar for today', 'what does my week look like?', 'schedule a dentist appointment next Tuesday at 3pm'. Do not answer these from provider context alone.",
        "Use GMAIL_ACTION for Gmail and email-specific work. Examples: 'triage my Gmail inbox', 'summarize my unread emails', 'draft a reply to Sarah's latest email', 'send a reply to the last email from finance'. If the request explicitly says Gmail, email, unread emails, sender, subject, or reply to an email, prefer GMAIL_ACTION over INBOX. If the owner is only venting or making an observation like 'I hate email', stay in chat instead of calling GMAIL_ACTION.",
        "Use INBOX for cross-channel executive-assistant inbox work: 'triage my inbox', 'give me my inbox digest', 'respond to the messages that need an answer in my inbox', daily briefs, drafts awaiting sign-off, missed-call repair, and group-chat handoff. If the request is Gmail-only, use GMAIL_ACTION instead. Do not use INBOX just because the user mentioned email or messages while venting.",
        "Use PASSWORD_MANAGER for credential lookup and saved-login requests. Examples: 'look up my GitHub password', 'show me my saved logins for github.com', 'copy my AWS password to clipboard'. Do not surface raw secrets in chat.",
        "Use RELATIONSHIP for Rolodex contacts, follow-ups, and days-since-contact questions. Examples: 'who are my closest contacts?', 'remind me to follow up with David next week', 'how long has it been since I talked to David?'.",
        "Use SCREEN_TIME for quantitative device/app/website usage questions. Examples: 'how much screen time have I used today?', 'break down my screen time by app this week', 'what websites did I spend the most time on?'. If the owner is only reflecting or venting like 'I spend too much time on my phone', stay in chat instead of calling SCREEN_TIME.",
        "Use BLOCK_APPS for phone app blocking requests. Examples: 'block all games on my phone until 6pm', 'block the Slack app while I focus on deep work'. Use BLOCK_WEBSITES for websites like reddit.com or youtube.com, not phone apps.",
        "Use SUBSCRIPTIONS for subscription audits, recurring membership reviews, cancellation requests, and cancellation-status checks. Examples: 'audit my subscriptions', 'cancel my Google Play subscription', 'unsubscribe from Netflix', 'what happened with that subscription cancellation?'. Use this instead of generic browser automation when the user is asking for subscription-specific work.",
        "Use SEARCH_ACROSS_CHANNELS when the owner wants cross-platform context or a person/topic searched across Gmail, chat connectors, calendar, and memory.",
        "Use DOSSIER for meeting-prep and person-background briefs. Examples: 'pull up a dossier on Satya Nadella', 'give me the background on the person I'm meeting next: Julia Chen', 'brief me for my next meeting'. Do not answer these from ENTITIES or memory alone when the user explicitly wants a brief or dossier.",
        "Use PROPOSE_MEETING_TIMES when the request is to find options, bundle people into shared slots, or propose times without a fixed meeting already chosen.",
        "Use UPDATE_MEETING_PREFERENCES for durable scheduling rules like sleep windows, no-call hours, blackout windows, or preferred hours.",
        "Use UPDATE_OWNER_PROFILE only for stable owner-only profile details and reusable travel-preference checklists. Do not use it for goals, todos, reminders, temporary plans, or live task state.",
        "Use X_READ for X/Twitter reads and search: DMs, timeline, mentions, and topic search. Do not reply that X/Twitter access is unavailable when this action is available.",
        "Use BLOCK_WEBSITES for fixed-duration or generic focus blocks like 'block twitter and reddit for 2 hours' or 'turn on a focus block for all social media sites'. Use BLOCK_UNTIL_TASK_COMPLETE only when the unblock condition is finishing a task, workout, or todo, like 'block x.com until I finish my workout'.",
        "Use PUBLISH_DEVICE_INTENT for multi-device reminders, push ladders, document-signing nudges, and device-level warnings. Use LIFEOPS_COMPUTER_USE for portal uploads, Finder/Desktop work like taking screenshots or creating folders, browser workflows, and file-handling tasks on the owner's machine.",
        "Use REMOTE_DESKTOP to start, list, check, or end a remote desktop session so the owner can connect from a phone. Requests like 'start a remote desktop session' or 'let me connect from my phone' belong here even if the action needs confirmation or a pairing step.",
        "Use CALL_USER or CALL_EXTERNAL for phone-call escalation or booking calls. These actions can draft or request confirmation first; they do not require the dial to happen on the first turn. Requests like 'call the dentist and reschedule my appointment' or 'phone my cable company about the outage' belong to CALL_EXTERNAL, not CALENDAR_ACTION, LIFE, or CROSS_CHANNEL_SEND.",
        "When the owner is only making an observation or venting like 'my calendar has been crazy this quarter', 'I hate email', or 'I think I spend too much time on my phone', stay in REPLY instead of calling a LifeOps action unless they actually ask you to do something.",
        "Treat owner instructions phrased as standing policies, triggers, or conditionals like 'if this happens, do x' or 'when that arrives, handle it' as executable requests, not hypotheticals.",
        "When the owner clearly asks for one of these LifeOps executive-assistant operations, call the best-fit action instead of staying in advice-only chat. If details are missing, let the action ask the minimum follow-up question.",
        "Route examples: sleep/no-call windows -> UPDATE_MEETING_PREFERENCES; daily brief additions, missed-call repair, or group-chat handoff -> INBOX; subscription audits or cancellations -> SUBSCRIPTIONS; travel preference memory -> UPDATE_OWNER_PROFILE; clinic-doc reminders or multi-device meeting ladders -> PUBLISH_DEVICE_INTENT; portal upload or browser filing -> LIFEOPS_COMPUTER_USE; if the agent gets stuck and should phone the owner -> CALL_USER.",
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
