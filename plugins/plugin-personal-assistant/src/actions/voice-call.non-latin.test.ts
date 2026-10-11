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

async function callTwice(
  runtime: IAgentRuntime,
  text: string,
  recipient?: string,
  confirmText = "yes",
) {
  const parameters = {
    action: "dial",
    recipientKind: "external",
    ...(recipient ? { recipient } : {}),
  };
  const draft = await voiceCallAction.handler(
    runtime,
    makeMessage(text),
    undefined,
    { parameters },
  );
  const confirmed = await voiceCallAction.handler(
    runtime,
    makeMessage(confirmText),
    undefined,
    { parameters },
  );
  return { draft, confirmed };
}

describe("VOICE_CALL external recipient with non-Latin contact names", () => {
  const savedAllowList = process.env.TWILIO_CALL_EXTERNAL_ALLOWLIST;

  beforeEach(() => {
    process.env.TWILIO_CALL_EXTERNAL_ALLOWLIST =
      "+821012345678,+819012345678,+15551230000";
    twilio.sendTwilioVoiceCall.mockReset();
    twilio.sendTwilioVoiceCall.mockResolvedValue({
      ok: true,
      sid: "CA123",
      status: 201,
    });
    vi.spyOn(LifeOpsService.prototype, "listRelationships").mockResolvedValue([
      relationship("rel-ko", "김민수", "+821012345678"),
      relationship("rel-ja", "田中", "+819012345678"),
      relationship("rel-en", "Alice Smith", "+15551230000"),
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

  it("resolves a Korean contact name to its saved phone and dials it", async () => {
    const { draft, confirmed } = await callTwice(
      makeRuntime(),
      "김민수에게 전화해줘",
      "김민수",
    );

    expect(draft?.data?.error).not.toBe("MISSING_RECIPIENT");
    expect(draft?.data?.to).toBe("+821012345678");
    expect(draft?.data?.matchedRelationshipId).toBe("rel-ko");
    expect(confirmed?.success).toBe(true);
    expect(twilio.sendTwilioVoiceCall).toHaveBeenCalledTimes(1);
    expect(twilio.sendTwilioVoiceCall.mock.calls[0]?.[0]?.to).toBe(
      "+821012345678",
    );
  });

  it("finds a Japanese contact name inside the message text", async () => {
    const { draft, confirmed } = await callTwice(
      makeRuntime(),
      "田中さんに電話して",
      undefined,
      "はい、田中さんに電話して",
    );

    expect(draft?.data?.error).not.toBe("MISSING_RECIPIENT");
    expect(draft?.data?.to).toBe("+819012345678");
    expect(confirmed?.success).toBe(true);
    expect(twilio.sendTwilioVoiceCall.mock.calls[0]?.[0]?.to).toBe(
      "+819012345678",
    );
  });

  it("still resolves a Latin contact name", async () => {
    const { draft, confirmed } = await callTwice(
      makeRuntime(),
      "Call Alice Smith please",
      "Alice Smith",
    );

    expect(draft?.data?.to).toBe("+15551230000");
    expect(draft?.data?.matchedRelationshipId).toBe("rel-en");
    expect(confirmed?.success).toBe(true);
    expect(twilio.sendTwilioVoiceCall.mock.calls[0]?.[0]?.to).toBe(
      "+15551230000",
    );
  });
});
