import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { afterEach, describe, expect, it } from "vitest";
import { applyScenarioSeedStep } from "./seeds.ts";

type MockRequest = {
  method: string;
  path: string;
  body: Record<string, unknown>;
};

let activeServer: http.Server | null = null;
const originalGoogleBase = process.env.ELIZA_MOCK_GOOGLE_BASE;

afterEach(async () => {
  process.env.ELIZA_MOCK_GOOGLE_BASE = originalGoogleBase;
  if (!activeServer) return;
  await new Promise<void>((resolve, reject) => {
    activeServer?.close((error) => (error ? reject(error) : resolve()));
  });
  activeServer = null;
});

async function readRequestBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function startGmailSeedMock(): Promise<{
  baseUrl: string;
  requests: MockRequest[];
}> {
  const requests: MockRequest[] = [];
  const fixtureIds = new Set(["msg-finance", "msg-sarah", "msg-newsletter"]);

  activeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = (req.method ?? "GET").toUpperCase();
    const body = await readRequestBody(req);
    requests.push({ method, path: url.pathname, body });

    if (method === "DELETE" && url.pathname === "/__mock/google/gmail/fault") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (method === "DELETE" && url.pathname === "/__mock/requests") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (method === "POST" && url.pathname === "/__mock/google/gmail/fault") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, fault: body }));
      return;
    }
    const messageId = url.pathname.match(
      /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/,
    )?.[1];
    if (method === "GET" && messageId && fixtureIds.has(messageId)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: messageId, threadId: messageId }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    activeServer?.once("error", reject);
    activeServer?.listen(0, "127.0.0.1", () => resolve());
  });

  const address = activeServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Gmail seed mock did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    requests,
  };
}

const ctx: ScenarioContext = { actionsCalled: [] };

describe("scenario seeds", () => {
  it("forwards gmailInbox faultInjection to the loopback Google mock", async () => {
    const { baseUrl, requests } = await startGmailSeedMock();
    process.env.ELIZA_MOCK_GOOGLE_BASE = baseUrl;

    const result = await applyScenarioSeedStep(ctx, {
      type: "gmailInbox",
      fixture: "default",
      faultInjection: { mode: "server_error", method: "GET", limit: 0 },
    });

    expect(result).toBeUndefined();
    expect(
      requests.map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "DELETE /__mock/google/gmail/fault",
      "GET /gmail/v1/users/me/messages/msg-finance",
      "GET /gmail/v1/users/me/messages/msg-sarah",
      "GET /gmail/v1/users/me/messages/msg-newsletter",
      "DELETE /__mock/requests",
      "POST /__mock/google/gmail/fault",
    ]);
    expect(requests.at(-1)?.body).toEqual({
      mode: "server_error",
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      remaining: 0,
    });
  });

  it("rejects unsupported gmailInbox faultInjection modes", async () => {
    const { baseUrl } = await startGmailSeedMock();
    process.env.ELIZA_MOCK_GOOGLE_BASE = baseUrl;

    const result = await applyScenarioSeedStep(ctx, {
      type: "gmailInbox",
      faultInjection: { mode: "partial_failure" },
    });

    expect(result).toContain("faultInjection.mode");
  });

  it("rejects invalid gmailInbox faultInjection limits", async () => {
    const { baseUrl } = await startGmailSeedMock();
    process.env.ELIZA_MOCK_GOOGLE_BASE = baseUrl;

    const result = await applyScenarioSeedStep(ctx, {
      type: "gmailInbox",
      faultInjection: { mode: "server_error", limit: -1 },
    });

    expect(result).toContain("faultInjection.limit");
  });
});
