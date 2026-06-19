import type { IAgentRuntime } from "@elizaos/core";
import type { AppSessionState, AppViewerAuthMessage } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectLaunchDiagnostics,
  refreshRunSession,
  resolveLaunchSession,
  resolveViewerAuthMessage,
} from "./routes";

// ---------------------------------------------------------------------------
// Real-shaped Hyperscape API fixtures.
//
// The Hyperscape API base is configured per-deployment (HYPERSCAPE_API_URL /
// HYPERSCAPE_CLIENT_URL) and was not reachable from this sandbox when the test
// was authored (2026-06-16). The responses below are FIXTURES whose shape is
// verified field-by-field against the plugin's own parser in src/routes.ts:
//   - GET /api/embedded-agents          → { agents: EmbeddedAgentRecord[] }
//       EmbeddedAgentRecord = { agentId, state, startedAt, lastActivity }   (routes.ts 303-308)
//   - GET /api/agents/:id/goal          → { goal, goalsPaused, availableGoals } (routes.ts 350-354)
//       GoalRecord = { description, type, reason }                          (routes.ts 310-314)
//   - GET /api/agents/:id/quick-actions → { quickCommands, nearbyLocations } (routes.ts 355-358)
//       QuickCommand = { label, command, available }                       (routes.ts 316-320)
//   - GET /api/agents/:id/thoughts?limit=5 → { thoughts: ThoughtRecord[] }  (routes.ts 359-361)
//       ThoughtRecord = { id, type, content, timestamp }                   (routes.ts 326-331)
// fetchLiveData + buildSession consume exactly these fields; the assertions
// below pin the AppSessionState DTO every Hyperscape view renders.
// ---------------------------------------------------------------------------

const AGENT_ID = "hyper-agent-1";
const API_BASE = "https://api.hyperscape.test";

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  const store = new Map<string, string>(Object.entries(settings));
  return {
    agentId: AGENT_ID,
    character: { name: "Milady", settings: { secrets: {} }, secrets: {} },
    getSetting: (key: string) => store.get(key) ?? null,
    setSetting: (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as IAgentRuntime;
}

function embeddedAgents(state: "running" | "idle") {
  return {
    agents: [
      {
        agentId: AGENT_ID,
        state,
        startedAt: 1_700_000_000_000,
        lastActivity: 1_700_000_500_000,
      },
    ],
  };
}

const GOAL_RESPONSE = {
  goal: {
    description: "Explore the northern district",
    type: "explore",
    reason: "Find the merchant",
  },
  goalsPaused: false,
  availableGoals: [
    { description: "Scout the plaza", type: "explore", reason: "Recon" },
    { description: "Trade with NPCs", type: "social", reason: null },
  ],
};

const QUICK_ACTIONS_RESPONSE = {
  quickCommands: [
    { label: "Look around", command: "look around", available: true },
    { label: "Follow", command: "follow the merchant", available: true },
    // available === false → filtered out of suggestedPrompts.
    { label: "Pause", command: "pause", available: false },
    // non-string command → filtered out.
    { label: "Bad", command: 42, available: true },
  ],
  nearbyLocations: [{ name: "Plaza" }, { name: "North gate" }],
};

const THOUGHTS_RESPONSE = {
  thoughts: [
    {
      id: "t-1",
      type: "plan",
      content: "Head north",
      timestamp: 1_700_000_001,
    },
    {
      id: "t-2",
      type: "observe",
      content: "Crowd ahead",
      timestamp: 1_700_000_002,
    },
  ],
};

type FetchCall = { url: string; method: string };
let fetchCalls: FetchCall[];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(state: "running" | "idle" = "running"): void {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/api/embedded-agents")) {
        return jsonResponse(embeddedAgents(state));
      }
      if (url.includes("/goal")) return jsonResponse(GOAL_RESPONSE);
      if (url.includes("/quick-actions")) {
        return jsonResponse(QUICK_ACTIONS_RESPONSE);
      }
      if (url.includes("/thoughts")) return jsonResponse(THOUGHTS_RESPONSE);
      throw new Error(`Unexpected fetch to ${url}`);
    }),
  );
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("resolveLaunchSession — Hyperscape live-data parser", () => {
  it("parses the four live endpoints into a contract-valid AppSessionState DTO", async () => {
    const runtime = makeRuntime({
      HYPERSCAPE_API_URL: API_BASE,
      HYPERSCAPE_CHARACTER_ID: "milady-character",
    });
    const session = (await resolveLaunchSession({
      appName: "@elizaos/plugin-hyperscape",
      launchUrl: null,
      runtime,
      viewer: null,
    })) as AppSessionState;

    expect(session).not.toBeNull();
    expect(session.appName).toBe("@elizaos/plugin-hyperscape");
    expect(session.mode).toBe("spectate-and-steer");
    // sessionId = agentId.
    expect(session.sessionId).toBe(AGENT_ID);
    expect(session.agentId).toBe(AGENT_ID);
    // agent state "running" → status running + controls ["pause"].
    expect(session.status).toBe("running");
    expect(session.controls).toEqual(["pause"]);
    expect(session.canSendCommands).toBe(true);
    // followEntity + characterId come from HYPERSCAPE_CHARACTER_ID.
    expect(session.characterId).toBe("milady-character");
    expect(session.followEntity).toBe("milady-character");
    // running → no "Connecting session..." summary.
    expect(session.summary).toBeNull();
    // goalLabel = goal.description.
    expect(session.goalLabel).toBe("Explore the northern district");
    // suggestedPrompts from available quickCommands with string commands only.
    expect(session.suggestedPrompts).toEqual([
      "look around",
      "follow the merchant",
    ]);

    // telemetry the views read.
    expect(session.telemetry).toMatchObject({
      goalsPaused: false,
      availableGoalCount: 2,
      nearbyLocationCount: 2,
      startedAt: 1_700_000_000_000,
      lastActivity: 1_700_000_500_000,
    });
    const telemetry = session.telemetry as Record<string, unknown>;
    // recommendedGoals get synthetic goal-<i> ids.
    const recommended = telemetry.recommendedGoals as Array<
      Record<string, unknown>
    >;
    expect(recommended).toHaveLength(2);
    expect(recommended[0]).toMatchObject({
      id: "goal-0",
      type: "explore",
      description: "Scout the plaza",
    });
    // null reason is preserved.
    expect(recommended[1]).toMatchObject({ id: "goal-1", reason: null });
    // recentThoughts (capped at THOUGHTS_LIMIT = 5).
    const thoughts = telemetry.recentThoughts as Array<Record<string, unknown>>;
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0]).toMatchObject({
      id: "t-1",
      type: "plan",
      content: "Head north",
    });

    // All four endpoints were hit exactly once.
    expect(fetchCalls.filter((c) => c.url.startsWith(API_BASE))).toHaveLength(
      4,
    );
    expect(
      fetchCalls.some((c) =>
        c.url.includes(`/api/agents/${AGENT_ID}/thoughts?limit=5`),
      ),
    ).toBe(true);
  });

  it("maps a non-running agent to status connecting + resume control + connecting summary", async () => {
    installFetch("idle");
    const runtime = makeRuntime({ HYPERSCAPE_API_URL: API_BASE });
    const session = (await resolveLaunchSession({
      appName: "@elizaos/plugin-hyperscape",
      launchUrl: null,
      runtime,
      viewer: null,
    })) as AppSessionState;

    expect(session.status).toBe("connecting");
    expect(session.controls).toEqual(["resume"]);
    expect(session.summary).toBe("Connecting session...");
  });

  it("falls back to HYPERSCAPE_CLIENT_URL when HYPERSCAPE_API_URL is unset", async () => {
    const runtime = makeRuntime({ HYPERSCAPE_CLIENT_URL: API_BASE });
    const session = await resolveLaunchSession({
      appName: "@elizaos/plugin-hyperscape",
      launchUrl: null,
      runtime,
      viewer: null,
    });
    expect(session).not.toBeNull();
    expect(fetchCalls.every((c) => c.url.startsWith(API_BASE))).toBe(true);
  });

  it("returns null when no API base is configured (no fetch issued)", async () => {
    const runtime = makeRuntime({});
    const session = await resolveLaunchSession({
      appName: "@elizaos/plugin-hyperscape",
      launchUrl: null,
      runtime,
      viewer: null,
    });
    expect(session).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it("returns null when no agentId can be resolved", async () => {
    const runtime = {
      agentId: "",
      character: { name: "Milady" },
      getSetting: (key: string) =>
        key === "HYPERSCAPE_API_URL" ? API_BASE : null,
    } as unknown as IAgentRuntime;
    const session = await resolveLaunchSession({
      appName: "@elizaos/plugin-hyperscape",
      launchUrl: null,
      runtime,
      viewer: null,
    });
    expect(session).toBeNull();
  });
});

describe("refreshRunSession — reuses the existing session's agentId", () => {
  it("re-fetches live data keyed on session.agentId and returns a fresh DTO", async () => {
    const runtime = makeRuntime({ HYPERSCAPE_API_URL: API_BASE });
    const priorSession = {
      sessionId: AGENT_ID,
      appName: "@elizaos/plugin-hyperscape",
      mode: "spectate-and-steer",
      status: "running",
      agentId: AGENT_ID,
      characterId: "milady-character",
    } as AppSessionState;

    const session = (await refreshRunSession({
      appName: "@elizaos/plugin-hyperscape",
      launchUrl: null,
      runtime,
      viewer: null,
      session: priorSession,
    })) as AppSessionState;

    expect(session.sessionId).toBe(AGENT_ID);
    expect(session.goalLabel).toBe("Explore the northern district");
    expect(
      fetchCalls.some((c) => c.url.includes(`/api/agents/${AGENT_ID}/goal`)),
    ).toBe(true);
  });

  it("returns null when there is no prior session", async () => {
    const runtime = makeRuntime({ HYPERSCAPE_API_URL: API_BASE });
    const session = await refreshRunSession({
      appName: "@elizaos/plugin-hyperscape",
      launchUrl: null,
      runtime,
      viewer: null,
      session: null,
    });
    expect(session).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("resolveViewerAuthMessage — HYPERSCAPE_AUTH credential", () => {
  it("returns null without an auth token", async () => {
    const runtime = makeRuntime({});
    expect(await resolveViewerAuthMessage({ runtime })).toBeNull();
  });

  it("builds the HYPERSCAPE_AUTH message with token + agentId + characterId", async () => {
    const runtime = makeRuntime({
      HYPERSCAPE_AUTH_TOKEN: "tok-abc",
      HYPERSCAPE_CHARACTER_ID: "milady-character",
    });
    const message = (await resolveViewerAuthMessage({
      runtime,
    })) as AppViewerAuthMessage;

    expect(message).toEqual({
      type: "HYPERSCAPE_AUTH",
      authToken: "tok-abc",
      agentId: AGENT_ID,
      characterId: "milady-character",
      followEntity: "milady-character",
    });
  });

  it("falls back characterId to the agentId when HYPERSCAPE_CHARACTER_ID is unset", async () => {
    const runtime = makeRuntime({ HYPERSCAPE_AUTH_TOKEN: "tok-abc" });
    const message = (await resolveViewerAuthMessage({
      runtime,
    })) as AppViewerAuthMessage;
    expect(message.characterId).toBe(AGENT_ID);
    expect(message.followEntity).toBe(AGENT_ID);
  });
});

describe("collectLaunchDiagnostics — auth-unavailable diagnostic", () => {
  it("returns the auth-unavailable error when postMessage auth is requested but missing", async () => {
    const diagnostics = await collectLaunchDiagnostics({
      viewer: {
        url: "/api/apps/hyperscape/viewer",
        postMessageAuth: true,
        authMessage: undefined,
      },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "hyperscape-auth-unavailable",
      severity: "error",
    });
  });

  it("returns no diagnostics when the auth message is present", async () => {
    const diagnostics = await collectLaunchDiagnostics({
      viewer: {
        url: "/api/apps/hyperscape/viewer",
        postMessageAuth: true,
        authMessage: {
          type: "HYPERSCAPE_AUTH",
          authToken: "tok-abc",
          agentId: AGENT_ID,
        },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it("returns no diagnostics when postMessage auth is not requested", async () => {
    const diagnostics = await collectLaunchDiagnostics({
      viewer: { url: "/api/apps/hyperscape/viewer", postMessageAuth: false },
    });
    expect(diagnostics).toEqual([]);
  });
});
