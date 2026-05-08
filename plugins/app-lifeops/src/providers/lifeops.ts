import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { hasLifeOpsAccess } from "../actions/lifeops-google-helpers.js";
import type {
  LifeOpsGmailTriageSummary,
  LifeOpsGoalDefinition,
  LifeOpsNextCalendarEventContext,
} from "../contracts/index.js";
import {
  type LifeOpsOwnerProfile,
  readLifeOpsOwnerProfile,
} from "../lifeops/owner-profile.js";
import {
  canSurfaceConnectorAccountData,
  connectorAccountPrivacyKey,
  createLifeOpsEgressContext,
  deriveConnectorAccountIdFromGrant,
  mapConnectorAccountPrivacyPolicies,
  redactTextForEgress,
} from "../lifeops/privacy-egress.js";
import { LifeOpsService } from "../lifeops/service.js";

const INTERNAL_URL = new URL("http://127.0.0.1/");
const GOAL_TITLE_MAX_LENGTH = 80;
const GOAL_TITLES_MAX_DISPLAYED = 5;
const MAX_ACCOUNT_LINES = 5;

function formatCount(label: string, count: number): string {
  return `${label}: ${count}`;
}

function truncateGoalTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= GOAL_TITLE_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, GOAL_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

function readGoalReviewedAt(goal: LifeOpsGoalDefinition): string | null {
  const metadata = goal.metadata;
  if (metadata && typeof metadata === "object") {
    const computed = (metadata as Record<string, unknown>).computedGoalReview;
    if (computed && typeof computed === "object") {
      const reviewedAt = (computed as Record<string, unknown>).reviewedAt;
      if (typeof reviewedAt === "string" && reviewedAt.length > 0) {
        return reviewedAt;
      }
    }
  }
  return null;
}

function formatRelativePast(fromIso: string, now: Date): string {
  const fromMs = new Date(fromIso).getTime();
  if (!Number.isFinite(fromMs)) {
    return "unknown";
  }
  const deltaMs = now.getTime() - fromMs;
  if (deltaMs < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo ago`;
  }
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function summarizeActiveGoals(
  goals: LifeOpsGoalDefinition[],
  now: Date,
): string[] {
  const active = goals.filter((goal) => goal.status === "active");
  if (active.length === 0) {
    return [];
  }
  const sorted = [...active].sort((left, right) => {
    const leftActivityIso = readGoalReviewedAt(left) ?? left.updatedAt;
    const rightActivityIso = readGoalReviewedAt(right) ?? right.updatedAt;
    const leftMs = new Date(leftActivityIso).getTime();
    const rightMs = new Date(rightActivityIso).getTime();
    const leftSafe = Number.isFinite(leftMs) ? leftMs : 0;
    const rightSafe = Number.isFinite(rightMs) ? rightMs : 0;
    return rightSafe - leftSafe;
  });
  const top = sorted.slice(0, GOAL_TITLES_MAX_DISPLAYED);
  const lines = top.map((goal) => {
    const reviewedAtIso = readGoalReviewedAt(goal);
    const lastReviewedFragment = reviewedAtIso
      ? `last reviewed ${formatRelativePast(reviewedAtIso, now)}`
      : "not yet reviewed";
    return `- ${truncateGoalTitle(goal.title)} (${goal.reviewState}, ${lastReviewedFragment})`;
  });
  if (active.length > top.length) {
    lines.push(`- (+${active.length - top.length} more active goals)`);
  }
  return lines;
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
    "Owner and agent only. Provides LifeOps overview plus live calendar and Gmail context. Route executable personal follow-through like todos, habits, goals, reminders, alarms, and live todo-status questions to LIFE; all owner calendar, scheduling, availability, and Calendly work to CALENDAR; all owner inbox and Gmail/email work to TRIAGE_MESSAGES; morning/night self-review flows to CHECKIN; stable owner profile or travel preferences only to PROFILE; subscription audits, cancellations, and cancellation-status checks to SUBSCRIPTIONS; meeting-prep and person-background briefs to RELATIONSHIP; travel booking to BOOK_TRAVEL; X/Twitter reads and search to X; fixed-duration or generic focus blocks to WEBSITE_BLOCK; task-gated focus blocks only to BLOCK_UNTIL_TASK_COMPLETE; browser-companion management to MANAGE_BROWSER_BRIDGE; browser tab control to BROWSER; password-manager field fill on a trusted site to AUTOFILL; pending approval decisions to RESOLVE_REQUEST. Available in private owner conversations, including Discord.",
  descriptionCompressed:
    "LifeOps overview, upcoming calendar, email triage. Owner only.",
  dynamic: true,
  position: 12,
  contexts: [
    "tasks",
    "calendar",
    "email",
    "contacts",
    "payments",
    "finance",
    "subscriptions",
    "health",
    "screen_time",
    "browser",
    "messaging",
  ],
  contextGate: {
    anyOf: [
      "tasks",
      "calendar",
      "email",
      "contacts",
      "payments",
      "finance",
      "subscriptions",
      "health",
      "screen_time",
      "browser",
      "messaging",
    ],
  },
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      return { text: "", values: {}, data: {} };
    }

    try {
      const service = new LifeOpsService(runtime);
      const ownerProfile = await readLifeOpsOwnerProfile(runtime);
      const overview = await service.getOverview();
      const egressContext = createLifeOpsEgressContext({
        isOwner: true,
        agentId: runtime.agentId,
        entityId: message.entityId,
      });
      let privacyPolicies = mapConnectorAccountPrivacyPolicies([]);
      try {
        privacyPolicies = mapConnectorAccountPrivacyPolicies(
          await service.repository.listConnectorAccountPrivacy(
            service.agentId(),
          ),
        );
      } catch (cause) {
        logger.debug(
          { err: cause },
          "[LifeOpsProvider] account privacy table unavailable — defaulting to owner-only context",
        );
      }
      const now = new Date();
      const ownerLines = summarizeOccurrences(
        "Owner active items:",
        overview.owner.occurrences,
      );
      const ownerGoalLines = summarizeActiveGoals(overview.owner.goals, now);
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
          for (const account of connectedAccounts.slice(0, MAX_ACCOUNT_LINES)) {
            const connectorAccountId = account.grant
              ? (account.grant.connectorAccountId ??
                deriveConnectorAccountIdFromGrant(account.grant))
              : null;
            const policy = connectorAccountId
              ? (privacyPolicies.get(
                  connectorAccountPrivacyKey("google", connectorAccountId),
                ) ?? null)
              : null;
            if (
              !canSurfaceConnectorAccountData({
                context: egressContext,
                provider: "google",
                connectorAccountId,
                dataClass: "metadata",
                policy,
              })
            ) {
              accountLines.push("- Google account hidden by privacy policy");
              continue;
            }
            const email = redactTextForEgress(
              String(
                (account.identity as Record<string, unknown> | null)?.email ??
                  "unknown",
              ),
              { context: egressContext, dataClass: "metadata", policy },
            );
            accountLines.push(
              `- ${email} (connectorAccountId: ${connectorAccountId ?? "unknown"})`,
            );
          }
        }

        const status = connectedAccounts[0];
        if (status?.connected) {
          const connectorAccountId = status.grant
            ? (status.grant.connectorAccountId ??
              deriveConnectorAccountIdFromGrant(status.grant))
            : null;
          const policy = connectorAccountId
            ? (privacyPolicies.get(
                connectorAccountPrivacyKey("google", connectorAccountId),
              ) ?? null)
            : null;
          const capabilities = status.grantedCapabilities ?? [];
          const hasCalendar = capabilities.some((c) =>
            c.startsWith("google.calendar"),
          );
          const hasGmail = capabilities.some((c) =>
            c.startsWith("google.gmail"),
          );

          if (hasCalendar) {
            if (
              !canSurfaceConnectorAccountData({
                context: egressContext,
                provider: "google",
                connectorAccountId,
                dataClass: "snippet",
                policy,
              })
            ) {
              calendarLines.push("Calendar context hidden by privacy policy.");
            } else {
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
          }

          if (hasGmail) {
            if (
              !canSurfaceConnectorAccountData({
                context: egressContext,
                provider: "google",
                connectorAccountId,
                dataClass: "metadata",
                policy,
              })
            ) {
              emailLines.push("Gmail context hidden by privacy policy.");
            } else {
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
          "Use LIFE for executable personal follow-through: todos, habits, goals, reminders, alarms, escalation, and live status questions like 'what's on my todo list today?'. Examples: 'add a todo', 'remember to call mom on Sunday', 'track my gym sessions three times a week', 'set a goal to save $5,000'. Do not use REPLY, UPDATE_ENTITY, or PROFILE for these.",
          "Use CALENDAR for live calendar reads, calendar writes, availability, proposed meeting times, scheduling preferences, and scheduling negotiation. Examples: 'what's my next meeting?', 'show me my calendar for today', 'what does my week look like?', 'schedule a dentist appointment next Tuesday at 3pm', 'find meeting options with Alice', or 'protect my sleep window from calls'. Do not answer these from provider context alone.",
          "Use TRIAGE_MESSAGES for Gmail, email, and cross-channel inbox review: 'triage my Gmail inbox', 'summarize my unread emails', 'triage my inbox', 'give me my inbox digest', daily briefs, missed-call repair, and group-chat handoff. Use DRAFT_REPLY when the owner asks to draft a reply to an existing message, RESPOND_TO_MESSAGE when the owner asks to send/respond to an existing message, and MANAGE_MESSAGE for unsubscribe, block, archive, trash, spam, label, or mark-read requests. Do not use TRIAGE_MESSAGES just because the user mentioned email or messages while venting.",
          "Use SEND_DRAFT for owner-scoped outbound messages and drafts on the owner's behalf. Examples: 'send a Telegram message to Jane saying I am running late', 'send a Signal message to Priya saying thanks', 'email alice@example.com the notes', 'DM Bob on Discord', or 'text Sam that I am outside'. Always prefer SEND_DRAFT over CALENDAR for relaying a message, even if the message text mentions a meeting.",
          "Use PASSWORD_MANAGER for credential lookup and saved-login requests. Examples: 'look up my GitHub password', 'show me my saved logins for github.com', 'copy my AWS password to clipboard'. Do not surface raw secrets in chat.",
          "Use RELATIONSHIP for Rolodex contacts, follow-ups, and days-since-contact questions. Examples: 'who are my closest contacts?', 'remind me to follow up with David next week', 'how long has it been since I talked to David?'.",
          "Use SCREEN_TIME for quantitative device/app/website usage questions. Examples: 'how much screen time have I used today?', 'break down my screen time by app this week', 'what websites did I spend the most time on?'. If the owner is only reflecting or venting like 'I spend too much time on my phone', stay in chat instead of calling SCREEN_TIME.",
          "Use APP_BLOCK for phone app blocking requests. Examples: 'block all games on my phone until 6pm', 'block the Slack app while I focus on deep work'. Use WEBSITE_BLOCK for websites like reddit.com or youtube.com, not phone apps.",
          "Use SUBSCRIPTIONS for subscription audits, recurring membership reviews, cancellation requests, and cancellation-status checks. Examples: 'audit my subscriptions', 'cancel my Google Play subscription', 'unsubscribe from Netflix', 'what happened with that subscription cancellation?', 'cancel this subscription even if it needs sign-in first'. Use this instead of generic browser automation when the user is asking for subscription-specific work, and do not switch to TRIAGE_MESSAGES or SEND_DRAFT just because the cancellation flow needs login, MFA, or a human handoff.",
          "Route all meeting-time proposals, availability checks, durable scheduling rules, and explicit multi-turn scheduling negotiations through CALENDAR.",
          "Use PROFILE only for stable owner-only profile details and reusable travel-preference checklists. Do not use it for goals, todos, reminders, temporary plans, or live task state.",
          "Use X for X/Twitter reads and search: DMs, timeline, mentions, and topic search. Do not reply that X/Twitter access is unavailable when this action is available.",
          "Use WEBSITE_BLOCK for fixed-duration or generic focus blocks like 'block twitter and reddit for 2 hours' or 'turn on a focus block for all social media sites'. Use BLOCK_UNTIL_TASK_COMPLETE only when the unblock condition is finishing a task, workout, or todo, like 'block x.com until I finish my workout'.",
          "Use CHAT_THREAD for targeted connector chat mute/unmute when the owner names a Telegram/Discord/etc. room that is not the current chat, especially temporary mutes like 'mute the crypto signals Telegram group for 24 hours'. Do not fall back to generic MUTE_ROOM for named off-thread chat controls.",
          "Use DEVICE_INTENT for multi-device reminders, push ladders, document-signing nudges, updated-ID interventions, and device-level warnings. Examples: 'for important meetings, remind me an hour before, ten minutes before, and right when they start on both my Mac and my phone', 'if missing this could trigger a cancellation fee, warn me clearly and offer to handle it now', or 'if the only ID on file is expired, ask me for an updated copy so the workflow can continue'. Do not stay in REPLY just because the exact reservation, workflow item, or upload is still unspecified. Use COMPUTER_USE for portal uploads, Finder/Desktop work like taking screenshots or creating folders, browser workflows, and file-handling tasks on the owner's machine, including future instructions like 'when I send over the deck, upload it to the portal for me.'",
          "Use MANAGE_BROWSER_BRIDGE for installing/refreshing the Chrome/Safari companion extension and managing companion connection state ('open chrome extensions', 'reveal the bridge folder', 'refresh browser bridge'). Use BROWSER for tab control, navigation, clicks, typing, screenshots, and DOM reads — including LifeOps browser sessions like 'list my browser tabs' or 'navigate the work tab to gmail'.",
          "Use REMOTE_DESKTOP to start, list, check, end, or revoke a remote desktop session so the owner can connect from a phone. Requests like 'start a remote desktop session' or 'let me connect from my phone' belong here even if the action needs confirmation or a pairing step.",
          "Use RESOLVE_REQUEST when the owner is resolving a pending approval item. Examples: 'approve the pending travel booking request' or 'reject that pending approval request and say it needs changes'.",
          "Use VOICE_CALL for phone-call escalation or booking calls. These actions can draft or request confirmation first; they do not require the dial to happen on the first turn. Requests like 'if you get stuck in the browser or on my computer, call me and let me jump in to unblock it' belong here. Requests like 'call the dentist and reschedule my appointment' or 'phone my cable company about the outage' also belong to VOICE_CALL, not CALENDAR, LIFE, or SEND_DRAFT.",
          "When the owner is only making an observation or venting like 'my calendar has been crazy this quarter', 'I hate email', or 'I think I spend too much time on my phone', stay in REPLY instead of calling a LifeOps action unless they actually ask you to do something.",
          "Treat owner instructions phrased as standing policies, triggers, or conditionals like 'if this happens, do x' or 'when that arrives, handle it' as executable requests, not hypotheticals.",
          "When the owner clearly asks for one of these LifeOps executive-assistant operations, call the best-fit action instead of staying in advice-only chat. If details are missing, let the action ask the minimum follow-up question.",
          "Route examples: sleep/no-call windows -> CALENDAR; daily brief additions, missed-call repair, or group-chat handoff -> TRIAGE_MESSAGES; 'if direct relaying gets messy here, suggest making a group chat handoff instead' -> TRIAGE_MESSAGES; outbound Telegram/Signal/email/Discord/SMS drafts -> SEND_DRAFT; subscription audits or cancellations -> SUBSCRIPTIONS; travel preference memory -> PROFILE; clinic-doc reminders or multi-device meeting ladders -> DEVICE_INTENT; portal upload or browser filing -> COMPUTER_USE; if the agent gets stuck and should phone the owner -> VOICE_CALL.",
          "When the owner asks about their stable personal details for LifeOps, answer from the stored owner profile values below. If a field is not n/a, treat it as known instead of saying it is missing.",
          "Owner life-ops are private to the owner and the agent. Agent ops are internal and should stay separated unless explicitly requested.",
          ...summarizeOwnerProfile(ownerProfile),
          formatCount(
            "Owner open occurrences",
            overview.owner.summary.activeOccurrenceCount,
          ),
          formatCount(
            "Owner active goals",
            overview.owner.summary.activeGoalCount,
          ),
          ...ownerGoalLines,
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
          ownerActiveGoalTitles: overview.owner.goals
            .filter((goal) => goal.status === "active")
            .slice(0, GOAL_TITLES_MAX_DISPLAYED)
            .map((goal) => goal.title),
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
          overview: {
            ...overview,
            owner: {
              ...overview.owner,
              goals: overview.owner.goals.slice(0, GOAL_TITLES_MAX_DISPLAYED),
              occurrences: overview.owner.occurrences.slice(0, 5),
            },
            agentOps: {
              ...overview.agentOps,
              occurrences: overview.agentOps.occurrences.slice(0, 5),
            },
          },
          nextEventContext,
          gmailSummary,
        },
      };
    } catch (error) {
      return {
        text: "LifeOps overview unavailable.",
        values: { ownerOpenOccurrences: 0, ownerActiveGoals: 0 },
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};
