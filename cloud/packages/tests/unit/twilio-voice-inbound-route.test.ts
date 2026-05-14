import { afterEach, describe, expect, mock, test } from "bun:test";

type PhoneMapping = {
  agentId: string;
  organizationId: string;
};

type VoiceRouteState = {
  phoneMapping: PhoneMapping | null;
  insertedCalls: unknown[];
  processedMessages: unknown[];
  agentReply: string | null;
  signatureValid: boolean;
};

function setupMocks(overrides: Partial<VoiceRouteState> = {}): VoiceRouteState {
  const state: VoiceRouteState = {
    phoneMapping: {
      agentId: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
    },
    insertedCalls: [],
    processedMessages: [],
    agentReply: "The container is running and I can hear you.",
    signatureValid: true,
    ...overrides,
  };

  mock.module("@/db/helpers", () => ({
    dbWrite: {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            limit: mock(async () => (state.phoneMapping ? [state.phoneMapping] : [])),
          })),
        })),
      })),
      insert: mock(() => ({
        values: mock((value: unknown) => {
          state.insertedCalls.push(value);
          return {
            onConflictDoNothing: mock(async () => undefined),
          };
        }),
      })),
    },
  }));

  mock.module("@/lib/storage/object-store", () => ({
    offloadJsonField: mock(async ({ value }: { value: unknown }) => ({
      value,
      storage: "inline",
      key: null,
    })),
  }));

  mock.module("@/lib/utils/twilio-api", () => ({
    verifyTwilioSignature: mock(async () => state.signatureValid),
  }));

  mock.module("@/lib/services/message-router", () => ({
    messageRouterService: {
      processWithAgent: mock(
        async (_agentId: string, _organizationId: string, message: unknown) => {
          state.processedMessages.push(message);
          return state.agentReply === null ? null : { text: state.agentReply };
        },
      ),
    },
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: {
      debug: mock(() => {}),
      error: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
    },
  }));

  return state;
}

async function importRoute() {
  return import(
    new URL(
      `../../../apps/api/v1/twilio/voice/inbound/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
}

function twilioBody(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    CallSid: "CA_test",
    AccountSid: "AC_test",
    From: "+15551234567",
    To: "+15550000000",
    CallStatus: "in-progress",
    ...overrides,
  }).toString();
}

async function callVoiceRoute(body: string): Promise<Response> {
  const route = (await importRoute()).default;
  return route.request(
    "https://api.elizacloud.ai/",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "valid-signature",
      },
      body,
    },
    {
      TWILIO_AUTH_TOKEN: "twilio-secret",
    },
  );
}

describe("Twilio voice inbound route", () => {
  afterEach(() => {
    mock.restore();
  });

  test("starts a speech Gather loop for a mapped voice number", async () => {
    const state = setupMocks();

    const response = await callVoiceRoute(twilioBody());
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
    expect(xml).toContain('<Gather input="speech"');
    expect(xml).toContain("Hi, you&apos;re connected to Eliza");
    expect(state.insertedCalls).toHaveLength(1);
    expect(state.processedMessages).toHaveLength(0);
  }, 15_000);

  test("routes recognized speech to the mapped agent and speaks the response", async () => {
    const state = setupMocks();

    const response = await callVoiceRoute(
      twilioBody({
        SpeechResult: "Is my container running?",
        Confidence: "0.94",
      }),
    );
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain('<Gather input="speech"');
    expect(xml).toContain("The container is running and I can hear you.");
    expect(state.insertedCalls).toHaveLength(1);
    expect(state.processedMessages).toHaveLength(1);
    expect(state.processedMessages[0]).toMatchObject({
      from: "+15551234567",
      to: "+15550000000",
      body: "Is my container running?",
      provider: "twilio",
      providerMessageId: "CA_test",
      messageType: "voice",
      metadata: {
        callSid: "CA_test",
        confidence: "0.94",
        source: "twilio-voice",
      },
    });
  }, 15_000);

  test("fails closed with TwiML when the receiving number is not voice-mapped", async () => {
    const state = setupMocks({ phoneMapping: null });

    const response = await callVoiceRoute(
      twilioBody({
        SpeechResult: "Hello?",
      }),
    );
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).toContain("This phone number is not configured for voice yet");
    expect(xml).not.toContain("<Gather");
    expect(state.insertedCalls).toHaveLength(1);
    expect(state.processedMessages).toHaveLength(0);
  }, 15_000);
});
