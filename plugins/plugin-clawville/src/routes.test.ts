import type { AppPackageRouteContext } from "@elizaos/core";
import type { AppSessionActionResult, AppSessionState } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAppRoutes } from "./routes";

// ---------------------------------------------------------------------------
// Recorded-real ClawVille API shapes.
//
// Captured 2026-06-16 against the live public backend (https://api.clawville.world):
//   POST /api/agent/connect            → REAL_CONNECT
//   GET  /api/agent/:sessionId/perception → REAL_PERCEPTION (trimmed)
//   POST /api/agent/:sessionId/move    → { "error": "Unknown building: <id>" } (400)
//   POST /api/agent/:sessionId/chat    → { "success": true, "response": null }
//
// Note: the live perception buildingIds (e.g. "memory-rag", "agent-security")
// do NOT match the plugin's hardcoded BUILDINGS ids ("memory-vault",
// "security-fortress"). buildSessionState still parses the live shape correctly
// because it reads nearbyBuildings[0].buildingId/label verbatim. The NL router
// (buildMessageCommand) maps free text to the plugin's own ids; mismatch with
// the live ids is a separate, out-of-scope plugin bug (see summary).
// ---------------------------------------------------------------------------

const REAL_PERCEPTION = {
  self: {
    npcId: "oc-ag-VHzQTr8eHD3bnWSLIRbBfe7iVBAvCE5i",
    x: 1298.05,
    y: 1042.05,
    hp: 100,
    maxHp: 100,
    level: 1,
    activity: "walking",
    direction: "down",
  },
  nearbyNpcs: [],
  nearbyBuildings: [
    {
      buildingId: "memory-rag",
      label: "Squidward's House",
      cryptoFocus: "RAG pipelines, vector databases, semantic search",
      centerX: 7136,
      centerY: 5600,
      distance: 7407,
    },
    {
      buildingId: "agent-security",
      label: "Patrick's Rock",
      cryptoFocus: "agent permissions, RBAC, prompt injection defense",
      centerX: 5600,
      centerY: 7136,
      distance: 7459,
    },
  ],
  activeConversations: [],
  activeCombats: [],
  gameMode: "autonomous",
  arenaRound: null,
  timestamp: "2026-06-16T23:30:00.000Z",
} as const;

const MOVE_OK = { success: true, x: 7136, y: 5600 } as const;
const CHAT_OK = { success: true, response: null } as const;

const SESSION_ID = "ag-VHzQTr8eHD3bnWSLIRbBfe7iVBAvCE5i";

type FetchCall = { url: string; method: string; body: unknown };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RouteResult {
  json: { data: unknown; status: number } | null;
  error: { message: string; status: number } | null;
  handled: boolean;
}

function buildCtx(
  method: string,
  pathname: string,
  body?: unknown,
): { ctx: AppPackageRouteContext; result: RouteResult } {
  const result: RouteResult = { json: null, error: null, handled: false };
  const ctx = {
    method,
    pathname,
    url: new URL(`http://local${pathname}`),
    runtime: null,
    req: {} as never,
    res: {} as never,
    readJsonBody: async () => (body ?? null) as never,
    json: (_res: unknown, data: unknown, status = 200) => {
      result.json = { data, status };
    },
    error: (_res: unknown, message: string, status = 500) => {
      result.error = { message, status };
    },
  } as unknown as AppPackageRouteContext;
  return { ctx, result };
}

let fetchCalls: FetchCall[];

/**
 * Install a fetch stub that routes by the ClawVille API path so handleAppRoutes
 * exercises its real perception read + command proxy logic end to end.
 */
function installClawvilleFetch(
  overrides: Partial<{
    move: Response;
    chat: Response;
    visit: Response;
    perception: Response;
  }> = {},
): void {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      fetchCalls.push({ url, method, body });

      if (url.endsWith("/perception")) {
        return overrides.perception ?? jsonResponse(REAL_PERCEPTION);
      }
      if (url.endsWith("/move")) {
        return overrides.move ?? jsonResponse(MOVE_OK);
      }
      if (url.endsWith("/visit-building")) {
        return overrides.visit ?? jsonResponse(MOVE_OK);
      }
      if (url.endsWith("/chat")) {
        return overrides.chat ?? jsonResponse(CHAT_OK);
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }),
  );
}

beforeEach(() => {
  installClawvilleFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("handleAppRoutes — buildSessionState parser over the real perception shape", () => {
  it("parses the live perception into a contract-valid AppSessionState DTO", async () => {
    const { ctx, result } = buildCtx(
      "GET",
      `/api/apps/clawville/session/${SESSION_ID}`,
    );
    const handled = await handleAppRoutes(ctx);

    expect(handled).toBe(true);
    expect(result.error).toBeNull();
    expect(result.json?.status).toBe(200);

    const session = result.json?.data as AppSessionState;
    expect(session.appName).toBe("@elizaos/plugin-clawville");
    expect(session.mode).toBe("spectate-and-steer");
    expect(session.status).toBe("running");
    expect(session.canSendCommands).toBe(true);
    expect(session.sessionId).toBe(SESSION_ID);
    expect(session.displayName).toBe("ClawVille");
    // goalLabel is derived from the nearest building label in the live shape.
    expect(session.goalLabel).toBe(
      "Near Squidward's House. Visit or ask the local NPC.",
    );
    // telemetry must surface the live nearest-building fields, not nulls.
    expect(session.telemetry).toMatchObject({
      nearestBuildingId: "memory-rag",
      nearestBuildingLabel: "Squidward's House",
      identityType: "eliza",
      autonomyMode: "server-managed",
    });
    // The GET poll only hits the perception endpoint.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].method).toBe("GET");
    expect(fetchCalls[0].url).toContain(`/api/agent/${SESSION_ID}/perception`);
  });

  it("returns connecting state with no telemetry when perception is unavailable", async () => {
    installClawvilleFetch({ perception: jsonResponse({}, 404) });
    const { ctx, result } = buildCtx(
      "GET",
      `/api/apps/clawville/session/${SESSION_ID}`,
    );
    await handleAppRoutes(ctx);

    const session = result.json?.data as AppSessionState;
    // No perception → buildCachedConnect still produces a running session, but
    // telemetry nearest-building fields fall back to null.
    expect(session.status).toBe("running");
    expect(session.telemetry).toMatchObject({
      nearestBuildingId: null,
      nearestBuildingLabel: null,
    });
  });
});

describe("handleAppRoutes — buildMessageCommand NL router", () => {
  async function postMessage(content: string): Promise<{
    result: AppSessionActionResult;
    status: number;
    calls: FetchCall[];
  }> {
    const { ctx, result } = buildCtx(
      "POST",
      `/api/apps/clawville/session/${SESSION_ID}/message`,
      { content },
    );
    await handleAppRoutes(ctx);
    if (result.error) {
      throw new Error(`route errored: ${result.error.message}`);
    }
    return {
      result: result.json?.data as AppSessionActionResult,
      status: result.json?.status ?? 0,
      calls: fetchCalls,
    };
  }

  it("routes 'move to chum bucket' to a move with the resolved building id", async () => {
    const { result, status, calls } = await postMessage("move to chum bucket");

    const moveCall = calls.find((c) => c.url.endsWith("/move"));
    expect(moveCall).toBeDefined();
    // "chum bucket" is an alias of the skill-forge building.
    expect(moveCall?.body).toEqual({ buildingId: "skill-forge" });
    expect(status).toBe(200);
    expect(result.success).toBe(true);
    // a successful command returns a refreshed session DTO.
    expect(result.session?.appName).toBe("@elizaos/plugin-clawville");
  });

  it("routes 'visit the krusty krab' to a visit-building command", async () => {
    const { calls } = await postMessage("visit the krusty krab");
    const visitCall = calls.find((c) => c.url.endsWith("/visit-building"));
    expect(visitCall).toBeDefined();
    // "krusty krab" is an alias of tool-workshop.
    expect(visitCall?.body).toEqual({ buildingId: "tool-workshop" });
  });

  it("remaps a stale hardcoded building id to the REAL live id via perception", async () => {
    // "squidward" is a hardcoded alias of the plugin's "memory-vault", but the
    // live backend's building (label "Squidward's House") has id "memory-rag".
    // The backend rejects "memory-vault" with "Unknown building"; the move must
    // carry the live id resolved from perception.
    const { calls } = await postMessage("move to squidward's house");
    const moveCall = calls.find((c) => c.url.endsWith("/move"));
    expect(moveCall?.body).toEqual({ buildingId: "memory-rag" });
    expect(moveCall?.body).not.toEqual({ buildingId: "memory-vault" });
  });

  it("remaps a second drifted building (patrick -> agent-security)", async () => {
    // "patrick" is a hardcoded alias of "security-fortress"; the live building
    // (label "Patrick's Rock") has id "agent-security".
    const { calls } = await postMessage("visit patrick");
    const visitCall = calls.find((c) => c.url.endsWith("/visit-building"));
    expect(visitCall?.body).toEqual({ buildingId: "agent-security" });
  });

  it("falls back to a chat command for conversational free text", async () => {
    const { calls } = await postMessage("ask the npc what to learn next");
    const chatCall = calls.find((c) => c.url.endsWith("/chat"));
    expect(chatCall).toBeDefined();
    expect(chatCall?.body).toEqual({
      message: "ask the npc what to learn next",
    });
  });

  it("maps a 'buy' intent to the unsupported-buy 400 without proxying to the API", async () => {
    const { result, status, calls } = await postMessage(
      "buy 400 clawtokens at the market",
    );

    expect(status).toBe(400);
    expect(result.success).toBe(false);
    expect(result.message).toBe(
      "ClawVille agent shop control is not exposed by the current API.",
    );
    // buy is short-circuited — no upstream proxy call is made.
    expect(calls.some((c) => c.url.endsWith("/buy"))).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/move"))).toBe(false);
  });

  it("rejects an empty command body with a 400", async () => {
    const { ctx, result } = buildCtx(
      "POST",
      `/api/apps/clawville/session/${SESSION_ID}/message`,
      { content: "   " },
    );
    await handleAppRoutes(ctx);
    expect(result.error).toEqual({
      message: "Command content is required.",
      status: 400,
    });
  });
});

describe("handleAppRoutes — direct command subroutes", () => {
  it("normalizes a direct move with explicit coordinates and proxies them", async () => {
    const { ctx, result } = buildCtx(
      "POST",
      `/api/apps/clawville/session/${SESSION_ID}/move`,
      { targetX: 100, targetY: 200 },
    );
    await handleAppRoutes(ctx);

    const moveCall = fetchCalls.find((c) => c.url.endsWith("/move"));
    expect(moveCall?.body).toEqual({ targetX: 100, targetY: 200 });
    expect((result.json?.data as AppSessionActionResult).success).toBe(true);
  });

  it("coerces a direct visit-building with no body to the live nearest building", async () => {
    const { ctx } = buildCtx(
      "POST",
      `/api/apps/clawville/session/${SESSION_ID}/visit-building`,
      {},
    );
    await handleAppRoutes(ctx);

    // needsPerception → reads perception, then uses nearbyBuildings[0].buildingId.
    const visitCall = fetchCalls.find((c) => c.url.endsWith("/visit-building"));
    expect(visitCall?.body).toEqual({ buildingId: "memory-rag" });
  });

  it("returns 400 for the buy subroute and never proxies upstream", async () => {
    const { ctx, result } = buildCtx(
      "POST",
      `/api/apps/clawville/session/${SESSION_ID}/buy`,
      { amount: 400 },
    );
    await handleAppRoutes(ctx);

    expect(result.json?.status).toBe(400);
    expect((result.json?.data as AppSessionActionResult).success).toBe(false);
    expect(fetchCalls.some((c) => c.url.endsWith("/buy"))).toBe(false);
  });

  it("surfaces an upstream command failure as a 400 with no refreshed session", async () => {
    installClawvilleFetch({
      move: jsonResponse({ error: "Unknown building: tool-workshop" }, 400),
    });
    const { ctx, result } = buildCtx(
      "POST",
      `/api/apps/clawville/session/${SESSION_ID}/move`,
      { buildingId: "tool-workshop" },
    );
    await handleAppRoutes(ctx);

    const dto = result.json?.data as AppSessionActionResult;
    expect(result.json?.status).toBe(400);
    expect(dto.success).toBe(false);
    expect(dto.message).toBe("Unknown building: tool-workshop");
    expect(dto.session).toBeNull();
  });
});

describe("handleAppRoutes — non-matching requests", () => {
  it("returns false for paths without a session id", async () => {
    const { ctx } = buildCtx("GET", "/api/apps/clawville/unknown");
    expect(await handleAppRoutes(ctx)).toBe(false);
  });
});
