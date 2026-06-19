/**
 * Tests for CloudApiClient — exercises real fetch against a local HTTP server.
 * No mocks of the code under test. The server returns controlled responses
 * so we can verify headers, error handling, auth injection, etc.
 */

import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudApiError, InsufficientCreditsError } from "../src/types/cloud";
import { CloudApiClient } from "../src/utils/cloud-api";

let server: http.Server;
let baseUrl: string;

/** Tracks the last request the server received. */
let lastRequest: {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

/** What the server should respond with next. */
let nextResponse: {
  status: number;
  contentType: string;
  body: string;
};

function setResponse(status: number, body: Record<string, unknown>): void {
  nextResponse = {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

function setTextResponse(status: number, text: string): void {
  nextResponse = { status, contentType: "text/plain", body: text };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      };
      res.writeHead(nextResponse.status, {
        "Content-Type": nextResponse.contentType,
      });
      res.end(nextResponse.body);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

// ─── Constructor & URL handling ──────────────────────────────────────────

describe("CloudApiClient construction", () => {
  it("strips trailing slashes from baseUrl", () => {
    const client = new CloudApiClient("https://example.com/api///");
    expect(client.buildWsUrl("/test")).toBe("wss://example.com/api/test");
  });

  it("stores and retrieves API key", () => {
    const client = new CloudApiClient(baseUrl);
    expect(client.getApiKey()).toBeUndefined();
    client.setApiKey("eliza_test123");
    expect(client.getApiKey()).toBe("eliza_test123");
  });

  it("builds WebSocket URL by replacing http with ws", () => {
    const client = new CloudApiClient("http://localhost:3000/api/v1");
    expect(client.buildWsUrl("/bridge/abc")).toBe("ws://localhost:3000/api/v1/bridge/abc");
  });

  it("builds wss URL from https", () => {
    const client = new CloudApiClient("https://cloud.example.com/api/v1");
    expect(client.buildWsUrl("/ws")).toBe("wss://cloud.example.com/api/v1/ws");
  });
});

// ─── GET requests ────────────────────────────────────────────────────────

describe("GET requests", () => {
  it("sends correct method and path", async () => {
    setResponse(200, { success: true, data: [1, 2, 3] });
    const client = new CloudApiClient(baseUrl);
    const result = await client.get<{ success: boolean; data: number[] }>("/items");
    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toBe("/items");
    expect(result.data).toEqual([1, 2, 3]);
  });

  it("includes Authorization header when API key is set", async () => {
    setResponse(200, { success: true });
    const client = new CloudApiClient(baseUrl, "eliza_mykey");
    await client.get("/auth-check");
    expect(lastRequest.headers.authorization).toBe("Bearer eliza_mykey");
  });

  it("omits Authorization header when no API key", async () => {
    setResponse(200, { success: true });
    const client = new CloudApiClient(baseUrl);
    await client.get("/no-auth");
    expect(lastRequest.headers.authorization).toBeUndefined();
  });
});

// ─── POST requests ───────────────────────────────────────────────────────

describe("POST requests", () => {
  it("sends JSON body", async () => {
    setResponse(200, { success: true, id: "abc" });
    const client = new CloudApiClient(baseUrl, "eliza_key");
    const result = await client.post<{ id: string }>("/create", {
      name: "test",
      count: 42,
    });
    expect(lastRequest.method).toBe("POST");
    expect(JSON.parse(lastRequest.body)).toEqual({ name: "test", count: 42 });
    expect(result.id).toBe("abc");
  });

  it("includes auth header for authenticated POST", async () => {
    setResponse(200, { success: true });
    const client = new CloudApiClient(baseUrl, "eliza_secret");
    await client.post("/endpoint", { x: 1 });
    expect(lastRequest.headers.authorization).toBe("Bearer eliza_secret");
  });
});

// ─── Unauthenticated POST ────────────────────────────────────────────────

describe("postUnauthenticated", () => {
  it("does NOT send Authorization header even when API key is set", async () => {
    setResponse(200, { success: true, data: { apiKey: "eliza_new" } });
    const client = new CloudApiClient(baseUrl, "eliza_existing");
    await client.postUnauthenticated("/device-auth", { deviceId: "abc123" });
    expect(lastRequest.headers.authorization).toBeUndefined();
  });

  it("still sends Content-Type and body", async () => {
    setResponse(200, { success: true });
    const client = new CloudApiClient(baseUrl);
    await client.postUnauthenticated("/register", { platform: "macos" });
    expect(lastRequest.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(lastRequest.body)).toEqual({ platform: "macos" });
  });
});

// ─── DELETE requests ─────────────────────────────────────────────────────

describe("DELETE requests", () => {
  it("sends DELETE method without body", async () => {
    setResponse(200, { success: true });
    const client = new CloudApiClient(baseUrl, "eliza_key");
    await client.delete("/items/123");
    expect(lastRequest.method).toBe("DELETE");
    expect(lastRequest.url).toBe("/items/123");
    expect(lastRequest.body).toBe("");
  });
});

// ─── Error handling ──────────────────────────────────────────────────────

describe("error handling", () => {
  it("throws CloudApiError on 400 JSON response", async () => {
    setResponse(400, {
      success: false,
      error: "Invalid input",
      details: { field: "name" },
    });
    const client = new CloudApiClient(baseUrl);
    const err = (await client.get("/bad").catch((e) => e)) as CloudApiError;
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("Invalid input");
    expect(err.errorBody.details).toEqual({ field: "name" });
  });

  it("throws CloudApiError on 500 JSON response", async () => {
    setResponse(500, { success: false, error: "Internal server error" });
    const client = new CloudApiClient(baseUrl);
    const err = (await client.post("/explode", {}).catch((e) => e)) as CloudApiError;
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err.statusCode).toBe(500);
  });

  it("throws InsufficientCreditsError on 402 response", async () => {
    setResponse(402, {
      success: false,
      error: "Insufficient balance",
      requiredCredits: 10.5,
    });
    const client = new CloudApiClient(baseUrl);
    const err = (await client
      .post("/containers", { name: "x" })
      .catch((e) => e)) as InsufficientCreditsError;
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err.statusCode).toBe(402);
    expect(err.requiredCredits).toBe(10.5);
    expect(err.message).toBe("Insufficient balance");
  });

  it("InsufficientCreditsError defaults requiredCredits to 0 when missing", async () => {
    setResponse(402, { success: false, error: "No credits" });
    const client = new CloudApiClient(baseUrl);
    const err = (await client.get("/x").catch((e) => e)) as InsufficientCreditsError;
    expect(err.requiredCredits).toBe(0);
  });

  it("throws CloudApiError on non-JSON error response", async () => {
    setTextResponse(503, "Service Unavailable");
    const client = new CloudApiClient(baseUrl);
    const err = (await client.get("/down").catch((e) => e)) as CloudApiError;
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain("503");
  });

  it("returns {success: true} for non-JSON 200 response", async () => {
    setTextResponse(200, "OK");
    const client = new CloudApiClient(baseUrl);
    const result = await client.get<{ success: boolean }>("/health");
    expect(result.success).toBe(true);
  });

  it("throws CloudApiError for 403 quota exceeded", async () => {
    setResponse(403, {
      success: false,
      error: "Quota exceeded",
      quota: { current: 5, max: 5 },
    });
    const client = new CloudApiClient(baseUrl);
    const err = (await client.post("/containers", {}).catch((e) => e)) as CloudApiError;
    expect(err.statusCode).toBe(403);
    expect(err.errorBody.quota).toEqual({ current: 5, max: 5 });
  });
});

// ─── setBaseUrl / setApiKey mid-flight ───────────────────────────────────

describe("dynamic reconfiguration", () => {
  it("setBaseUrl changes target for subsequent requests", async () => {
    setResponse(200, { success: true });
    const client = new CloudApiClient("http://wrong-host:9999");
    client.setBaseUrl(baseUrl);
    await client.get("/works");
    expect(lastRequest.url).toBe("/works");
  });

  it("setApiKey changes auth for subsequent requests", async () => {
    setResponse(200, { success: true });
    const client = new CloudApiClient(baseUrl, "old_key");
    client.setApiKey("new_key");
    await client.get("/check");
    expect(lastRequest.headers.authorization).toBe("Bearer new_key");
  });
});
