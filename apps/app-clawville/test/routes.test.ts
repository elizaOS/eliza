import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAppRoutes } from "../src/routes";

type CapturedRoute = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

function makeRuntime() {
  const settings = new Map<string, string>([
    ["CLAWVILLE_SESSION_ID", "session-1"],
    ["CLAWVILLE_BOT_UUID", "bot-1"],
    ["CLAWVILLE_WALLET_ADDRESS", "wallet-1"],
  ]);
  return {
    agentId: "agent-1",
    character: { name: "Milady" },
    getSetting: (key: string) => settings.get(key),
    setSetting: vi.fn((key: string, value: string) => {
      settings.set(key, value);
    }),
  };
}

function makeCtx({
  method,
  pathname,
  body,
}: {
  method: string;
  pathname: string;
  body?: unknown;
}) {
  const captured: CapturedRoute = {
    status: 0,
    body: null,
    headers: {},
  };
  const res = {
    statusCode: 0,
    setHeader: (name: string, value: string) => {
      captured.headers[name] = value;
    },
    removeHeader: vi.fn(),
    getHeader: vi.fn(),
    end: (value?: string) => {
      captured.status = res.statusCode;
      captured.body = value ?? "";
    },
  };

  return {
    captured,
    ctx: {
      method,
      pathname,
      runtime: makeRuntime(),
      res,
      readJsonBody: async () => body,
      json: (_response: unknown, data: unknown, status = 200) => {
        captured.status = status;
        captured.body = data;
      },
      error: (_response: unknown, message: string, status = 500) => {
        captured.status = status;
        captured.body = { error: message };
      },
    },
  };
}

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClawVille app routes", () => {
  it("injects current Milady embed keys without visible host overlays", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<html><head></head><body></body></html>"),
      ),
    );
    const { ctx, captured } = makeCtx({
      method: "GET",
      pathname: "/api/apps/clawville/viewer",
    });

    await handleAppRoutes(ctx);

    expect(captured.status).toBe(200);
    expect(captured.body).toContain(
      'localStorage.setItem("clawville-embed-mode", "milady")',
    );
    expect(captured.body).toContain("clawville-milady-session-id");
    expect(captured.body).not.toContain("clawville-eliza-session-id");
    expect(captured.body).not.toContain("spectator-banner");
  });

  it("maps run messages to the current ClawVille move API shape", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (url.endsWith("/move")) {
          return jsonResponse({ message: "moving" });
        }
        if (url.endsWith("/perception")) {
          return jsonResponse({
            nearbyBuildings: [
              { buildingId: "tool-workshop", label: "Krusty Krab" },
            ],
          });
        }
        return jsonResponse({});
      }),
    );
    const { ctx, captured } = makeCtx({
      method: "POST",
      pathname: "/api/apps/clawville/session/session-1/message",
      body: { content: "Move to Krusty Krab" },
    });

    await handleAppRoutes(ctx);

    const moveRequest = requests.find((request) =>
      request.url.endsWith("/move"),
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ success: true, message: "moving" });
    expect(moveRequest?.body).toEqual({ buildingId: "tool-workshop" });
  });

  it("uses perception for nearest-building visit commands", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (url.endsWith("/perception")) {
          return jsonResponse({
            nearbyBuildings: [
              { buildingId: "security-fortress", label: "Patrick's Rock" },
            ],
          });
        }
        if (url.endsWith("/visit-building")) {
          return jsonResponse({ message: "visited" });
        }
        return jsonResponse({});
      }),
    );
    const { ctx, captured } = makeCtx({
      method: "POST",
      pathname: "/api/apps/clawville/session/session-1/message",
      body: { content: "Visit the nearest building" },
    });

    await handleAppRoutes(ctx);

    const visitRequest = requests.find((request) =>
      request.url.endsWith("/visit-building"),
    );
    expect(captured.status).toBe(200);
    expect(visitRequest?.body).toEqual({ buildingId: "security-fortress" });
  });

  it("maps chat commands to the required message field", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (url.endsWith("/chat")) {
          return jsonResponse({ message: "reply queued" });
        }
        if (url.endsWith("/perception")) {
          return jsonResponse({ nearbyBuildings: [] });
        }
        return jsonResponse({});
      }),
    );
    const { ctx, captured } = makeCtx({
      method: "POST",
      pathname: "/api/apps/clawville/session/session-1/message",
      body: { content: "Ask the nearest NPC what to learn next" },
    });

    await handleAppRoutes(ctx);

    const chatRequest = requests.find((request) =>
      request.url.endsWith("/chat"),
    );
    expect(captured.status).toBe(200);
    expect(chatRequest?.body).toEqual({
      message: "Ask the nearest NPC what to learn next",
    });
  });
});
