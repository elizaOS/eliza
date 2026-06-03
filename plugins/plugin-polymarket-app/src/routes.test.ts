import { describe, expect, it } from "vitest";

import { handlePolymarketRoute } from "./routes";

function createRequest(url: string) {
  return { url } as import("node:http").IncomingMessage;
}

function createResponse() {
  const headers = new Map<string, string>();
  const res = {
    headersSent: false,
    statusCode: 0,
    body: "",
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    end(body: string) {
      this.headersSent = true;
      this.body = body;
    },
    json<T = unknown>(): T {
      return JSON.parse(this.body) as T;
    },
    header(name: string): string | undefined {
      return headers.get(name);
    },
  };
  return res as typeof res & import("node:http").ServerResponse;
}

describe("handlePolymarketRoute trading boundary", () => {
  it("keeps status readiness-only even when trading credentials exist", async () => {
    const res = createResponse();

    await expect(
      handlePolymarketRoute(
        createRequest("/api/polymarket/status"),
        res,
        "/api/polymarket/status",
        "GET",
        {
          env: {
            POLYMARKET_PRIVATE_KEY: "wallet-key",
            CLOB_API_KEY: "api-key",
            CLOB_API_SECRET: "api-secret",
            CLOB_API_PASSPHRASE: "passphrase",
          },
        },
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(res.header("content-type")).toBe("application/json; charset=utf-8");
    expect(res.json()).toMatchObject({
      publicReads: { ready: true },
      trading: {
        ready: false,
        credentialsReady: true,
        missing: [],
        reason: "Signed Polymarket CLOB trading is disabled in this app integration.",
      },
    });
  });

  it.each(["GET", "POST"])(
    "returns 501 for %s /api/polymarket/orders",
    async (method) => {
      const res = createResponse();

      await expect(
        handlePolymarketRoute(
          createRequest("/api/polymarket/orders"),
          res,
          "/api/polymarket/orders",
          method,
        ),
      ).resolves.toBe(true);

      expect(res.statusCode).toBe(501);
      expect(res.json()).toEqual({
        enabled: false,
        reason:
          "Trading and order management are disabled in this app integration. Configure a signed CLOB execution path before enabling these routes.",
        requiredForTrading: [
          "POLYMARKET_PRIVATE_KEY",
          "CLOB_API_KEY",
          "CLOB_API_SECRET",
          "CLOB_API_PASSPHRASE",
        ],
      });
    },
  );
});
