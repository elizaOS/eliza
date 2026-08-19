/** Verifies VOICE_CALL carries one confirmation-bound idempotency key into Twilio dispatch. */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendTwilioVoiceCall: vi.fn(),
}));

vi.mock("@elizaos/plugin-phone/twilio", () => ({
  readTwilioCredentialsFromEnv: vi.fn(() => ({
    accountSid: "ACtest",
    authToken: "token",
    fromPhoneNumber: "+14155550100",
  })),
  sendTwilioVoiceCall: mocks.sendTwilioVoiceCall,
}));

vi.mock("../src/lifeops/access.js", () => ({
  hasLifeOpsAccess: vi.fn(async () => true),
}));

vi.mock("../src/lifeops/service.js", () => ({
  LifeOpsService: class LifeOpsService {},
}));

import { voiceCallAction } from "../src/actions/voice-call.js";

function makeRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "agent-voice-idempotency" as UUID,
    getCache: async <T>(key: string) => (cache.get(key) as T) ?? undefined,
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  } as unknown as IAgentRuntime;
}

function message(id: string, text: string): Memory {
  return {
    id: id as UUID,
    entityId: "owner-voice-idempotency" as UUID,
    roomId: "room-voice-idempotency" as UUID,
    content: { text },
  } as Memory;
}

const parameters = {
  action: "dial",
  recipientKind: "e164",
  phoneNumber: "+14155550123",
  bodyText: "The appointment is running ten minutes late.",
};

describe("VOICE_CALL idempotency", () => {
  beforeEach(() => {
    mocks.sendTwilioVoiceCall.mockReset().mockResolvedValue({
      ok: true,
      status: 201,
      sid: "CA-test-001",
      retryCount: 1,
    });
  });

  it("holds the first turn and dispatches the confirmed turn with the draft key", async () => {
    const runtime = makeRuntime();
    const first = await voiceCallAction.handler(
      runtime,
      message("draft-message", "Call them with the appointment update."),
      { values: {}, data: {}, text: "" } as State,
      { parameters } as HandlerOptions,
    );
    expect(first).toMatchObject({
      success: false,
      data: { draft: true, awaitingUserInput: true },
    });
    expect(mocks.sendTwilioVoiceCall).not.toHaveBeenCalled();

    const confirmed = await voiceCallAction.handler(
      runtime,
      message("confirm-message", "Yes, place that exact call now."),
      { values: {}, data: {}, text: "" } as State,
      { parameters } as HandlerOptions,
    );

    expect(mocks.sendTwilioVoiceCall).toHaveBeenCalledOnce();
    const dispatched = mocks.sendTwilioVoiceCall.mock.calls[0]?.[0] as {
      idempotencyKey?: string;
    };
    expect(dispatched.idempotencyKey).toMatch(/^voice-call:/);
    expect(confirmed).toMatchObject({
      success: true,
      data: {
        sid: "CA-test-001",
        retryCount: 1,
        idempotencyKey: dispatched.idempotencyKey,
      },
    });
  });
});
