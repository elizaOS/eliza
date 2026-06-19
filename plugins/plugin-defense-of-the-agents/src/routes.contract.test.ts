import type { IAgentRuntime } from "@elizaos/core";
import type { AppSessionActionResult, AppSessionState } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAppRoutes, resetInMemoryStateForTests } from "./routes";

// ---------------------------------------------------------------------------
// Real-shaped Defense of the Agents API fixtures.
//
// The live dev backend (https://wc2-agentic-dev-3o6un.ondigitalocean.app) was
// OFFLINE / connection-refused when this test was authored (2026-06-16), so the
// responses below are FIXTURES whose shape is verified field-by-field against
// the provider contract encoded in the plugin's own parser:
//   - GET  /api/game/state?game=<id>  → DefenseGameState  (routes.ts lines 80-88,
//       hero shape lines 46-59, lane shape lines 61-65)
//   - POST /api/agents/register        → { apiKey }       (routes.ts lines 90-93)
//   - POST /api/strategy/deployment    → { message, gameId } (routes.ts 95-98)
// buildTelemetry/buildSessionState/buildSuggestedPrompts (routes.ts) consume
// exactly these fields; the assertions below pin the DTO the views render.
// ---------------------------------------------------------------------------

const HERO_NAME = "Eliza";

function makeGameState(
  overrides: {
    winner?: string | null;
    heroOverrides?: Record<string, unknown>;
    includeHero?: boolean;
  } = {},
) {
  const hero = {
    name: HERO_NAME,
    faction: "human",
    class: "mage",
    lane: "mid",
    hp: 80,
    maxHp: 100,
    alive: true,
    level: 3,
    xp: 120,
    xpToNext: 200,
    abilities: [{ id: "fireball", level: 1 }],
    abilityChoices: ["tornado", "fortitude"],
    ...overrides.heroOverrides,
  };
  return {
    tick: 42,
    agents: { human: ["Eliza", "ally"], orc: ["orc-1"] },
    lanes: {
      top: { human: 5, orc: 8, frontline: 12 },
      mid: { human: 10, orc: 4, frontline: 6 },
      bot: { human: 6, orc: 6, frontline: 9 },
    },
    towers: [
      { faction: "human", lane: "mid", hp: 900, maxHp: 1000, alive: true },
    ],
    bases: { human: { hp: 5000, maxHp: 5000 }, orc: { hp: 4800, maxHp: 5000 } },
    heroes: overrides.includeHero === false ? [] : [hero],
    winner: overrides.winner ?? null,
  };
}

function makeRuntime(): IAgentRuntime {
  const store = new Map<string, string>([
    ["DEFENSE_OF_THE_AGENTS_AGENT_NAME", HERO_NAME],
    ["DEFENSE_OF_THE_AGENTS_API_KEY", "test-api-key"],
    ["DEFENSE_OF_THE_AGENTS_GAME_ID", "3"],
  ]);
  return {
    agentId: "agent-defense-contract",
    character: { name: HERO_NAME, settings: { secrets: {} }, secrets: {} },
    getSetting: (key: string) => store.get(key) ?? null,
    setSetting: (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as IAgentRuntime;
}

interface RouteResult {
  json: { data: unknown; status: number } | null;
  error: { message: string; status: number } | null;
}

function buildCtx(
  method: string,
  pathname: string,
  runtime: IAgentRuntime | null,
  body?: unknown,
): {
  ctx: Parameters<typeof handleAppRoutes>[0];
  result: RouteResult;
} {
  const result: RouteResult = { json: null, error: null };
  const ctx = {
    method,
    pathname,
    url: new URL(`http://local${pathname}`),
    runtime,
    readJsonBody: async () => (body ?? null) as unknown,
    json: (_res: unknown, data: unknown, status = 200) => {
      result.json = { data, status };
    },
    error: (_res: unknown, message: string, status = 500) => {
      result.error = { message, status };
    },
    res: {},
  };
  return { ctx, result };
}

type FetchCall = { url: string; method: string; body: unknown };
let fetchCalls: FetchCall[];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(
  overrides: Partial<{
    state: Response;
    register: Response;
    deploy: Response;
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

      if (url.includes("/api/game/state")) {
        return overrides.state ?? jsonResponse(makeGameState());
      }
      if (url.includes("/api/agents/register")) {
        return overrides.register ?? jsonResponse({ apiKey: "fresh-key" });
      }
      if (url.includes("/api/strategy/deployment")) {
        return (
          overrides.deploy ??
          jsonResponse({ message: "Deployment accepted.", gameId: 3 })
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }),
  );
}

beforeEach(() => {
  resetInMemoryStateForTests();
  installFetch();
  delete process.env.DEFENSE_AUTO_PLAY;
});

afterEach(() => {
  resetInMemoryStateForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.DEFENSE_AUTO_PLAY;
});

describe("handleAppRoutes — DefenseGameState parser over the real-shaped state", () => {
  it("parses the live game state into a contract-valid AppSessionState DTO", async () => {
    const runtime = makeRuntime();
    const { ctx, result } = buildCtx(
      "GET",
      `/api/apps/defense-of-the-agents/session/${HERO_NAME}`,
      runtime,
    );
    const handled = await handleAppRoutes(ctx);

    expect(handled).toBe(true);
    expect(result.error).toBeNull();
    expect(result.json?.status).toBe(200);

    const session = result.json?.data as AppSessionState;
    expect(session.appName).toBe("@elizaos/plugin-defense-of-the-agents");
    expect(session.mode).toBe("spectate-and-steer");
    // hero alive → "running".
    expect(session.status).toBe("running");
    expect(session.canSendCommands).toBe(true);
    expect(session.displayName).toBe("Defense of the Agents");
    // goalLabel derived from the hero (has ability choices).
    expect(session.goalLabel).toBe("Choose an ability for Eliza");
    // summary derived from class/level/lane/hp.
    expect(session.summary).toBe("Mage level 3 in mid lane, 80/100 HP.");

    // telemetry surfaces the parsed hero + lane fields the views consume.
    expect(session.telemetry).toMatchObject({
      gameId: 3,
      tick: 42,
      winner: null,
      heroFaction: "human",
      heroClass: "mage",
      heroLane: "mid",
      heroLevel: 3,
      heroHp: 80,
      heroMaxHp: 100,
      heroAlive: true,
      heroAbilityChoices: 2,
      humanAgents: 2,
      orcAgents: 1,
      // active lane = mid: human 10 / orc 4.
      laneHumanUnits: 10,
      laneOrcUnits: 4,
      laneFrontline: 6,
      autoPlay: false,
    });

    // suggestedPrompts: autoplay toggle first, then lane moves, ability learns.
    const prompts = session.suggestedPrompts ?? [];
    expect(prompts[0]).toBe("Auto-play ON");
    // hero in mid → "Move to top lane" / "Move to bot lane" offered.
    expect(prompts).toContain("Move to top lane");
    // ability choices → "Learn Tornado".
    expect(prompts.some((p) => p.startsWith("Learn "))).toBe(true);

    // GET poll hits only the preferred game once.
    const stateCalls = fetchCalls.filter((c) =>
      c.url.includes("/api/game/state"),
    );
    expect(stateCalls).toHaveLength(1);
    expect(stateCalls[0].url).toContain("game=3");
  });

  it("offers a recall prompt and low-HP goal when the hero is badly hurt", async () => {
    installFetch({
      state: jsonResponse(
        makeGameState({
          // No ability choices so buildGoalLabel reaches the low-HP branch.
          heroOverrides: { hp: 20, maxHp: 100, abilityChoices: [] },
        }),
      ),
    });
    const runtime = makeRuntime();
    const { ctx, result } = buildCtx(
      "GET",
      `/api/apps/defense-of-the-agents/session/${HERO_NAME}`,
      runtime,
    );
    await handleAppRoutes(ctx);

    const session = result.json?.data as AppSessionState;
    expect(session.goalLabel).toBe("Low HP: consider recalling");
    expect(session.suggestedPrompts).toContain("Recall to base");
  });

  it("reports a ready (not-deployed) DTO when the hero is absent from game state", async () => {
    installFetch({
      state: jsonResponse(makeGameState({ includeHero: false })),
    });
    const runtime = makeRuntime();
    const { ctx, result } = buildCtx(
      "GET",
      `/api/apps/defense-of-the-agents/session/${HERO_NAME}`,
      runtime,
    );
    await handleAppRoutes(ctx);

    const session = result.json?.data as AppSessionState;
    expect(session.status).toBe("ready");
    expect(session.telemetry).toMatchObject({
      heroClass: null,
      heroLane: null,
    });
    // deploy prompts when not in the arena.
    expect(session.suggestedPrompts).toContain("Deploy as mage in mid lane");
  });
});

describe("handleAppRoutes — register + deploy response shapes", () => {
  it("consumes the deployment {message, gameId} shape and returns a refreshed session", async () => {
    const runtime = makeRuntime();
    const { ctx, result } = buildCtx(
      "POST",
      `/api/apps/defense-of-the-agents/session/${HERO_NAME}/message`,
      runtime,
      { content: "Move to top lane" },
    );
    await handleAppRoutes(ctx);

    expect(result.error).toBeNull();
    const action = result.json?.data as AppSessionActionResult;
    expect(action.success).toBe(true);
    // deploy response.message consumed verbatim.
    expect(action.message).toBe("Deployment accepted.");
    expect(action.session?.appName).toBe(
      "@elizaos/plugin-defense-of-the-agents",
    );

    // A deployment POST was issued to /api/strategy/deployment with the parsed body.
    const deployCall = fetchCalls.find((c) =>
      c.url.includes("/api/strategy/deployment"),
    );
    expect(deployCall).toBeDefined();
    expect(deployCall?.method).toBe("POST");
    expect(deployCall?.body).toMatchObject({ heroLane: "top" });
  });

  it("auto-registers via the {apiKey} register shape when no key is configured", async () => {
    // Runtime with NO api key forces ensureApiKey → registerAgent.
    const store = new Map<string, string>([
      ["DEFENSE_OF_THE_AGENTS_AGENT_NAME", HERO_NAME],
      ["DEFENSE_OF_THE_AGENTS_GAME_ID", "3"],
    ]);
    delete process.env.DEFENSE_OF_THE_AGENTS_API_KEY;
    const runtime = {
      agentId: "agent-defense-register",
      character: { name: HERO_NAME, settings: { secrets: {} }, secrets: {} },
      getSetting: (key: string) => store.get(key) ?? null,
      setSetting: (key: string, value: string) => {
        store.set(key, value);
      },
    } as unknown as IAgentRuntime;

    const { ctx, result } = buildCtx(
      "POST",
      `/api/apps/defense-of-the-agents/session/${HERO_NAME}/message`,
      runtime,
      { content: "Move to bot lane" },
    );
    await handleAppRoutes(ctx);

    expect(result.error).toBeNull();
    // registerAgent persisted the returned apiKey.
    const registerCall = fetchCalls.find((c) =>
      c.url.includes("/api/agents/register"),
    );
    expect(registerCall).toBeDefined();
    expect(store.get("DEFENSE_OF_THE_AGENTS_API_KEY")).toBe("fresh-key");
  });

  it("rejects the control subroute (no pause/resume)", async () => {
    const runtime = makeRuntime();
    const { ctx, result } = buildCtx(
      "POST",
      `/api/apps/defense-of-the-agents/session/${HERO_NAME}/control`,
      runtime,
      { action: "pause" },
    );
    await handleAppRoutes(ctx);

    expect(result.json).toBeNull();
    expect(result.error?.status).toBe(400);
    expect(result.error?.message).toContain("does not expose pause or resume");
  });
});
