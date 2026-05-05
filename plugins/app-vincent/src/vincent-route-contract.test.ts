import type http from "node:http";
import { describe, expect, it } from "vitest";
import { handleVincentRoute, type VincentRouteState } from "./routes";

class CapturedResponse {
  statusCode = 200;
  headersSent = false;
  readonly headers: Record<string, string> = {};
  body = "";

  setHeader(name: string, value: number | string | readonly string[]) {
    this.headers[name.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : String(value);
    return this;
  }

  end(chunk?: string | Buffer) {
    this.body = chunk === undefined ? "" : chunk.toString();
    this.headersSent = true;
    return this;
  }
}

function createRequest(url: string): http.IncomingMessage {
  return {
    headers: { host: "127.0.0.1:31337" },
    method: "GET",
    url,
  } as http.IncomingMessage;
}

function createResponse(): CapturedResponse & http.ServerResponse {
  return new CapturedResponse() as CapturedResponse & http.ServerResponse;
}

function jsonBody<T>(res: CapturedResponse): T {
  return JSON.parse(res.body) as T;
}

function createState(config: Record<string, unknown>): VincentRouteState {
  return { config: config as VincentRouteState["config"] };
}

describe("Vincent route responses", () => {
  it("reports OAuth status without native venue execution state", async () => {
    const res = createResponse();
    const handled = await handleVincentRoute(
      createRequest("/api/vincent/status"),
      res,
      "/api/vincent/status",
      "GET",
      createState({}),
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(jsonBody(res)).toEqual({
      connected: false,
      connectedAt: null,
      tradingVenues: ["hyperliquid", "polymarket"],
    });
  });

  it("keeps strategy as Vincent configuration, not a native trading loop", async () => {
    const res = createResponse();
    const handled = await handleVincentRoute(
      createRequest("/api/vincent/strategy"),
      res,
      "/api/vincent/strategy",
      "GET",
      createState({
        vincent: {
          accessToken: "vincent-token",
          clientId: "vincent-client",
          connectedAt: 1_714_000_000,
        },
        trading: {
          strategy: "dca",
          params: { asset: "ETH" },
          intervalSeconds: 300,
          dryRun: true,
        },
      }),
    );

    expect(handled).toBe(true);
    expect(jsonBody(res)).toEqual({
      connected: true,
      strategy: {
        name: "dca",
        venues: ["hyperliquid", "polymarket"],
        params: { asset: "ETH" },
        intervalSeconds: 300,
        dryRun: true,
        running: false,
      },
    });
  });

  it("keeps trading profile empty until Vincent provides analytics", async () => {
    const res = createResponse();
    const handled = await handleVincentRoute(
      createRequest("/api/vincent/trading-profile"),
      res,
      "/api/vincent/trading-profile",
      "GET",
      createState({
        vincent: {
          accessToken: "vincent-token",
          clientId: "vincent-client",
          connectedAt: 1_714_000_000,
        },
      }),
    );

    expect(handled).toBe(true);
    expect(jsonBody(res)).toEqual({ connected: true, profile: null });
  });

  it("does not handle native Hyperliquid or Polymarket API routes", async () => {
    for (const pathname of [
      "/api/hyperliquid/status",
      "/api/hyperliquid/order",
      "/api/polymarket/status",
      "/api/polymarket/trade",
    ]) {
      const res = createResponse();
      const handled = await handleVincentRoute(
        createRequest(pathname),
        res,
        pathname,
        "GET",
        createState({}),
      );

      expect(handled).toBe(false);
      expect(res.body).toBe("");
    }
  });
});
