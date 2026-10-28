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

function relationship(id: string, name: string, phone: string, notes = "") {
  return {
    id,
    agentId: AGENT_ID,
    name,
    primaryChannel: "phone",
    primaryHandle: phone,
    email: null,
    phone,
    notes,
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

describe("VOICE_CALL confirmation and recipient binding", () => {
  const savedAllowList = process.env.TWILIO_CALL_EXTERNAL_ALLOWLIST;
  const savedOwnerNumber = process.env.TWILIO_OWNER_NUMBER;

  function dial(
    runtime: IAgentRuntime,
    text: string,
    parameters: Record<string, unknown>,
  ) {
    return voiceCallAction.handler(runtime, makeMessage(text), undefined, {
      parameters: { action: "dial", ...parameters },
    });
  }

  beforeEach(() => {
    process.env.TWILIO_CALL_EXTERNAL_ALLOWLIST = "+14155550111,+14155550222";
    process.env.TWILIO_OWNER_NUMBER = "+14155550100";
    twilio.sendTwilioVoiceCall.mockReset();
    twilio.sendTwilioVoiceCall.mockResolvedValue({
      ok: true,
      sid: "CA123",
      status: 201,
    });
    vi.spyOn(LifeOpsService.prototype, "listRelationships").mockResolvedValue([
      relationship("rel-alice", "Alice", "+14155550111"),
      relationship("rel-bob", "Bob", "+14155550222"),
    ] as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, saved] of [
      ["TWILIO_CALL_EXTERNAL_ALLOWLIST", savedAllowList],
      ["TWILIO_OWNER_NUMBER", savedOwnerNumber],
    ] as const) {
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
  });

  it("previews a changed message instead of speaking it on yes", async () => {
    const runtime = makeRuntime();
    const e164 = { recipientKind: "e164", phoneNumber: "+14155550123" };

    await dial(runtime, "call them", { ...e164, bodyText: "Running late" });
    const changed = await dial(runtime, "yes", {
      ...e164,
      bodyText: "Wire the 5000 dollars today",
    });

    expect(twilio.sendTwilioVoiceCall).not.toHaveBeenCalled();
    expect(changed?.data?.draft).toBe(true);
    expect(changed?.text).toContain("Wire the 5000 dollars today");

    const confirmed = await dial(runtime, "yes", {
      ...e164,
      bodyText: "Wire the 5000 dollars today",
    });

    expect(confirmed?.success).toBe(true);
    expect(twilio.sendTwilioVoiceCall).toHaveBeenCalledTimes(1);
    expect(twilio.sendTwilioVoiceCall.mock.calls[0]?.[0]?.message).toBe(
      "Wire the 5000 dollars today",
    );
  });

  it("speaks the previewed message when the confirming call omits bodyText", async () => {
    const runtime = makeRuntime();

    await dial(runtime, "call me about the build", {
      recipientKind: "owner",
      bodyText: "The build is done.",
    });
    const confirmed = await dial(runtime, "yes", { recipientKind: "owner" });

    expect(confirmed?.success).toBe(true);
    expect(twilio.sendTwilioVoiceCall.mock.calls[0]?.[0]?.message).toBe(
      "The build is done.",
    );
  });

  it("drafts the owner call when the request mentions blocked browser work", async () => {
    const runtime = makeRuntime();
    const text = "My browser is blocked on the login page, call me now.";
    const owner = { recipientKind: "owner", bodyText: "You asked me to call." };

    const draft = await dial(runtime, text, owner);

    expect(draft?.success).toBe(false);
    expect(draft?.data?.requiresConfirmation).toBe(true);
    expect(draft?.text).toContain("You asked me to call.");
    expect(draft?.values?.policyRecorded).toBeUndefined();

    const confirmed = await dial(runtime, "yes", owner);

    expect(confirmed?.success).toBe(true);
    expect(twilio.sendTwilioVoiceCall).toHaveBeenCalledTimes(1);
  });

  it("calls the declared recipient, not a contact the message only mentions", async () => {
    const runtime = makeRuntime();
    const external = {
      recipientKind: "external",
      recipient: "Bob",
      bodyText: "Dinner at 7?",
    };

    const draft = await dial(
      runtime,
      "Alice asked me to call Bob about dinner",
      external,
    );

    expect(draft?.data?.to).toBe("+14155550222");
    expect(draft?.text).toContain("Bob (+14155550222)");

    const confirmed = await dial(runtime, "yes", external);

    expect(confirmed?.success).toBe(true);
    expect(twilio.sendTwilioVoiceCall).toHaveBeenCalledTimes(1);
    expect(twilio.sendTwilioVoiceCall.mock.calls[0]?.[0]?.to).toBe(
      "+14155550222",
    );
  });

  it("calls the contact whose whole name was given when another name contains it", async () => {
    vi.spyOn(LifeOpsService.prototype, "listRelationships").mockResolvedValue([
      relationship("rel-alice", "Bob Alison", "+14155550111"),
      relationship("rel-bob", "Bob", "+14155550222"),
    ] as never);

    const draft = await dial(makeRuntime(), "call Bob", {
      recipientKind: "external",
      recipient: "Bob",
    });

    expect(draft?.data?.error).toBeUndefined();
    expect(draft?.data?.to).toBe("+14155550222");

    const partial = await dial(makeRuntime(), "call Bo", {
      recipientKind: "external",
      recipient: "Bo",
    });

    expect(partial?.data?.error).toBe("AMBIGUOUS_RECIPIENT");
  });

  it("matches contact names as whole words, not inside other names", async () => {
    vi.spyOn(LifeOpsService.prototype, "listRelationships").mockResolvedValue([
      relationship("rel-joanna", "Joanna Park", "+14155550111"),
    ] as never);
    const shorter = await dial(makeRuntime(), "call Ann", {
      recipientKind: "external",
      recipient: "Ann",
    });
    expect(shorter?.data?.matchedRelationshipId).toBeUndefined();
    expect(shorter?.data?.to).not.toBe("+14155550111");

    vi.spyOn(LifeOpsService.prototype, "listRelationships").mockResolvedValue([
      relationship("rel-al", "Al", "+14155550111"),
    ] as never);
    const longer = await dial(makeRuntime(), "call Alice", {
      recipientKind: "external",
      recipient: "Alice",
    });
    expect(longer?.data?.matchedRelationshipId).toBeUndefined();
    expect(longer?.data?.to).not.toBe("+14155550111");
    expect(twilio.sendTwilioVoiceCall).not.toHaveBeenCalled();
  });

  it("does not pick a contact because the recipient appears in its notes", async () => {
    vi.spyOn(LifeOpsService.prototype, "listRelationships").mockResolvedValue([
      relationship("rel-dan", "Dan", "+14155550111", "Alice's brother"),
    ] as never);

    const draft = await dial(makeRuntime(), "call Alice", {
      recipientKind: "external",
      recipient: "Alice",
    });

    expect(draft?.data?.matchedRelationshipId).toBeUndefined();
    expect(draft?.data?.to).not.toBe("+14155550111");
  });

  it("finds the named contact in the message text without matching inside words", async () => {
    vi.spyOn(LifeOpsService.prototype, "listRelationships").mockResolvedValue([
      relationship("rel-al", "Al", "+14155550111"),
      relationship("rel-bob", "Bob", "+14155550222"),
    ] as never);

    const draft = await dial(makeRuntime(), "call Bob", {
      recipientKind: "external",
    });

    expect(draft?.data?.error).toBeUndefined();
    expect(draft?.data?.to).toBe("+14155550222");
    expect(draft?.data?.matchedRelationshipId).toBe("rel-bob");
  });

  it("asks which contact when the message text names more than one", async () => {
    const result = await dial(
      makeRuntime(),
      "Alice asked me to call Bob about dinner",
      { recipientKind: "external" },
    );

    expect(result?.data?.error).toBe("AMBIGUOUS_RECIPIENT");
    expect(result?.data?.candidates).toEqual(["Alice", "Bob"]);
    expect(twilio.sendTwilioVoiceCall).not.toHaveBeenCalled();
  });
});
