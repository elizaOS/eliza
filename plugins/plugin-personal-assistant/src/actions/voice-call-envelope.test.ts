import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const twilio = vi.hoisted(() => ({
  sendTwilioVoiceCall: vi.fn(),
}));

vi.mock("@elizaos/plugin-native-phone/twilio", () => ({
  readTwilioCredentialsFromEnv: () => ({
    accountSid: "AC00000000000000000000000000000000",
    authToken: "test-token",
    fromPhoneNumber: "+15550000001",
  }),
  sendTwilioVoiceCall: twilio.sendTwilioVoiceCall,
}));

vi.mock("../lifeops/access.js", () => ({
  hasLifeOpsAccess: async () => true,
}));

import { LifeOpsService } from "../lifeops/service.js";
import { voiceCallAction } from "./voice-call.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000003" as UUID;

const USER_WORDS = "Call Alice Smith.";
const ENVELOPED =
  "Answer the user request using the contextual documents below.\n\n" +
  "Document: a note about family routines — Bob Jones called yesterday about the invoice.\n\n" +
  `<user_request>${USER_WORDS}</user_request>`;

function relationship(id: string, name: string, phone: string) {
  return {
    id,
    agentId: AGENT_ID,
    name,
    primaryChannel: "phone",
    primaryHandle: phone,
    email: null,
    phone,
    notes: "",
    tags: [],
    relationshipType: "friend",
    lastContactedAt: null,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: AGENT_ID,
    getSetting: () => undefined,
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    deleteTask: async () => undefined,
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: OWNER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "test" },
  } as Memory;
}

function dial(runtime: IAgentRuntime, text: string) {
  return voiceCallAction.handler(runtime, makeMessage(text), undefined, {
    parameters: { action: "dial", recipientKind: "external" },
  });
}

describe("VOICE_CALL external recipient under document augmentation", () => {
  const savedAllowList = process.env.TWILIO_CALL_EXTERNAL_ALLOWLIST;

  beforeEach(() => {
    process.env.TWILIO_CALL_EXTERNAL_ALLOWLIST =
      "+15551230000,+15551234444";
    twilio.sendTwilioVoiceCall.mockReset();
    twilio.sendTwilioVoiceCall.mockResolvedValue({
      ok: true,
      sid: "CA123",
      status: 201,
    });
    vi.spyOn(LifeOpsService.prototype, "listRelationships").mockResolvedValue([
      relationship("rel-alice", "Alice Smith", "+15551230000"),
      relationship("rel-bob", "Bob Jones", "+15551234444"),
    ] as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedAllowList === undefined) {
      delete process.env.TWILIO_CALL_EXTERNAL_ALLOWLIST;
    } else {
      process.env.TWILIO_CALL_EXTERNAL_ALLOWLIST = savedAllowList;
    }
  });

  it("drafts a call to the plainly named contact", async () => {
    const draft = await dial(makeRuntime(), USER_WORDS);

    expect(draft?.data?.error).toBeUndefined();
    expect(draft?.data?.to).toBe("+15551230000");
    expect(draft?.data?.matchedRelationshipId).toBe("rel-alice");
  });

  it("does not let a document-only name make the call ambiguous", async () => {
    const draft = await dial(makeRuntime(), ENVELOPED);

    expect(draft?.data?.error).not.toBe("AMBIGUOUS_RECIPIENT");
    expect(draft?.data?.to).toBe("+15551230000");
    expect(draft?.data?.matchedRelationshipId).toBe("rel-alice");
    expect(twilio.sendTwilioVoiceCall).not.toHaveBeenCalled();
  });
});
