/**
 * Provenance guards behind `bindScheduledTaskToInboundChat` (#17747).
 *
 * The guard is fail-open: a provenance it does not recognise is BOUND to
 * outbound connector dispatch, so every sentinel core defines is asserted
 * individually rather than as a count. Binding-level cases mint real
 * process-local audience evidence via the public
 * `attestDeliveryAudienceFromCanonicalRoom` attestor so a regression that
 * drops either call site cannot pass.
 */
import {
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  type IAgentRuntime,
  MESSAGE_SOURCES,
  type Memory,
  type Room,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  bindScheduledTaskToInboundChat,
  isInternalMessageSource,
} from "./delivery-binding";

const INTERNAL_SENTINELS = Object.values(MESSAGE_SOURCES);

const OWNER = "11111111-1111-4111-8111-111111111111" as UUID;
const AGENT = "22222222-2222-4222-8222-222222222222" as UUID;
const ROOM = "44444444-4444-4444-8444-444444444444" as UUID;
const CHANNEL = "discord-dm-channel-1";

function connectorRuntime(options: {
  roomSource?: string;
  channelId?: string;
}): IAgentRuntime {
  const roomSource = options.roomSource ?? "discord";
  const channelId = options.channelId ?? CHANNEL;
  return {
    agentId: AGENT,
    getRoom: vi.fn(async (roomId: UUID) =>
      roomId === ROOM
        ? ({
            id: ROOM,
            agentId: AGENT,
            type: ChannelType.DM,
            source: roomSource,
            channelId,
            metadata: { accountId: "acct-1" },
          } as Room)
        : null,
    ),
    getParticipantsForRoom: vi.fn(async () => [OWNER, AGENT]),
    getSetting: vi.fn((key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER : undefined,
    ),
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function inboundMessage(source: string | undefined): Memory {
  return {
    id: "66666666-6666-4666-8666-666666666666" as UUID,
    entityId: OWNER,
    agentId: AGENT,
    roomId: ROOM,
    content: {
      text: "remind me at nine",
      ...(source ? { source } : {}),
      channelType: ChannelType.DM,
    },
  } as Memory;
}

async function attestedMessage(
  runtime: IAgentRuntime,
  source: string | undefined,
): Promise<Memory> {
  const message = inboundMessage(source);
  await attestDeliveryAudienceFromCanonicalRoom(runtime, message);
  return message;
}

describe("isInternalMessageSource", () => {
  it("covers every sentinel core defines", () => {
    for (const sentinel of INTERNAL_SENTINELS) {
      expect(isInternalMessageSource(sentinel)).toBe(true);
    }
    expect(INTERNAL_SENTINELS).toHaveLength(5);
  });

  it("covers the api transport label", () => {
    expect(isInternalMessageSource("api")).toBe(true);
  });

  it("does not claim real connectors", () => {
    for (const connector of ["discord", "telegram", "slack", "sms"]) {
      expect(isInternalMessageSource(connector)).toBe(false);
    }
  });

  it("treats absent or empty provenance as not-internal", () => {
    expect(isInternalMessageSource(undefined)).toBe(false);
    expect(isInternalMessageSource("")).toBe(false);
  });

  it("does not inherit Object.prototype keys", () => {
    expect(isInternalMessageSource("toString")).toBe(false);
    expect(isInternalMessageSource("constructor")).toBe(false);
  });

  it("still refuses the original denylist names (regression pin)", () => {
    expect(isInternalMessageSource("client_chat")).toBe(true);
    expect(isInternalMessageSource("api")).toBe(true);
  });

  it("refuses the four sentinels the old denylist left open", () => {
    expect(isInternalMessageSource("sub_agent")).toBe(true);
    expect(isInternalMessageSource("coding-agent")).toBe(true);
    expect(isInternalMessageSource("agent_greeting")).toBe(true);
    expect(isInternalMessageSource("trigger-prompt")).toBe(true);
  });
});

describe("bindScheduledTaskToInboundChat provenance guards", () => {
  it("binds a genuine connector DM (positive control)", async () => {
    const runtime = connectorRuntime({ roomSource: "discord" });
    const message = await attestedMessage(runtime, "discord");
    const binding = await bindScheduledTaskToInboundChat(runtime, message);
    expect(binding).toMatchObject({
      version: 1,
      source: "discord",
      roomId: ROOM,
      channelId: CHANNEL,
      accountId: "acct-1",
      audience: {
        kind: "direct",
        provenance: "canonical_room",
        ownerEntityId: OWNER,
        agentEntityId: AGENT,
      },
    });
  });

  it.each(INTERNAL_SENTINELS)(
    "returns null when message.content.source is %s",
    async (sentinel) => {
      const runtime = connectorRuntime({ roomSource: "discord" });
      const message = await attestedMessage(runtime, sentinel);
      await expect(
        bindScheduledTaskToInboundChat(runtime, message),
      ).resolves.toBeNull();
    },
  );

  it("returns null when message.metadata.source is an internal sentinel", async () => {
    const runtime = connectorRuntime({ roomSource: "discord" });
    const message = await attestedMessage(runtime, "discord");
    message.metadata = {
      ...(typeof message.metadata === "object" && message.metadata
        ? message.metadata
        : {}),
      source: "sub_agent",
    };
    await expect(
      bindScheduledTaskToInboundChat(runtime, message),
    ).resolves.toBeNull();
  });

  it("does not let connector metadata mask internal content provenance", async () => {
    const runtime = connectorRuntime({ roomSource: "discord" });
    const message = await attestedMessage(runtime, "sub_agent");
    message.metadata = {
      ...(typeof message.metadata === "object" && message.metadata
        ? message.metadata
        : {}),
      source: "discord",
    };
    await expect(
      bindScheduledTaskToInboundChat(runtime, message),
    ).resolves.toBeNull();
  });

  it.each(["client_chat", "api", "sub_agent", "coding-agent"] as const)(
    "returns null when room.source is %s",
    async (roomSource) => {
      const runtime = connectorRuntime({ roomSource });
      const message = await attestedMessage(runtime, "discord");
      await expect(
        bindScheduledTaskToInboundChat(runtime, message),
      ).resolves.toBeNull();
    },
  );

  it("returns null when channelId equals room.id (synthetic channel guard)", async () => {
    const runtime = connectorRuntime({
      roomSource: "discord",
      channelId: ROOM,
    });
    const message = await attestedMessage(runtime, "discord");
    await expect(
      bindScheduledTaskToInboundChat(runtime, message),
    ).resolves.toBeNull();
  });
});
