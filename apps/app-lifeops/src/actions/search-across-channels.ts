/**
 * SEARCH_ACROSS_CHANNELS action (WS1).
 *
 * LLM-driven param extraction (no regex, no English-only keyword
 * matching) — feeds runCrossChannelSearch() and returns a clipboard-ready
 * payload citing the source platform + room + timestamp for each hit.
 * Use this for cross-channel brief/context requests when the owner wants
 * one person or topic searched across Gmail, chat connectors, calendar,
 * and memory.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { ModelType, logger, parseJSONObjectFromText } from "@elizaos/core";
import { hasAdminAccess } from "@elizaos/agent";
import { getRecentMessagesData } from "@elizaos/shared/recent-messages-state";
import {
  type CrossChannelSearchChannel,
  CROSS_CHANNEL_SEARCH_CHANNELS,
  type CrossChannelSearchHit,
  type CrossChannelSearchPersonRef,
  type CrossChannelSearchQuery,
  type CrossChannelSearchResult,
  type CrossChannelSearchTimeWindow,
  runCrossChannelSearch,
} from "../lifeops/cross-channel-search.js";

const ACTION_NAME = "SEARCH_ACROSS_CHANNELS";

// ---------------------------------------------------------------------------
// Param shape
// ---------------------------------------------------------------------------

type SearchAcrossChannelsParams = {
  /** Direct query string. When omitted the LLM extracts from intent. */
  query?: string;
  /** Optional natural-language intent (used when query is missing). */
  intent?: string;
  /** Display name to focus the search on. Resolves to a canonical cluster. */
  person?: string;
  /** Pre-resolved canonical cluster primary entity id. */
  primaryEntityId?: UUID;
  /** Lower bound (ISO timestamp). */
  startIso?: string;
  /** Upper bound (ISO timestamp). */
  endIso?: string;
  /** Channel allowlist. */
  channels?: CrossChannelSearchChannel[];
  /** Per-channel hit cap. */
  limit?: number;
  /** Optional world scope. */
  worldId?: UUID;
};

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

type ExtractedSearchPlan = {
  query: string | null;
  person: string | null;
  startIso: string | null;
  endIso: string | null;
  channels: CrossChannelSearchChannel[] | null;
  shouldAct: boolean;
  clarification: string | null;
};

function isCrossChannelSearchChannel(
  value: unknown,
): value is CrossChannelSearchChannel {
  return (
    typeof value === "string" &&
    (CROSS_CHANNEL_SEARCH_CHANNELS as readonly string[]).includes(value)
  );
}

function recentTexts(state: State | undefined, limit = 8): string[] {
  const out: string[] = [];
  for (const item of getRecentMessagesData(state)) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!content || typeof content !== "object") continue;
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      out.push(text.trim());
    }
  }
  return out.slice(-limit);
}

function messageText(message: Memory): string {
  const text = message.content?.text;
  return typeof text === "string" ? text.trim() : "";
}

async function extractSearchPlan(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: SearchAcrossChannelsParams,
): Promise<ExtractedSearchPlan> {
  // If caller already provided a concrete query, trust it.
  if (params.query && params.query.trim()) {
    return {
      query: params.query.trim(),
      person: params.person ?? null,
      startIso: params.startIso ?? null,
      endIso: params.endIso ?? null,
      channels:
        params.channels && params.channels.length > 0 ? params.channels : null,
      shouldAct: true,
      clarification: null,
    };
  }

  if (typeof runtime.useModel !== "function") {
    return {
      query: null,
      person: null,
      startIso: null,
      endIso: null,
      channels: null,
      shouldAct: false,
      clarification:
        "Cross-channel search planning is unavailable right now — tell me what to search for.",
    };
  }

  const intent = (params.intent ?? messageText(message)).trim();
  const nowIso = new Date().toISOString();
  const channelList = CROSS_CHANNEL_SEARCH_CHANNELS.join(", ");

  const prompt = [
    "Plan a SEARCH_ACROSS_CHANNELS request.",
    "The user may speak in any language. Do NOT translate the search query — keep the user's wording.",
    "Return ONLY valid JSON with exactly these fields:",
    '{"query":"string|null","person":"string|null","startIso":"ISO8601|null","endIso":"ISO8601|null","channels":["gmail"|"telegram"|"discord"|"imessage"|"whatsapp"|"signal"|"calendly"|"calendar"|"memory"]|null,"shouldAct":true|false,"clarification":"string|null"}',
    "",
    "Rules:",
    "- query: the substantive search phrase (entity, topic, keywords). Strip filler like 'find', 'search for', 'show me'.",
    "- person: a named individual the search should focus on, or null.",
    "- startIso / endIso: an ISO time window if the request specifies one (e.g. 'this week', 'yesterday', 'in March'). Otherwise null.",
    `- Reference time: ${nowIso}.`,
    "- channels: only set when the user explicitly limits the search to specific platforms.",
    `- Allowed channel values: ${channelList}.`,
    "- shouldAct: false ONLY if the request is too vague to derive a query.",
    "- clarification: when shouldAct is false, ask the minimum clarifying question in the user's language.",
    "",
    `Current request: ${JSON.stringify(intent)}`,
    `Recent conversation: ${JSON.stringify(recentTexts(state).join("\n"))}`,
  ].join("\n");

  const raw = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
  const text = typeof raw === "string" ? raw : "";
  const parsed = parseJSONObjectFromText(text) as
    | Record<string, unknown>
    | null;

  if (!parsed) {
    return {
      query: null,
      person: null,
      startIso: null,
      endIso: null,
      channels: null,
      shouldAct: false,
      clarification:
        "I couldn't parse a search query from that — what should I look up?",
    };
  }

  const query =
    typeof parsed.query === "string" && parsed.query.trim()
      ? parsed.query.trim()
      : null;
  const person =
    typeof parsed.person === "string" && parsed.person.trim()
      ? parsed.person.trim()
      : null;
  const startIso =
    typeof parsed.startIso === "string" && parsed.startIso.trim()
      ? parsed.startIso.trim()
      : null;
  const endIso =
    typeof parsed.endIso === "string" && parsed.endIso.trim()
      ? parsed.endIso.trim()
      : null;
  const channels = Array.isArray(parsed.channels)
    ? (parsed.channels.filter(
        isCrossChannelSearchChannel,
      ) as CrossChannelSearchChannel[])
    : null;
  const shouldAct =
    typeof parsed.shouldAct === "boolean" ? parsed.shouldAct : query !== null;
  const clarification =
    typeof parsed.clarification === "string" && parsed.clarification.trim()
      ? parsed.clarification.trim()
      : null;

  return {
    query,
    person,
    startIso,
    endIso,
    channels: channels && channels.length > 0 ? channels : null,
    shouldAct,
    clarification,
  };
}

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

function formatHitForClipboard(hit: CrossChannelSearchHit, index: number): string {
  const subjectPart = hit.subject ? ` ${hit.subject}` : "";
  const ts = hit.timestamp.slice(0, 19);
  const body = hit.text.replace(/\s+/g, " ").trim().slice(0, 240);
  return `${String(index + 1).padStart(3, " ")} | [${hit.channel}] ${
    hit.citation.label
  } (${ts}) ${hit.speaker}:${subjectPart} ${body}`;
}

function formatResult(result: CrossChannelSearchResult): string {
  const lines: string[] = [];
  lines.push(
    `Cross-channel search for "${result.query}" — ${result.hits.length} hits across ${result.channelsWithHits.length} channels`,
  );
  lines.push("─".repeat(60));
  result.hits.forEach((hit, idx) => {
    lines.push(formatHitForClipboard(hit, idx));
  });
  if (result.unsupported.length > 0) {
    lines.push("");
    lines.push("Unsupported channels (no native search adapter):");
    for (const u of result.unsupported) {
      lines.push(`  - ${u.channel}: ${u.reason}`);
    }
  }
  if (result.degraded.length > 0) {
    lines.push("");
    lines.push("Degraded channels:");
    for (const d of result.degraded) {
      lines.push(`  - ${d.channel}: ${d.reason}`);
    }
  }
  lines.push("");
  lines.push(
    "To save relevant results to clipboard, use CLIPBOARD_WRITE with the line range.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const searchAcrossChannelsAction: Action = {
  name: ACTION_NAME,
  similes: [
    "CROSS_CHANNEL_SEARCH",
    "SEARCH_ALL_CHANNELS",
    "SEARCH_EVERYWHERE",
    "FIND_ACROSS_PLATFORMS",
  ],
  description:
    "Search across every connected channel — Gmail, Telegram, Discord, " +
    "iMessage, WhatsApp, Signal, X DMs, Calendly — plus agent memory. " +
    "Returns merged hits with citations to source platform, room, and " +
    "timestamp. Connectors without native search emit typed unsupported " +
    "markers (no fabricated results). Admin/owner only.",
  descriptionCompressed:
    "Cross-channel search with citations. Admin only.",

  validate: async (runtime, message) => hasAdminAccess(runtime, message),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: HandlerOptions | undefined,
  ): Promise<ActionResult> => {
    if (!(await hasAdminAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner or admins may search across channels.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as SearchAcrossChannelsParams;

    const plan = await extractSearchPlan(runtime, message, state, params);
    if (!plan.shouldAct || !plan.query) {
      return {
        text:
          plan.clarification ??
          "What do you want me to search for across your channels?",
        success: true,
        values: {
          success: true,
          noop: true,
        },
        data: {
          actionName: ACTION_NAME,
          noop: true,
        },
      };
    }

    const personRef: CrossChannelSearchPersonRef | undefined = (() => {
      if (params.primaryEntityId) {
        return {
          primaryEntityId: params.primaryEntityId,
          displayName: plan.person ?? params.person ?? undefined,
        };
      }
      const display = plan.person ?? params.person;
      return display ? { displayName: display } : undefined;
    })();

    const timeWindow: CrossChannelSearchTimeWindow | undefined = (() => {
      const startIso = plan.startIso ?? params.startIso;
      const endIso = plan.endIso ?? params.endIso;
      if (!startIso && !endIso) return undefined;
      return {
        startIso: startIso ?? undefined,
        endIso: endIso ?? undefined,
      };
    })();

    const query: CrossChannelSearchQuery = {
      query: plan.query,
      personRef,
      timeWindow,
      channels: plan.channels ?? params.channels,
      worldId: params.worldId,
      limit: params.limit,
    };

    try {
      const result = await runCrossChannelSearch(runtime, query);
      const formatted = formatResult(result);
      return {
        text: formatted,
        success: true,
        values: {
          success: true,
          hitCount: result.hits.length,
          unsupportedCount: result.unsupported.length,
          degradedCount: result.degraded.length,
          channelsWithHits: result.channelsWithHits,
        },
        data: {
          actionName: ACTION_NAME,
          query: result.query,
          hits: result.hits.map((hit, idx) => ({
            line: idx + 1,
            channel: hit.channel,
            id: hit.id,
            sourceRef: hit.sourceRef,
            speaker: hit.speaker,
            timestamp: hit.timestamp,
            subject: hit.subject,
            text: hit.text,
            citation: hit.citation,
          })),
          unsupported: result.unsupported,
          degraded: result.degraded,
          channelsWithHits: result.channelsWithHits,
          resolvedPerson: result.resolvedPerson
            ? {
                primaryEntityId: result.resolvedPerson.primaryEntityId,
                displayName: result.resolvedPerson.displayName,
              }
            : null,
        },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[${ACTION_NAME}] Search failed: ${errMsg}`);
      return {
        text: `Cross-channel search failed: ${errMsg}`,
        success: false,
        values: { success: false, error: "SEARCH_FAILED" },
        data: { actionName: ACTION_NAME, query: plan.query },
      };
    }
  },

  parameters: [
    {
      name: "query",
      description:
        "Exact search phrase. When omitted, the LLM extracts a query from `intent`.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description:
        "Natural-language description of what to search for. Multilingual.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "person",
      description:
        "Display name of the person to focus the search on. Resolves via the relationships graph when available.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "primaryEntityId",
      description: "Pre-resolved canonical cluster primary entity id (UUID).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "startIso",
      description: "Lower-bound timestamp (ISO 8601). Optional.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "endIso",
      description: "Upper-bound timestamp (ISO 8601). Optional.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "channels",
      description:
        "Channel allowlist. Allowed values: gmail, memory, telegram, discord, imessage, whatsapp, signal, calendly, calendar.",
      required: false,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "limit",
      description: "Per-channel hit cap (default 10).",
      required: false,
      schema: { type: "number" as const },
    },
  ],
};
