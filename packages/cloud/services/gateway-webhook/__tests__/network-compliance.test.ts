/**
 * The Network's gateway compliance: STOP/HELP/START before any agent work, a
 * consent ledger that halts sends within one message, the Twilio proactive
 * path in /internal/deliver, and the Twilio reply idempotency fence. Eliza
 * projects are exercised alongside to prove they are unchanged.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { ChatEvent, PlatformAdapter } from "../src/adapters/types";
import { PlatformDeliveryError } from "../src/adapters/types";
import { deliverInternalMessage } from "../src/internal-delivery";
import {
  detectNetworkKeyword,
  NETWORK_KEYWORD_COPY,
  redisNetworkConsentLedger,
  sendWithTwilioReplyFence,
} from "../src/network-compliance";
import { createRedis, type GatewayRedis } from "../src/redis";
import { handleWebhook } from "../src/webhook-handler";

process.env.MOCK_REDIS = "1";
process.env.NETWORK_TWILIO_ACCOUNT_SID = "ACnetwork";
process.env.NETWORK_TWILIO_AUTH_TOKEN = "network-token";
process.env.NETWORK_TWILIO_PHONE_NUMBER = "+14155550000";
process.env.ELIZA_APP_TWILIO_ACCOUNT_SID = "ACeliza";
process.env.ELIZA_APP_TWILIO_AUTH_TOKEN = "eliza-token";
process.env.ELIZA_APP_TWILIO_PHONE_NUMBER = "+14155559999";

const MEMBER = "+14155550123";

interface CloudCall {
  project: string;
  phoneNumber: string;
  message: string;
}

let redis: GatewayRedis;
let cloud: ReturnType<typeof Bun.serve>;
const cloudCalls: CloudCall[] = [];
let duringCloudTurn: (() => Promise<void>) | undefined;
/** Durable consent entries the fake Cloud internal route accepted. */
const sent: Array<{ to: string; text: string }> = [];
const realFetch = globalThis.fetch;
const twilioRequests: URLSearchParams[] = [];
let twilioStatus = 201;

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
  };
}

let sequence = 0;
async function inbound(
  project: string,
  text: string,
  from = MEMBER,
): Promise<string> {
  sequence += 1;
  const messageId = `SMin${sequence}`;
  const event: ChatEvent = {
    platform: "twilio",
    messageId,
    chatId: from,
    senderId: from,
    text,
    rawPayload: {},
  };
  const response = await handleWebhook(
    new Request(`https://gateway.test/webhook/${project}/twilio`, {
      method: "POST",
      body: JSON.stringify(event),
    }),
    fakeTwilio,
    deps(),
    project,
  );
  expect(response.status).toBe(200);
  // Processing continues in the background after the provider ack; wait for
  // the terminal dedupe state the handler writes when it finishes.
  const key = `webhook:twilio:${messageId}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await redis.get<string>(key);
    if (state && state !== "processing") return String(state);
    await Bun.sleep(5);
  }
  throw new Error(`webhook ${messageId} did not settle`);
}

function deliverRequest(body: Record<string, unknown>) {
  return new Request("https://gateway.test/internal/deliver", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  redis = createRedis();
  cloud = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as CloudCall;
      cloudCalls.push(body);
      await duringCloudTurn?.();
      return Response.json({
        success: true,
        data: { reply: `agent reply to: ${body.message}` },
      });
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.twilio.com/")) {
      twilioRequests.push(new URLSearchParams(String(init?.body ?? "")));
      return twilioStatus < 300
        ? Response.json(
            { sid: `SMproactive${twilioRequests.length}` },
            { status: twilioStatus },
          )
        : Response.json({ message: "rejected" }, { status: twilioStatus });
    }
    return await realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  cloud.stop(true);
});

beforeEach(() => {
  cloudCalls.length = 0;
  sent.length = 0;
  twilioRequests.length = 0;
  twilioStatus = 201;
  duringCloudTurn = undefined;
});

describe("Network keyword detection", () => {
  test("matches exact carrier keywords only", () => {
    expect(detectNetworkKeyword("STOP")).toBe("opt_out");
    expect(detectNetworkKeyword(" stop. ")).toBe("opt_out");
    expect(detectNetworkKeyword("Unsubscribe!")).toBe("opt_out");
    expect(detectNetworkKeyword("opt out")).toBe("opt_out");
    expect(detectNetworkKeyword("start")).toBe("opt_in");
    expect(detectNetworkKeyword("Help?")).toBe("help");
    expect(detectNetworkKeyword("stop by later")).toBeNull();
    expect(detectNetworkKeyword("yes")).toBeNull();
    expect(detectNetworkKeyword("")).toBeNull();
  });
});

describe("Network STOP/HELP/START at the gateway", () => {
  test("STOP opts out before the agent, replies once, and halts every later send", async () => {
    const phone = "+14155550201";
    expect(await inbound("network", "STOP", phone)).toBe("delivered");
    expect(cloudCalls).toEqual([]);
    expect(sent).toEqual([{ to: phone, text: NETWORK_KEYWORD_COPY.optOut }]);
    const entry = await redisNetworkConsentLedger(redis).current(
      "network",
      phone,
    );
    expect(entry?.state).toBe("opted_out");
    expect(entry?.source).toBe("keyword:STOP");

    // An ordinary follow-up runs no turn and gets no reply.
    expect(await inbound("network", "wait what happened", phone)).toBe(
      "delivered",
    );
    expect(cloudCalls).toEqual([]);
    expect(sent).toHaveLength(1);

    // Proactive sends are refused before any claim or provider call.
    const refused = await deliverInternalMessage(
      deliverRequest({
        platform: "twilio",
        project: "network",
        phoneNumber: phone,
        text: "Ada wants to meet you",
        idempotencyKey: "intro-1",
      }),
      { redis },
    );
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      code: "recipient_opted_out",
      acceptance: "not_accepted",
    });
    expect(twilioRequests).toHaveLength(0);
  });

  test("HELP answers even when opted out; START restores the agent", async () => {
    const phone = "+14155550202";
    await inbound("network", "stop", phone);
    sent.length = 0;
    await inbound("network", "HELP", phone);
    expect(sent).toEqual([{ to: phone, text: NETWORK_KEYWORD_COPY.help }]);
    expect(cloudCalls).toEqual([]);

    await inbound("network", "START", phone);
    expect(sent.at(-1)).toEqual({
      to: phone,
      text: NETWORK_KEYWORD_COPY.optIn,
    });
    expect(
      (await redisNetworkConsentLedger(redis).current("network", phone))?.state,
    ).toBe("opted_in");

    await inbound("network", "who should I meet this week?", phone);
    expect(cloudCalls.map((call) => call.message)).toEqual([
      "who should I meet this week?",
    ]);
    expect(sent.at(-1)?.text).toBe(
      "agent reply to: who should I meet this week?",
    );
  });

  test("a STOP recorded while a turn is running suppresses that turn's reply", async () => {
    const phone = "+14155550203";
    duringCloudTurn = async () => {
      await redisNetworkConsentLedger(redis).record({
        project: "network",
        channel: "twilio",
        address: phone,
        state: "opted_out",
        source: "keyword:STOP",
        at: new Date().toISOString(),
      });
    };
    expect(await inbound("network", "any intros for me?", phone)).toBe(
      "delivered",
    );
    expect(cloudCalls).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  test("eliza-app is unchanged: STOP is ordinary text and no ledger is written", async () => {
    const phone = "+14155550204";
    expect(await inbound("eliza-app", "STOP", phone)).toBe("delivered");
    expect(cloudCalls.map((call) => [call.project, call.message])).toEqual([
      ["eliza-app", "STOP"],
    ]);
    expect(sent).toEqual([{ to: phone, text: "agent reply to: STOP" }]);
    expect(
      await redisNetworkConsentLedger(redis).current("eliza-app", phone),
    ).toBeNull();
    expect(
      await redisNetworkConsentLedger(redis).current("network", phone),
    ).toBeNull();
  });
});

describe("Twilio /internal/deliver for The Network", () => {
  test("sends a proactive SMS once and replays the receipt", async () => {
    const body = {
      platform: "twilio",
      project: "network",
      phoneNumber: "+14155550301",
      text: "Grace is free Thursday, want an intro?",
      idempotencyKey: "network:intro:grace:1",
    };
    const first = await deliverInternalMessage(deliverRequest(body), { redis });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      success: true,
      replayed: false,
      providerMessageIds: ["SMproactive1"],
    });
    expect(twilioRequests).toHaveLength(1);
    expect(twilioRequests[0]?.get("To")).toBe("+14155550301");
    expect(twilioRequests[0]?.get("From")).toBe("+14155550000");

    const replay = await deliverInternalMessage(deliverRequest(body), {
      redis,
    });
    expect(await replay.json()).toMatchObject({
      success: true,
      replayed: true,
    });
    expect(twilioRequests).toHaveLength(1);
  });

  test("an explicit Twilio rejection releases the claim for a later retry", async () => {
    twilioStatus = 400;
    const body = {
      platform: "twilio",
      project: "network",
      phoneNumber: "+14155550302",
      text: "hello",
      idempotencyKey: "network:intro:rejected",
    };
    const rejected = await deliverInternalMessage(deliverRequest(body), {
      redis,
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      claimReleased: true,
      acceptance: "not_accepted",
    });
    twilioStatus = 201;
    const retried = await deliverInternalMessage(deliverRequest(body), {
      redis,
    });
    expect(retried.status).toBe(200);
    expect(twilioRequests).toHaveLength(2);
  });

  test("non-network projects still reject Twilio proactive delivery", async () => {
    const response = await deliverInternalMessage(
      deliverRequest({
        platform: "twilio",
        project: "eliza-app",
        phoneNumber: "+14155550303",
        text: "hello",
        idempotencyKey: "eliza:1",
      }),
      { redis },
    );
    expect(response.status).toBe(400);
    expect(twilioRequests).toHaveLength(0);
  });
});

describe("Twilio reply idempotency fence", () => {
  test("a replayed inbound message cannot send its reply twice", async () => {
    let sends = 0;
    const send = async () => {
      sends += 1;
      return ["SMreply"];
    };
    const rejected = (error: unknown) =>
      error instanceof PlatformDeliveryError &&
      error.deliveryStatus === "failed";
    expect(
      await sendWithTwilioReplyFence(
        redis,
        "network",
        "SMfence1",
        send,
        rejected,
      ),
    ).toBe("sent");
    expect(
      await sendWithTwilioReplyFence(
        redis,
        "network",
        "SMfence1",
        send,
        rejected,
      ),
    ).toBe("replayed");
    expect(sends).toBe(1);
    expect(await redis.get("reply:twilio:network:SMfence1")).toMatchObject({
      state: "complete",
    });
  });

  test("an explicit rejection releases the fence; an uncertain failure keeps it", async () => {
    const rejected = (error: unknown) =>
      error instanceof PlatformDeliveryError &&
      error.deliveryStatus === "failed";
    const fail = (status: "failed" | "uncertain") => async () => {
      throw new PlatformDeliveryError(
        "twilio",
        status,
        "DELIVERY_PROVIDER_REJECTED",
        false,
        400,
      );
    };
    await expect(
      sendWithTwilioReplyFence(
        redis,
        "network",
        "SMfence2",
        fail("failed"),
        rejected,
      ),
    ).rejects.toThrow();
    expect(await redis.get("reply:twilio:network:SMfence2")).toBeNull();
    await expect(
      sendWithTwilioReplyFence(
        redis,
        "network",
        "SMfence3",
        fail("uncertain"),
        rejected,
      ),
    ).rejects.toThrow();
    expect(await redis.get("reply:twilio:network:SMfence3")).toBe(
      "indeterminate",
    );
  });

  test("a duplicate Network Twilio webhook after a reopened claim does not resend", async () => {
    const phone = "+14155550401";
    const event: ChatEvent = {
      platform: "twilio",
      messageId: "SMdup",
      chatId: phone,
      senderId: phone,
      text: "hi there",
      rawPayload: {},
    };
    const post = async () =>
      await handleWebhook(
        new Request("https://gateway.test/webhook/network/twilio", {
          method: "POST",
          body: JSON.stringify(event),
        }),
        fakeTwilio,
        deps(),
        "network",
      );
    await post();
    for (
      let i = 0;
      i < 200 && (await redis.get("webhook:twilio:SMdup")) !== "delivered";
      i++
    ) {
      await Bun.sleep(5);
    }
    // Simulate the outer webhook claim being reopened (e.g. a pre-egress
    // failure path) so the provider's retry re-runs the turn.
    await redis.del("webhook:twilio:SMdup");
    await post();
    for (
      let i = 0;
      i < 200 && (await redis.get("webhook:twilio:SMdup")) !== "delivered";
      i++
    ) {
      await Bun.sleep(5);
    }
    expect(cloudCalls).toHaveLength(2);
    expect(sent).toEqual([{ to: phone, text: "agent reply to: hi there" }]);
  });
});
