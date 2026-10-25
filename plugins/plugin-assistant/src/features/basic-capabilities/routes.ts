import type { ChannelTopicsService } from "@elizaos/core";
import type { Route } from "@elizaos/host/protocol";

function firstQueryValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
const CHANNEL_TOPICS_SEARCH_ROUTE: Route = {
  type: "GET",
  path: "/api/channel-topics/search",
  public: false,
  name: "channel-topics-search",
  description:
    "Search recent per-channel topics across all rooms; returns matching rooms ranked by relevance.",
  async routeHandler({ query: params, runtime }) {
    const query = firstQueryValue(params.q).trim();
    if (!query) {
      return {
        status: 400,
        body: { error: "query parameter 'q' is required" },
      };
    }
    const rawLimitStr = firstQueryValue(params.limit).trim();
    const limit = (() => {
      if (!rawLimitStr) return 20;
      if (!/^\d+$/.test(rawLimitStr)) return 20;
      const parsed = Number(rawLimitStr);
      return Number.isSafeInteger(parsed) && parsed > 0
        ? Math.min(parsed, 100)
        : 20;
    })();
    const svc = runtime.getService<ChannelTopicsService>("channel_topics");
    if (!svc || typeof svc.searchTopics !== "function") {
      return {
        status: 503,
        body: { error: "channel topics service unavailable", hits: [] },
      };
    }
    const hits = svc.searchTopics(query, limit);
    return { status: 200, body: { query, count: hits.length, hits } };
  },
};

export const basicCapabilityRoutes: Route[] = [
  CHANNEL_TOPICS_SEARCH_ROUTE,
  {
    type: "POST",
    path: "/api/turns/:roomId/abort",
    rawPath: true,
    name: "turn-abort",
    description: "Abort the active message-handler turn for a given room.",
    routeHandler: async ({ params, body, runtime }) => {
      const roomId = params.roomId;
      if (!roomId) return { status: 400, body: { error: "roomId required" } };
      const value =
        body && typeof body === "object"
          ? Reflect.get(body, "reason")
          : undefined;
      const reason =
        typeof value === "string" && value.length > 0
          ? value
          : "external_request";
      return {
        status: 200,
        body: {
          aborted: runtime.turnControllers.abortTurn(roomId, reason),
          roomId,
          reason,
        },
      };
    },
  },
  {
    type: "GET",
    path: "/api/turns/:roomId",
    rawPath: true,
    name: "turn-status",
    description: "Report whether a turn is active for the given room.",
    routeHandler: async ({ params, runtime }) => {
      const roomId = params.roomId;
      if (!roomId) return { status: 400, body: { error: "roomId required" } };
      return {
        status: 200,
        body: {
          roomId,
          active: runtime.turnControllers.hasActiveTurn(roomId),
          hasSignal: runtime.turnControllers.signalFor(roomId) !== null,
        },
      };
    },
  },
];
