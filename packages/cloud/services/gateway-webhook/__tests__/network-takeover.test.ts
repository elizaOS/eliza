/**
 * The Network takeover at the gateway (thenetwork repo:
 * docs/design/eliza-conversation-layer.md). A direct Network message goes to
 * the Network service's signed /internal/turn first; handled turns are
 * answered with no agent call, open turns reach the Cloud agent route with
 * the service's member context, and a service outage reopens the webhook.
 * Integration: real handler, real HTTP to a fake service that verifies the
 * shared signature, a fake Cloud, and the mock Redis consent ledger.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { NetworkServiceClient } from "@elizaos/plugin-network/client";
import type {
  TurnRequest,
  TurnResponse,
} from "@elizaos/plugin-network/contract";
import { svcVerify } from "@elizaos/plugin-network/svc-auth";
import type { ChatEvent, PlatformAdapter } from "../src/adapters/types";
import { redisNetworkConsentLedger } from "../src/network-compliance";
import { createRedis, type GatewayRedis } from "../src/redis";
import { handleWebhook } from "../src/webhook-handler";

process.env.MOCK_REDIS = "1";
process.env.NETWORK_TWILIO_ACCOUNT_SID = "ACnetwork";
process.env.NETWORK_TWILIO_AUTH_TOKEN = "network-token";
process.env.NETWORK_TWILIO_PHONE_NUMBER = "+14155550000";

const SECRET = "takeover-test-secret-0123456789abcdef";

let redis: GatewayRedis;
let service: ReturnType<typeof Bun.serve>;
let cloud: ReturnType<typeof Bun.serve>;
const turns: Array<{ req: TurnRequest; verified: boolean }> = [];
const acknowledgements: Array<Record<string, unknown>> = [];
const cloudBodies: Array<Record<string, unknown>> = [];
const sent: Array<{ to: string; text: string }> = [];
let respond: (req: TurnRequest) => TurnResponse | Response;
let recordedHistory = true;

const fakeTwilio: PlatformAdapter = {
  platform: "twilio",
  verifyWebhook: async () => true,
  extractEvent: async (rawBody) => JSON.parse(rawBody) as ChatEvent,
  sendReply: async () => undefined,
  sendReplyWithReceipt: async (_config, event, text) => {
    sent.push({ to: event.senderId, text });
    return { providerMessageIds: [`SMout${sent.length}`] };
  },
  sendTypingIndicator: async () => undefined,
};

function deps() {
  return {
    redis,
    cloudBaseUrl: cloud.url.origin,
    getAuthHeader: () => ({ Authorization: "Bearer gateway" }),
    reacquireAuthHeader: async () => ({ Authorization: "Bearer gateway" }),
    networkService: new NetworkServiceClient({
      baseUrl: service.url.origin,
      secret: SECRET,
    }),
  };
}

let sequence = 0;
/** Sends one webhook and waits until processing ends: the terminal dedupe state, or null when the webhook was reopened. */
async function inbound(
  text: string,
  from: string,
  chatType?: string,
): Promise<string | null> {
  sequence += 1;
  const messageId = `SMtk${sequence}`;
  const event: ChatEvent = {
    platform: "twilio",
    messageId,
    chatId: from,
    senderId: from,
    text,
    ...(chatType ? { chatType } : {}),
    rawPayload: {},
  };
  const response = await handleWebhook(
    new Request("https://gateway.test/webhook/network/twilio", {
      method: "POST",
      body: JSON.stringify(event),
    }),
    fakeTwilio,
    deps(),
    "network",
  );
  expect(response.status).toBe(200);
  const key = `webhook:twilio:${messageId}`;
  for (let attempt = 0; attempt < 400; attempt++) {
    const state = await redis.get<string>(key);
    if (state !== "processing") return state === null ? null : String(state);
    await Bun.sleep(5);
  }
  throw new Error(`webhook ${messageId} did not settle`);
}

beforeAll(() => {
  process.env.SERVICE_TURN_SECRET = SECRET;
  redis = createRedis();
  service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.text();
      const url = new URL(request.url);
      const v = await svcVerify(SECRET, {
        method: request.method,
        path: url.pathname,
        headers: request.headers,
        body,
      });
      if (!v.ok) return Response.json({ error: v.reason }, { status: 401 });
      if (url.pathname === "/internal/turn-receipt") {
        acknowledgements.push(JSON.parse(body));
        return Response.json({ ok: true, replayed: false });
      }
      const req = JSON.parse(body) as TurnRequest;
      turns.push({ req, verified: v.id === req.messageId });
      const out = respond(req);
      return out instanceof Response
        ? out
        : Response.json(
            out.outcome === "handled"
              ? {
                  ...out,
                  replyIds: out.replies.map(
                    (_, i) => `${req.messageId}:reply:${i}`,
                  ),
                }
              : out,
          );
    },
  });
  cloud = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const rawBody = await request.text();
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      if (body.networkHandled) {
        const verified = await svcVerify(SECRET, {
          method: "POST",
          path: new URL(request.url).pathname,
          headers: request.headers,
          body: rawBody,
        });
        expect(verified.ok).toBe(true);
        cloudBodies.push(body);
        const handled = body.networkHandled as {
          response: { replies: string[] };
        };
        sent.push({
          to: String(body.phoneNumber),
          text: handled.response.replies.join("\n\n"),
        });
        return Response.json({
          success: true,
          data: {
            delivery: {
              ok: true,
              providerMessageIds: ["cloud-owned-receipt"],
              history: recordedHistory,
            },
          },
        });
      }
      cloudBodies.push(body);
      return Response.json({
        success: true,
        data: { reply: `agent reply to: ${String(body.message)}` },
      });
    },
  });
});

afterAll(() => {
  service.stop(true);
  cloud.stop(true);
});

beforeEach(() => {
  turns.length = 0;
  acknowledgements.length = 0;
  cloudBodies.length = 0;
  sent.length = 0;
  recordedHistory = true;
});

describe("Network takeover: the service owns the turn", () => {
  test("a handled turn uses the signed Cloud owner and acknowledges accepted history without inference", async () => {
    const phone = "+14155550701";
    respond = () => ({
      outcome: "handled",
      replyIds: [],
      delivery: "collected",
      replyKind: "reply",
      accountEligible: true,
      replies: [
        "Welcome to The Network.",
        "What are you looking for: friends, dating, or work?",
      ],
      app: "ntwrk",
      memberId: "ntwrk_m1",
      reason: "joined",
    });
    expect(await inbound("hi", phone)).toBe("delivered");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.verified).toBe(true);
    expect(turns[0]?.req).toMatchObject({
      messageId: "SMtk1",
      channel: "twilio",
      from: phone,
      text: "hi",
    });
    expect(cloudBodies).toHaveLength(1);
    expect(cloudBodies[0]).toMatchObject({
      phoneNumber: phone,
      networkHandled: {
        response: { delivery: "collected", accountEligible: true },
      },
    });
    expect(acknowledgements).toMatchObject([
      {
        outcome: "accepted",
        providerMessageIds: ["cloud-owned-receipt"],
        historyRecorded: true,
      },
    ]);
    expect(sent).toEqual([
      {
        to: phone,
        text: "Welcome to The Network.\n\nWhat are you looking for: friends, dating, or work?",
      },
    ]);
  });

  test("STOP handled by the service is mirrored into the gateway's send-time fence", async () => {
    const phone = "+14155550702";
    respond = () => ({
      outcome: "handled",
      replyIds: [],
      delivery: "collected",
      replyKind: "reply",
      accountEligible: true,
      replies: [
        "You're unsubscribed and won't get more messages from any app on this number. Reply START to resume The Network.",
      ],
      app: "ntwrk",
      memberId: "ntwrk_m2",
      reason: "stop",
      consent: {
        state: "opted_out",
        scope: "all",
        app: null,
        at: 1791540000000,
      },
    });
    expect(await inbound("STOP", phone)).toBe("delivered");
    const entry = await redisNetworkConsentLedger(redis).current(
      "network",
      phone,
    );
    expect(entry?.state).toBe("opted_out");
    expect(entry?.source).toBe("service:stop");
    expect(sent).toHaveLength(1);
  });

  test("an app-scoped leave does not stop the shared line", async () => {
    const phone = "+14155550703";
    respond = () => ({
      outcome: "handled",
      replyIds: [],
      delivery: "collected",
      replyKind: "reply",
      accountEligible: true,
      replies: ["You've left slop."],
      app: "slop",
      memberId: "slop_m3",
      reason: "left",
      consent: {
        state: "opted_out",
        scope: "app",
        app: "slop",
        at: 1791540000001,
      },
    });
    expect(await inbound("leave slop", phone)).toBe("delivered");
    expect(
      await redisNetworkConsentLedger(redis).current("network", phone),
    ).toBeNull();
  });

  test("an open turn reaches the agent with the service's member context", async () => {
    const phone = "+14155550704";
    respond = (req) => ({
      outcome: "open",
      channel: req.channel,
      app: "slop",
      memberId: "slop_m4",
      context: {
        firstName: "Ada",
        city: "nyc",
        state: "open",
        stateFrom: null,
        stateUntil: null,
        facets: ["climbs"],
        activeItems: [
          {
            id: "opp_1",
            kind: "intro",
            summary: `intro waiting (${req.messageId})`,
          },
        ],
        singlePlayer: false,
      },
    });
    expect(await inbound("what's a good first date spot?", phone)).toBe(
      "delivered",
    );
    expect(cloudBodies).toHaveLength(1);
    expect(cloudBodies[0]).toMatchObject({
      project: "network",
      phoneNumber: phone,
      networkTurn: {
        app: "slop",
        memberId: "slop_m4",
        messageId: "SMtk4",
        context: { firstName: "Ada" },
      },
    });
    expect(sent).toEqual([
      { to: phone, text: "agent reply to: what's a good first date spot?" },
    ]);
  });

  test("a service outage reopens the webhook: nothing is sent and the agent is not called", async () => {
    respond = () => new Response("down", { status: 503 });
    expect(await inbound("hello?", "+14155550705")).toBeNull();
    expect(turns).toHaveLength(1);
    expect(cloudBodies).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("group messages keep the gateway's own keyword path and never call the service", async () => {
    respond = () => {
      throw new Error("service must not be called for a group");
    };
    await inbound("STOP", "+14155550706", "group");
    expect(turns).toEqual([]);
  });

  test("NETWORK_TAKEOVER_ALLOWLIST limits the service path to listed senders", async () => {
    process.env.NETWORK_TAKEOVER_ALLOWLIST = "+14155550707";
    try {
      respond = () => ({
        outcome: "handled",
        replyIds: [],
        delivery: "collected",
        replyKind: "reply",
        accountEligible: true,
        replies: ["hi from the service"],
        app: "ntwrk",
        memberId: "m7",
        reason: "joined",
      });
      await inbound("hello", "+14155550708");
      expect(turns).toEqual([]);
      await inbound("hello", "+14155550707");
      expect(turns).toHaveLength(1);
      expect(sent.at(-1)).toEqual({
        to: "+14155550707",
        text: "hi from the service",
      });
    } finally {
      delete process.env.NETWORK_TAKEOVER_ALLOWLIST;
    }
  });
  test("canonical account-free onboarding acknowledges provider acceptance without inventing history", async () => {
    recordedHistory = false;
    respond = () => ({
      outcome: "handled",
      replies: ["Reply with your first name and age."],
      replyIds: [],
      delivery: "collected",
      replyKind: "reply",
      accountEligible: false,
      app: "ntwrk",
      memberId: null,
      reason: "onboarding_asked",
    });
    expect(await inbound("hi", "+14155550719")).toBe("delivered");
    expect(acknowledgements[0]).toMatchObject({
      outcome: "accepted",
      providerMessageIds: ["cloud-owned-receipt"],
      historyRecorded: false,
    });
    expect(cloudBodies).toHaveLength(1);
    expect(sent).toHaveLength(1);
    // A normal member reply cannot borrow the account-free onboarding receipt.
    respond = () => ({
      outcome: "handled",
      replies: ["Member reply"],
      replyIds: [],
      delivery: "collected",
      replyKind: "reply",
      accountEligible: false,
      app: "ntwrk",
      memberId: "member",
      reason: "handled",
    });
    await inbound("another question", "+14155550719");
    expect(acknowledgements[1]).toMatchObject({
      outcome: "rejected",
      providerMessageIds: [],
      historyRecorded: false,
    });
  });
});
