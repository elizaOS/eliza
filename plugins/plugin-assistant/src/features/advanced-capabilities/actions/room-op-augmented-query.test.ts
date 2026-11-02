/**
 * ROOM op inference on an augmented turn: the chat route can wrap the
 * request in a document-augmentation envelope before the action runs. The
 * op must come from the user's words inside the envelope, not the whole
 * envelope: the envelope's document fragments can carry a competing op
 * word (here "unmute"), and inferOpFromText checks unmute before mute, so
 * an augmented "Mute the crypto signals channel" turn must mute the room
 * just like the plain turn, not resolve to unmute.
 */

import {
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type Room,
  type State,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { roomOpAction } from "./room.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000d1" as UUID;

const AUGMENTED_TEXT = [
  "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
  "If the answer appears verbatim in the contextual documents, repeat it exactly.",
  "Do not ask follow-up questions or invoke tools/actions when the contextual documents already answer the request.",
  "",
  "<contextual_documents>",
  '<source title="room settings" similarity="0.900">',
  "Room settings: to unmute a room, open its settings and choose unmute.",
  "</source>",
  "</contextual_documents>",
  "",
  "<user_request>",
  "Mute the crypto signals channel.",
  "</user_request>",
].join("\n");

function makeRuntime() {
  const states = new Map<string, "FOLLOWED" | "MUTED" | null>();
  const rooms = new Map<string, Room>([
    [
      ROOM_ID,
      {
        id: ROOM_ID,
        name: "crypto signals",
        source: "discord",
        type: "GROUP",
      } as Room,
    ],
  ]);
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    useModel: async () => "yes",
    createMemory: async (memory: Memory) => memory.id,
    ensureParticipantInRoom: async () => {},
    getParticipantUserState: async (roomId: UUID, entityId: UUID) =>
      states.get(`${roomId}:${entityId}`) ?? null,
    updateParticipantUserState: async (
      roomId: UUID,
      entityId: UUID,
      state: "FOLLOWED" | "MUTED" | null,
    ) => {
      states.set(`${roomId}:${entityId}`, state);
    },
    getRoom: async (roomId: UUID) => rooms.get(roomId) ?? null,
    updateRoom: async (room: Room) => {
      rooms.set(room.id, room);
    },
  } as unknown as IAgentRuntime;
  return { runtime, states };
}

function msg(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000b1" as UUID,
    entityId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "discord" },
  } as Memory;
}

function state(): State {
  return {
    values: {},
    data: { room: { name: "crypto signals" } },
    text: "",
  } as unknown as State;
}

function opts(): HandlerOptions {
  return { parameters: {} } as HandlerOptions;
}

describe("ROOM op inference on an augmented turn", () => {
  it("mutes the room for a plain mute request", async () => {
    const { runtime, states } = makeRuntime();
    const result = await roomOpAction.handler(
      runtime,
      msg("Mute the crypto signals channel."),
      state(),
      opts(),
    );
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).op).toBe("mute");
    expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBe("MUTED");
  });

  it("mutes the room when a document fragment mentions unmute", async () => {
    const { runtime, states } = makeRuntime();
    const result = await roomOpAction.handler(
      runtime,
      msg(AUGMENTED_TEXT),
      state(),
      opts(),
    );
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).op).toBe("mute");
    expect(states.get(`${ROOM_ID}:${AGENT_ID}`)).toBe("MUTED");
  });
});
