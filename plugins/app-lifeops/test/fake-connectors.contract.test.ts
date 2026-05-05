import type http from "node:http";
import { ElizaClient } from "@elizaos/app-core/api/client-base";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/api/client-lifeops.js";
import { dispatchCrossChannelSend } from "../src/actions/cross-channel-send.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import {
  handleLifeOpsRoutes,
  type LifeOpsRouteContext,
} from "../src/routes/lifeops-routes.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000f00d";
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

function createContext(
  method: string,
  path: string,
  overrides: Partial<LifeOpsRouteContext> = {},
): {
  context: LifeOpsRouteContext;
  error: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  readJsonBody: ReturnType<typeof vi.fn>;
} {
  const url = new URL(path, "http://127.0.0.1:31337");
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn(async () => ({}));
  const context: LifeOpsRouteContext = {
    req: {
      url: `${url.pathname}${url.search}`,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    res: {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as http.ServerResponse,
    method,
    pathname: url.pathname,
    url,
    state: {
      runtime: { agentId: AGENT_ID } as LifeOpsRouteContext["state"]["runtime"],
      adminEntityId: null,
    },
    json,
    error,
    readJsonBody,
    decodePathComponent: (raw) => decodeURIComponent(raw),
    ...overrides,
  };

  return {
    context,
    error,
    json,
    readJsonBody: context.readJsonBody as ReturnType<typeof vi.fn>,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("LifeOps fake connector client contracts", () => {
  it("serializes Google connector status and start without Gmail manage scopes", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        connected: false,
        mode: "local",
        defaultMode: "local",
        availableModes: ["local", "cloud_managed"],
        reason: "disconnected",
        identity: null,
        grantedCapabilities: [],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ElizaClient({ baseUrl: "http://127.0.0.1:31337" });

    await client.getGoogleLifeOpsConnectorStatus("local", "owner");
    await client.startGoogleLifeOpsConnector({
      mode: "local",
      side: "owner",
      capabilities: ["google.gmail.triage", "google.calendar.read"],
    });

    const [statusUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(statusUrl).toMatch(
      /\/api\/lifeops\/connectors\/google\/status\?mode=local&side=owner$/,
    );

    const [startUrl, startInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(startUrl).toMatch(/\/api\/lifeops\/connectors\/google\/start$/);
    expect(startInit.method).toBe("POST");
    expect(JSON.parse(String(startInit.body))).toEqual({
      mode: "local",
      side: "owner",
      capabilities: ["google.gmail.triage", "google.calendar.read"],
    });
    expect(String(startInit.body)).not.toContain("google.gmail.manage");
  });

  it("serializes messaging status and send bodies to connector routes", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ connected: true, provider: "whatsapp" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ElizaClient({ baseUrl: "http://127.0.0.1:31337" });

    await client.getWhatsAppConnectorStatus();
    await client.sendWhatsAppConnectorMessage({
      to: "+15551234567",
      text: "fake connector ping",
    });

    const [statusUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(statusUrl).toMatch(/\/api\/lifeops\/connectors\/whatsapp\/status$/);

    const [sendUrl, sendInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(sendUrl).toMatch(/\/api\/lifeops\/connectors\/whatsapp\/send$/);
    expect(sendInit.method).toBe("POST");
    expect(JSON.parse(String(sendInit.body))).toEqual({
      to: "+15551234567",
      text: "fake connector ping",
    });
  });
});

describe("LifeOps fake connector route contracts", () => {
  it("returns Google status with Gmail and Calendar capability separation", async () => {
    const getGoogleConnectorStatus = vi
      .spyOn(LifeOpsService.prototype, "getGoogleConnectorStatus")
      .mockResolvedValue({
        connected: true,
        mode: "local",
        defaultMode: "local",
        availableModes: ["local", "cloud_managed"],
        reason: "connected",
        identity: { email: "owner@example.test" },
        grantedCapabilities: [
          "google.gmail.triage",
          "google.calendar.read",
          "google.calendar.manage",
        ],
      });
    const { context, error, json } = createContext(
      "GET",
      "/api/lifeops/connectors/google/status?mode=local&side=owner&grantId=grant-google-1",
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(getGoogleConnectorStatus).toHaveBeenCalledWith(
      expect.any(URL),
      "local",
      "owner",
      "grant-google-1",
    );
    expect(json).toHaveBeenCalledWith(
      context.res,
      expect.objectContaining({
        connected: true,
        grantedCapabilities: expect.arrayContaining([
          "google.gmail.triage",
          "google.calendar.read",
        ]),
      }),
    );
    const response = json.mock.calls[0]?.[1] as {
      grantedCapabilities: string[];
    };
    expect(response.grantedCapabilities).not.toContain("google.gmail.manage");
    expect(response.grantedCapabilities).toContain("google.calendar.manage");
  });

  it("passes Gmail read query shape and Calendar feed query shape separately", async () => {
    const getGmailSearch = vi
      .spyOn(LifeOpsService.prototype, "getGmailSearch")
      .mockResolvedValue({
        messages: [],
        source: "synced",
        syncedAt: "2026-05-04T12:00:00.000Z",
      });
    const getCalendarFeed = vi
      .spyOn(LifeOpsService.prototype, "getCalendarFeed")
      .mockResolvedValue({
        events: [],
        source: "synced",
        syncedAt: "2026-05-04T12:00:00.000Z",
      });

    await expect(
      handleLifeOpsRoutes(
        createContext(
          "GET",
          "/api/lifeops/gmail/search?side=owner&mode=local&grantId=grant-gmail-1&query=from%3Aalice&forceSync=true&replyNeededOnly=true&includeSpamTrash=false&maxResults=5",
        ).context,
      ),
    ).resolves.toBe(true);
    await expect(
      handleLifeOpsRoutes(
        createContext(
          "GET",
          "/api/lifeops/calendar/feed?side=owner&mode=local&grantId=grant-cal-1&calendarId=primary&timeMin=2026-05-04T00%3A00%3A00.000Z&timeMax=2026-05-05T00%3A00%3A00.000Z&timeZone=America%2FLos_Angeles&forceSync=true",
        ).context,
      ),
    ).resolves.toBe(true);

    expect(getGmailSearch).toHaveBeenCalledWith(expect.any(URL), {
      mode: "local",
      side: "owner",
      forceSync: true,
      maxResults: 5,
      query: "from:alice",
      replyNeededOnly: true,
      includeSpamTrash: false,
      grantId: "grant-gmail-1",
    });
    expect(getCalendarFeed).toHaveBeenCalledWith(expect.any(URL), {
      mode: "local",
      side: "owner",
      calendarId: "primary",
      includeHiddenCalendars: undefined,
      timeMin: "2026-05-04T00:00:00.000Z",
      timeMax: "2026-05-05T00:00:00.000Z",
      timeZone: "America/Los_Angeles",
      forceSync: true,
      grantId: "grant-cal-1",
    });
  });

  it("routes a messaging connector status and send path through fake service methods", async () => {
    const getWhatsAppConnectorStatus = vi
      .spyOn(LifeOpsService.prototype, "getWhatsAppConnectorStatus")
      .mockResolvedValue({
        connected: true,
        available: true,
        reason: "connected",
        identity: { phoneNumber: "+15550001111" },
      });
    const sendWhatsAppMessage = vi
      .spyOn(LifeOpsService.prototype, "sendWhatsAppMessage")
      .mockResolvedValue({ ok: true, messageId: "wa-fake-1" });
    const sendBody = { to: "+15551234567", text: "shape check" };

    const status = createContext(
      "GET",
      "/api/lifeops/connectors/whatsapp/status",
    );
    const send = createContext(
      "POST",
      "/api/lifeops/connectors/whatsapp/send",
      { readJsonBody: vi.fn(async () => sendBody) },
    );

    await expect(handleLifeOpsRoutes(status.context)).resolves.toBe(true);
    await expect(handleLifeOpsRoutes(send.context)).resolves.toBe(true);

    expect(getWhatsAppConnectorStatus).toHaveBeenCalledWith();
    expect(status.json).toHaveBeenCalledWith(
      status.context.res,
      expect.objectContaining({ connected: true }),
    );
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(sendBody);
    expect(send.json).toHaveBeenCalledWith(
      send.context.res,
      { ok: true, messageId: "wa-fake-1" },
      201,
    );
  });

  it("rate-limits the sensitive Gmail send route after two fake sends", async () => {
    const agentId = "00000000-0000-0000-0000-00000000f0aa";
    const sendGmailMessage = vi
      .spyOn(LifeOpsService.prototype, "sendGmailMessage")
      .mockResolvedValue({ ok: true, id: "gmail-fake-send" });
    const readJsonBody = vi.fn(async () => ({
      to: ["alice@example.test"],
      subject: "Sensitive send",
      bodyText: "This should only send inside the fake service.",
      confirmSend: true,
    }));
    const { context } = createContext(
      "POST",
      "/api/lifeops/gmail/message-send",
      {
        readJsonBody,
        state: {
          runtime: { agentId } as LifeOpsRouteContext["state"]["runtime"],
          adminEntityId: null,
        },
      },
    );

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);

    expect(sendGmailMessage).toHaveBeenCalledTimes(2);
    expect(context.res.writeHead).toHaveBeenCalledWith(429, {
      "Retry-After": expect.any(String),
    });
    expect(context.res.end).toHaveBeenCalledWith(
      expect.stringContaining("Rate limit exceeded"),
    );
  });
});

describe("LifeOps fake connector action contracts", () => {
  it("dispatches a messaging send through runtime target metadata", async () => {
    const captured: unknown[] = [];
    const runtime = {
      agentId: AGENT_ID,
      sendMessageToTarget: async (...args: unknown[]) => {
        captured.push(args);
      },
    } as unknown as IAgentRuntime;

    const result = await dispatchCrossChannelSend({
      runtime,
      service: {},
      channel: "signal",
      target: "+15557654321",
      body: "runtime fake send",
    });

    expect(captured).toEqual([
      [
        { source: "signal", channelId: "+15557654321" },
        { text: "runtime fake send", source: "signal" },
      ],
    ]);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      actionName: "OWNER_SEND_MESSAGE",
      channel: "signal",
      target: "+15557654321",
      message: "runtime fake send",
    });
  });

  it("dispatches Ntfy notifications through a fake HTTP adapter", async () => {
    process.env.NTFY_BASE_URL = "https://ntfy.fake";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "ntfy-fake-1", time: 1_777_777_777 }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await dispatchCrossChannelSend({
      runtime: { agentId: AGENT_ID } as unknown as IAgentRuntime,
      service: {},
      channel: "notifications",
      target: "owner-topic",
      subject: "Follow up",
      body: "Reminder fake behavior",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ntfy.fake/owner-topic");
    expect(init.body).toBe("Reminder fake behavior");
    expect(init.headers).toMatchObject({
      Title: "Follow up",
      Priority: "3",
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      actionName: "OWNER_SEND_MESSAGE",
      channel: "notifications",
      target: "owner-topic",
      message: "Reminder fake behavior",
      result: { messageId: "ntfy-fake-1" },
    });
  });
});
