// Real-handler tests for the Feed TUI `interact()` capability dispatcher.
//
// `interact()` (FeedOperatorSurface.interact.ts) is the code the host
// `TerminalPluginView` invokes for every TUI capability. It talks to the Feed
// proxy over `global.fetch` and parses responses through `readFeedJson`. These
// tests drive the REAL handler with a stubbed `fetch`, asserting the exact
// request URLs/methods/bodies and the returned shape for every capability —
// including the blank-content default, the non-ok throw, and the
// unknown-capability throw. No host mock is involved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interact } from "./FeedOperatorSurface.interact";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function stubFetch(handler: (call: FetchCall) => Response): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", mock);
  return { calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Realistic Feed proxy payloads (real-shape, verified against the proxy routes
// in ../routes.ts and the canonical @elizaos/ui Feed response types).
const agentStatusPayload = {
  id: "feed-agent-alice",
  name: "Alice",
  displayName: "Alice Trader",
  balance: 1240.5,
  lifetimePnL: 312.75,
  winRate: 0.62,
  reputationScore: 88,
  totalTrades: 145,
  autonomous: true,
  agentStatus: "running",
};
const teamDashboardPayload = {
  agents: [{ id: "feed-agent-alice", name: "Alice", balance: 1240.5 }],
  summary: { ownerName: "Studio Ops", totals: { walletBalance: 5000 } },
};
const marketsPayload = {
  markets: [
    {
      id: "mkt-1",
      title: "Will BTC close above 100k?",
      status: "open",
      yesPrice: 0.62,
      noPrice: 0.38,
      volume: 12000,
      liquidity: 3400,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  total: 1,
  pageSize: 5,
};

describe("Feed TUI interact() capability handler", () => {
  for (const capability of ["get-state", "refresh-agent-status"] as const) {
    it(`"${capability}" fetches status, dashboard, and markets?pageSize=5 and returns {status,dashboard,markets}`, async () => {
      const { calls } = stubFetch(({ url }) => {
        if (url === "/api/apps/feed/agent/status")
          return jsonResponse(agentStatusPayload);
        if (url === "/api/apps/feed/team/dashboard")
          return jsonResponse(teamDashboardPayload);
        if (url === "/api/apps/feed/markets?pageSize=5")
          return jsonResponse(marketsPayload);
        throw new Error(`Unexpected request: ${url}`);
      });

      const result = (await interact(capability)) as {
        status: typeof agentStatusPayload;
        dashboard: typeof teamDashboardPayload;
        markets: typeof marketsPayload;
      };

      // All three GETs fired (Promise.all) with the exact proxy URLs.
      const urls = calls.map((c) => c.url).sort();
      expect(urls).toEqual([
        "/api/apps/feed/agent/status",
        "/api/apps/feed/markets?pageSize=5",
        "/api/apps/feed/team/dashboard",
      ]);
      // None of the reads mutate state — every call is a GET.
      for (const call of calls) {
        expect(call.init?.method ?? "GET").toBe("GET");
      }

      // The handler returns the three parsed payloads under named keys.
      expect(result.status).toEqual(agentStatusPayload);
      expect(result.dashboard).toEqual(teamDashboardPayload);
      expect(result.markets).toEqual(marketsPayload);
      // Specific populated values survive parsing.
      expect(result.status.displayName).toBe("Alice Trader");
      expect(result.markets.markets[0].title).toBe(
        "Will BTC close above 100k?",
      );
    });
  }

  it('"open-live-dashboard" returns the route + endpoints WITHOUT issuing any fetch', async () => {
    const { calls } = stubFetch(() => {
      throw new Error("open-live-dashboard must not fetch");
    });

    const result = (await interact("open-live-dashboard")) as {
      path: string;
      endpoints: string[];
    };

    expect(calls).toHaveLength(0);
    expect(result).toEqual({
      path: "/feed",
      endpoints: [
        "/api/apps/feed/agent/status",
        "/api/apps/feed/team/dashboard",
        "/api/apps/feed/markets",
      ],
    });
  });

  it('"send-team-message" POSTs the trimmed content to /team/chat and returns the parsed JSON', async () => {
    const { calls } = stubFetch(({ url }) => {
      if (url === "/api/apps/feed/team/chat")
        return jsonResponse({ ok: true, messageId: "msg-9" });
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = (await interact("send-team-message", {
      content: "  market check  ",
    })) as { ok: boolean; messageId: string };

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/apps/feed/team/chat");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toEqual({
      "Content-Type": "application/json",
    });
    // Surrounding whitespace is trimmed before dispatch.
    expect(calls[0].init?.body).toBe(
      JSON.stringify({ content: "market check" }),
    );
    expect(result).toEqual({ ok: true, messageId: "msg-9" });
  });

  it('"send-team-message" falls back to "Terminal status check" when content is blank or omitted', async () => {
    const { calls } = stubFetch(({ url }) => {
      if (url === "/api/apps/feed/team/chat") return jsonResponse({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    });

    await interact("send-team-message", { content: "   " });
    await interact("send-team-message");
    await interact("send-team-message", { content: 42 as unknown as string });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init?.body).toBe(
        JSON.stringify({ content: "Terminal status check" }),
      );
    }
  });

  it('"send-team-message" returns {} for an empty (200, no-body) response', async () => {
    stubFetch(() => new Response("", { status: 200 }));
    const result = await interact("send-team-message", { content: "ping" });
    expect(result).toEqual({});
  });

  it("readFeedJson throws with the upstream error text on a non-ok response", async () => {
    stubFetch(({ url }) => {
      if (url === "/api/apps/feed/team/chat")
        return new Response("team chat unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        });
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(
      interact("send-team-message", { content: "ping" }),
    ).rejects.toThrow("team chat unavailable");
  });

  it("readFeedJson throws a status/statusText message when the non-ok body is empty", async () => {
    stubFetch(({ url }) => {
      if (url === "/api/apps/feed/agent/status")
        return new Response("", { status: 502, statusText: "Bad Gateway" });
      if (url === "/api/apps/feed/team/dashboard")
        return jsonResponse(teamDashboardPayload);
      if (url === "/api/apps/feed/markets?pageSize=5")
        return jsonResponse(marketsPayload);
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(interact("get-state")).rejects.toThrow(
      "[feed] 502 Bad Gateway",
    );
  });

  it("throws the exact unsupported-capability message for an unknown capability", async () => {
    stubFetch(() => {
      throw new Error("unknown capability must not fetch");
    });

    await expect(interact("totally-unknown")).rejects.toThrow(
      'Feed TUI does not support "totally-unknown".',
    );
  });
});
