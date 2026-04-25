import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { listContacts } from "../src/actions/listContacts";
import { readRecentMessages } from "../src/actions/readRecentMessages";
import { sendMessage } from "../src/actions/sendMessage";
import { SignalService } from "../src/service";

function createMessage(text: string, source = "dashboard"): Memory {
  return {
    id: "memory-1" as UUID,
    roomId: "room-1" as UUID,
    agentId: "agent-1" as UUID,
    entityId: "user-1" as UUID,
    content: {
      text,
      source,
    },
    createdAt: Date.now(),
  };
}

function createRuntime(service: Record<string, unknown>): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    character: { name: "Milady" },
    getService: vi.fn().mockImplementation((name: string) => (name === "signal" ? service : null)),
    getSetting: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("@elizaos/plugin-signal action validation", () => {
  it("allows sending from dashboard prompts when the Signal service is registered", async () => {
    const runtime = createRuntime(new SignalService());
    const message = createMessage("Reply on Signal to Dana saying I confirmed the booking.");

    await expect(sendMessage.validate(runtime, message)).resolves.toBe(true);
  });

  it("allows listing contacts from dashboard prompts when the Signal service is registered", async () => {
    const runtime = createRuntime(new SignalService());
    const message = createMessage("Show me my Signal contacts");

    await expect(listContacts.validate(runtime, message)).resolves.toBe(true);
  });
});

describe("@elizaos/plugin-signal recent message reads", () => {
  it("formats recent Signal messages from the service", async () => {
    const runtime = createRuntime({
      isServiceConnected: () => true,
      getRecentMessages: vi.fn().mockResolvedValue([
        {
          id: "msg-1",
          roomId: "room-1",
          channelId: "+15551234567",
          roomName: "Dana",
          speakerName: "Dana",
          text: "Booking confirmed.",
          createdAt: Date.UTC(2026, 3, 17, 14, 5, 0),
          isFromAgent: false,
          isGroup: false,
        },
      ]),
    });
    const callback = vi.fn();

    const result = await readRecentMessages.handler(
      runtime,
      createMessage("Check my Signal messages"),
      undefined,
      undefined,
      callback
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ messageCount: 1 }),
      })
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Dana"),
      })
    );
  });

  it("reads recent messages from stored Signal room memories", async () => {
    const runtime = {
      agentId: "agent-1",
      character: { name: "Milady" },
      getSetting: vi.fn(),
      getRoomsForParticipant: vi.fn().mockResolvedValue(["signal-room", "other-room"]),
      getRoom: vi.fn().mockImplementation(async (roomId: string) => {
        if (roomId === "signal-room") {
          return {
            id: "signal-room",
            name: "Dana",
            source: "signal",
            type: "dm",
            channelId: "+15551234567",
            metadata: {},
          };
        }
        return {
          id: "other-room",
          name: "General",
          source: "discord",
          type: "group",
          channelId: "123",
          metadata: {},
        };
      }),
      getMemoriesByRoomIds: vi.fn().mockResolvedValue([
        {
          id: "old",
          roomId: "signal-room",
          entityId: "user-1",
          content: { source: "signal", text: "Earlier", name: "Dana" },
          createdAt: 10,
        },
        {
          id: "new",
          roomId: "signal-room",
          entityId: "agent-1",
          content: { source: "signal", text: "Latest reply" },
          createdAt: 20,
        },
      ]),
    } as unknown as IAgentRuntime;

    const service = new SignalService(runtime);
    const recent = await service.getRecentMessages(1);

    expect(recent).toEqual([
      expect.objectContaining({
        id: "new",
        roomName: "Dana",
        speakerName: "Milady",
        text: "Latest reply",
        isFromAgent: true,
      }),
    ]);
  });
});
