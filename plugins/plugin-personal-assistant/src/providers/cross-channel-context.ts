/**
 * cross-channel-context provider (WS1).
 *
 * When the planner's signal detector flags the current turn as involving
 * a named person or a topic worth pulling prior signal for, this
 * provider injects the top-N cross-channel hits into context. It never
 * fires on empty signal and never silently returns stale data.
 *
 * Signal sources (in priority order):
 *   1. Explicit state key `crossChannelContextRequest` — set by actions
 *      or the planner when they already know what to fetch.
 *   2. Structured hint in state.data.cross_channel_context_key.
 *
 * When neither signal is present, the provider returns EMPTY rather
 * than running a speculative search on every turn.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
  UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  CROSS_CHANNEL_SEARCH_CHANNELS,
  type CrossChannelSearchChannel,
  type CrossChannelSearchHit,
  type CrossChannelSearchQuery,
  runCrossChannelSearch,
} from "../lifeops/cross-channel-search.js";
import {
  createLifeOpsEgressContext,
  type LifeOpsEgressContext,
  redactTextForEgress,
  redactUrlForEgress,
} from "../lifeops/privacy-egress.js";

const EMPTY: ProviderResult = {
  text: "",
  values: { crossChannelHits: 0 },
  data: {},
};

const DEFAULT_INJECT_LIMIT = 5;
const DEFAULT_PER_CHANNEL = 4;

export type CrossChannelContextRequest = {
  query: string;
  person?: string;
  primaryEntityId?: UUID;
  startIso?: string;
  endIso?: string;
  channels?: CrossChannelSearchChannel[];
  limit?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCrossChannel(value: unknown): value is CrossChannelSearchChannel {
  return (
    typeof value === "string" &&
    (CROSS_CHANNEL_SEARCH_CHANNELS as readonly string[]).includes(value)
  );
}

function pickRequestFromState(
  state: State | undefined,
): CrossChannelContextRequest | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const stateRecord = state as Record<string, unknown>;
  const direct = stateRecord.crossChannelContextRequest;
  if (isRecord(direct) && typeof direct.query === "string") {
    return normalizeRequest(direct);
  }

  const data = isRecord(stateRecord.data) ? stateRecord.data : null;
  if (data && isRecord(data.cross_channel_context_key)) {
    return normalizeRequest(data.cross_channel_context_key);
  }
  return null;
}

function normalizeRequest(
  raw: Record<string, unknown>,
): CrossChannelContextRequest | null {
  const query = typeof raw.query === "string" ? raw.query.trim() : "";
  if (!query) return null;

  const person =
    typeof raw.person === "string" && raw.person.trim()
      ? raw.person.trim()
      : undefined;
  const primaryEntityId =
    typeof raw.primaryEntityId === "string" && raw.primaryEntityId.trim()
      ? (raw.primaryEntityId.trim() as UUID)
      : undefined;
  const startIso =
    typeof raw.startIso === "string" && raw.startIso.trim()
      ? raw.startIso.trim()
      : undefined;
  const endIso =
    typeof raw.endIso === "string" && raw.endIso.trim()
      ? raw.endIso.trim()
      : undefined;
  const channels = Array.isArray(raw.channels)
    ? (raw.channels.filter(isCrossChannel) as CrossChannelSearchChannel[])
    : undefined;
  const limit =
    typeof raw.limit === "number" && Number.isFinite(raw.limit)
      ? raw.limit
      : undefined;

  return {
    query,
    person,
    primaryEntityId,
    startIso,
    endIso,
    channels: channels && channels.length > 0 ? channels : undefined,
    limit,
  };
}

function compactHit(
  hit: CrossChannelSearchHit,
  egressContext: LifeOpsEgressContext,
) {
  const citation: Record<string, string> = {
    platform: hit.citation.platform,
    label: hit.citation.label,
  };
  const citationUrl = redactUrlForEgress(hit.citation.url, {
    context: egressContext,
  });
  if (citationUrl) {
    citation.url = citationUrl;
  }
  return {
    channel: hit.channel,
    id: hit.id,
    sourceRef: hit.sourceRef,
    timestamp: hit.timestamp,
    speaker: hit.speaker,
    ...(hit.subject ? { subject: hit.subject } : {}),
    text: redactTextForEgress(
      hit.text.replace(/\s+/g, " ").trim().slice(0, 180),
      {
        context: egressContext,
        dataClass: "body",
      },
    ),
    citation,
  };
}

function renderCrossChannelContextJson(args: {
  query: string;
  hits: CrossChannelSearchHit[];
  unsupported: unknown[];
  degraded: unknown[];
  channelsWithHits: CrossChannelSearchChannel[];
  egressContext: LifeOpsEgressContext;
}): string {
  return JSON.stringify({
    cross_channel_context: {
      query: args.query,
      hitCount: args.hits.length,
      unsupportedCount: args.unsupported.length,
      degradedCount: args.degraded.length,
      channelsWithHits: args.channelsWithHits,
      hits: args.hits.map((hit) => compactHit(hit, args.egressContext)),
    },
  });
}

export const crossChannelContextProvider: Provider = {
  name: "crossChannelContext",
  description:
    "Injects cross-channel hits (Gmail + agent memory + optional WS3 " +
    "cluster fan-out) when the turn carries an explicit " +
    "crossChannelContextRequest signal identifying a query or person. " +
    "Owner only. Silent on turns without signal.",
  descriptionCompressed:
    "Top cross-channel hits for a signaled person/topic. Owner only.",
  dynamic: true,
  // After inboxTriage (14) and before escalation (15).
  position: 14.5,
  contexts: ["email", "messaging", "contacts", "memory"],
  contextGate: { anyOf: ["email", "messaging", "contacts", "memory"] },
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
  ): Promise<ProviderResult> {
    if (!(await hasOwnerAccess(runtime, message))) {
      return EMPTY;
    }
    const egressContext = createLifeOpsEgressContext({
      isOwner: true,
      agentId: runtime.agentId,
      entityId: message.entityId,
    });

    const request = pickRequestFromState(state);
    if (!request) {
      return EMPTY;
    }

    const personRef = (() => {
      if (request.primaryEntityId) {
        return {
          primaryEntityId: request.primaryEntityId,
          displayName: request.person,
        };
      }
      if (request.person) {
        return { displayName: request.person };
      }
      return undefined;
    })();

    const timeWindow =
      request.startIso || request.endIso
        ? { startIso: request.startIso, endIso: request.endIso }
        : undefined;

    const query: CrossChannelSearchQuery = {
      query: request.query,
      personRef,
      timeWindow,
      channels: request.channels,
      limit: request.limit ?? DEFAULT_PER_CHANNEL,
    };

    try {
      const result = await runCrossChannelSearch(runtime, query);
      const injected = result.hits.slice(
        0,
        request.limit ?? DEFAULT_INJECT_LIMIT,
      );

      if (injected.length === 0) {
        return {
          text: "",
          values: {
            crossChannelHits: 0,
            crossChannelUnsupported: result.unsupported.length,
            crossChannelDegraded: result.degraded.length,
          },
          data: {
            crossChannelContext: {
              query: result.query,
              hits: [],
              unsupported: result.unsupported,
              degraded: result.degraded,
            },
          },
        };
      }

      return {
        text: renderCrossChannelContextJson({
          query: result.query,
          hits: injected,
          unsupported: result.unsupported,
          degraded: result.degraded,
          channelsWithHits: result.channelsWithHits,
          egressContext,
        }),
        values: {
          crossChannelHits: injected.length,
          crossChannelUnsupported: result.unsupported.length,
          crossChannelDegraded: result.degraded.length,
          crossChannelChannels: result.channelsWithHits,
        },
        data: {
          crossChannelContext: {
            query: result.query,
            hits: injected.map((hit) => compactHit(hit, egressContext)),
            unsupported: result.unsupported,
            degraded: result.degraded,
            resolvedPerson: result.resolvedPerson
              ? {
                  primaryEntityId: result.resolvedPerson.primaryEntityId,
                  displayName: result.resolvedPerson.displayName,
                }
              : null,
          },
        },
      };
    } catch (err) {
      logger.warn(
        `[crossChannelContext] Skipped injection after error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return EMPTY;
    }
  },
};
