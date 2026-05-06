import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  ActionExample,
  ActionResult,
  IAgentRuntime,
  MessageRef,
  MessageSource,
} from "@elizaos/core";
import { getDefaultTriageService } from "@elizaos/core";
import { LifeOpsService } from "../lifeops/service.js";
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";
import {
  dayRange,
  formatCalendarFeed,
  INTERNAL_URL,
  toActionData,
} from "./lifeops-google-helpers.js";

const ACTION_NAME = "OWNER_DIGEST";

type DigestSubaction = "morning" | "evening";

type DigestParams = {
  subaction?: DigestSubaction;
  sinceMs?: number;
  tags?: string[];
  sources?: string[];
};

const SUBACTIONS: SubactionsMap<DigestSubaction> = {
  morning: {
    description:
      "Morning briefing: cross-channel messages from the last 12h, today's calendar, and overdue follow-ups.",
    descriptionCompressed:
      "morning briefing last-12h cross-channel messages + today calendar + overdue follow-ups + priority unread",
    required: [],
    optional: ["sinceMs", "tags", "sources"],
  },
  evening: {
    description:
      "Evening briefing: today's wins/sends + tomorrow's calendar + still-unanswered threads.",
    descriptionCompressed:
      "evening briefing today wins/sends + tomorrow calendar + still-unanswered",
    required: [],
    optional: ["tags", "sources"],
  },
};

const VALID_SOURCES: ReadonlySet<MessageSource> = new Set<MessageSource>([
  "gmail",
  "discord",
  "telegram",
  "twitter",
  "imessage",
  "signal",
  "whatsapp",
  "calendly",
  "browser_bridge",
]);

function normalizeSources(value: unknown): MessageSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: MessageSource[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim() as MessageSource;
    if (VALID_SOURCES.has(trimmed)) out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return out.length > 0 ? out : undefined;
}

function summarizeMessages(messages: MessageRef[]): string {
  if (messages.length === 0) return "(no recent messages)";
  return messages
    .slice(0, 12)
    .map((ref) => {
      const sender = ref.from.displayName ?? ref.from.identifier ?? "unknown";
      const subject = ref.subject ?? ref.snippet.slice(0, 80);
      return `- [${ref.source}] ${sender}: ${subject}`;
    })
    .join("\n");
}

async function runMorning(
  runtime: IAgentRuntime,
  params: DigestParams,
): Promise<ActionResult> {
  const triage = getDefaultTriageService();
  const sinceMs =
    typeof params.sinceMs === "number" && Number.isFinite(params.sinceMs)
      ? params.sinceMs
      : Date.now() - 12 * 60 * 60 * 1000;
  const sources = normalizeSources(params.sources);
  const tags = normalizeTags(params.tags);
  const messages = await triage.search(runtime, {
    sinceMs,
    sources,
    tags,
    limit: 50,
  });

  const service = new LifeOpsService(runtime);
  const today = dayRange(0);
  const calendar = await service.getCalendarFeed(INTERNAL_URL, {
    includeHiddenCalendars: true,
    timeMin: today.timeMin,
    timeMax: today.timeMax,
  });

  const overview = await service.getOverview();
  const nowMs = Date.now();
  const overdueFollowups = overview.occurrences.filter((occ) => {
    const due = Date.parse(occ.relevanceEndAt);
    return Number.isFinite(due) && due < nowMs && occ.state !== "completed";
  });

  const sections = {
    messages: messages.map((ref) => ({
      id: ref.id,
      source: ref.source,
      from: ref.from,
      subject: ref.subject ?? null,
      snippet: ref.snippet,
      receivedAtMs: ref.receivedAtMs,
      tags: ref.tags ?? [],
    })),
    calendar,
    followups: overdueFollowups,
  };

  const body = [
    `Morning briefing (since ${new Date(sinceMs).toISOString()})`,
    "",
    `Messages (${messages.length}):`,
    summarizeMessages(messages),
    "",
    "Today's calendar:",
    formatCalendarFeed(calendar, "today"),
    "",
    `Overdue follow-ups: ${overdueFollowups.length}`,
  ].join("\n");

  return {
    success: true,
    text: body,
    data: {
      ...toActionData({ sections }),
      actionName: ACTION_NAME,
      subaction: "morning",
    },
  };
}

async function runEvening(
  runtime: IAgentRuntime,
  params: DigestParams,
): Promise<ActionResult> {
  const triage = getDefaultTriageService();
  const startOfTodayMs = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const sources = normalizeSources(params.sources);
  const tags = normalizeTags(params.tags);
  const todaysMessages = await triage.search(runtime, {
    sinceMs: startOfTodayMs,
    sources,
    tags,
    limit: 100,
  });

  const service = new LifeOpsService(runtime);
  const tomorrow = dayRange(1);
  const tomorrowCalendar = await service.getCalendarFeed(INTERNAL_URL, {
    includeHiddenCalendars: true,
    timeMin: tomorrow.timeMin,
    timeMax: tomorrow.timeMax,
  });

  const unanswered = todaysMessages.filter(
    (ref) =>
      ref.triageScore?.suggestedAction === "respond-now" ||
      ref.triageScore?.suggestedAction === "respond-today",
  );

  const sections = {
    todaysMessages: todaysMessages.map((ref) => ({
      id: ref.id,
      source: ref.source,
      from: ref.from,
      subject: ref.subject ?? null,
      snippet: ref.snippet,
      receivedAtMs: ref.receivedAtMs,
    })),
    tomorrowCalendar,
    unanswered,
  };

  const body = [
    "Evening briefing",
    "",
    `Today's messages (${todaysMessages.length}):`,
    summarizeMessages(todaysMessages),
    "",
    "Tomorrow's calendar:",
    formatCalendarFeed(tomorrowCalendar, "tomorrow"),
    "",
    `Still unanswered: ${unanswered.length}`,
  ].join("\n");

  return {
    success: true,
    text: body,
    data: {
      ...toActionData({ sections }),
      actionName: ACTION_NAME,
      subaction: "evening",
    },
  };
}

export const ownerDigestAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "DAILY_BRIEF",
    "MORNING_BRIEF",
    "EVENING_BRIEF",
    "DAILY_DIGEST",
    "WHATS_GOING_ON",
  ],
  description:
    "Owner-only. Compose a daily briefing from cross-channel messages, today's calendar, recent relationships activity, and pending follow-ups. " +
    "Subactions: morning (start-of-day operating picture, defaults to last 12h messages + today's events + overdue follow-ups) | " +
    "evening (end-of-day picture: today's wins/replies + tomorrow's calendar). " +
    "Optional filter: by tag, source, sender, since.",
  descriptionCompressed:
    "daily briefing compose: morning(last12h-msgs today-events overdue-followups) evening(today-wins tomorrow-events) filter(tag source sender since) owner",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  parameters: [
    {
      name: "subaction",
      description: "morning | evening",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sinceMs",
      description:
        "Override the lookback window for morning briefings (ms epoch).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "tags",
      description: "Restrict messages to those bearing all of the given tags.",
      required: false,
      schema: { type: "array" as const },
    },
    {
      name: "sources",
      description:
        "Restrict messages to a subset of registered sources (gmail, twitter, calendly, ...).",
      required: false,
      schema: { type: "array" as const },
    },
  ],
  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Owner-only action.",
        data: { error: "PERMISSION_DENIED", actionName: ACTION_NAME },
      };
    }
    const resolved = await resolveActionArgs<DigestSubaction, DigestParams>({
      runtime,
      message,
      state,
      options,
      actionName: ACTION_NAME,
      subactions: SUBACTIONS,
      defaultSubaction: "morning",
    });
    if (!resolved.ok) {
      return {
        success: false,
        text: resolved.clarification,
        data: {
          actionName: ACTION_NAME,
          missing: resolved.missing,
          requiresClarification: true,
        },
      };
    }
    if (resolved.subaction === "morning") {
      return runMorning(runtime, resolved.params);
    }
    return runEvening(runtime, resolved.params);
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Give me my morning briefing." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Morning briefing assembled.",
          action: ACTION_NAME,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "End of day digest please." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Evening briefing assembled.",
          action: ACTION_NAME,
        },
      },
    ],
  ] as ActionExample[][],
};
