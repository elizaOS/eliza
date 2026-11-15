/**
 * Credential prompts go to the user's origin room, not the minted task room
 * stamped on `metadata.roomId`, and the tunnel origin never carries a room UUID
 * as a platform channel id.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  emitCredentialPrompt,
  emitCredentialResolved,
  resolveCredentialOrigin,
} from "../api/credential-prompt.js";

const ORIGIN_ROOM = "11111111-1111-4111-8111-111111111111";
const TASK_ROOM = "22222222-2222-4222-8222-222222222222";

function fakeRuntime(rooms: Record<string, { channelId?: string }> = {}) {
  const sends: Array<{ source: string; roomId?: string }> = [];
  const runtime = {
    getSetting: () => null,
    getRoom: async (id: string) => rooms[id] ?? null,
    sendMessageToTarget: async (target: {
      source: string;
      roomId?: string;
    }) => {
      sends.push(target);
      return { id: "memory-1", content: { text: "" } };
    },
  } as unknown as IAgentRuntime;
  return { runtime, sends };
}

const taskRoomSession = {
  roomId: TASK_ROOM,
  originRoomId: ORIGIN_ROOM,
  channelId: "task-channel",
  source: "telegram",
  userId: "owner-1",
};

describe("credential prompt origin", () => {
  it("posts the request and the follow-up to the origin room", async () => {
    const { runtime, sends } = fakeRuntime();
    expect(
      await emitCredentialPrompt({
        runtime,
        metadata: taskRoomSession,
        credentialKeys: ["OPENAI_API_KEY"],
      }),
    ).toBe(true);
    expect(
      await emitCredentialResolved({
        runtime,
        metadata: taskRoomSession,
        key: "OPENAI_API_KEY",
      }),
    ).toBe(true);
    expect(sends).toEqual([
      { source: "telegram", roomId: ORIGIN_ROOM },
      { source: "telegram", roomId: ORIGIN_ROOM },
    ]);
  });

  it("uses the origin room's channel for the tunnel origin", async () => {
    const { runtime } = fakeRuntime({
      [ORIGIN_ROOM]: { channelId: "tg-chat-42" },
    });
    expect(await resolveCredentialOrigin(runtime, taskRoomSession)).toEqual({
      roomId: ORIGIN_ROOM,
      channelId: "tg-chat-42",
      source: "telegram",
      ownerEntityId: "owner-1",
    });
  });

  it("never uses a room UUID or the task room's channel as channelId", async () => {
    const { runtime } = fakeRuntime({ [ORIGIN_ROOM]: {} });
    const origin = await resolveCredentialOrigin(runtime, taskRoomSession);
    expect(origin?.roomId).toBe(ORIGIN_ROOM);
    expect(origin?.channelId).toBeUndefined();
  });

  it("keeps metadata.channelId for a session without a task room", async () => {
    const { runtime, sends } = fakeRuntime();
    const legacy = {
      roomId: ORIGIN_ROOM,
      channelId: "discord-123",
      source: "discord",
    };
    expect(await resolveCredentialOrigin(runtime, legacy)).toMatchObject({
      roomId: ORIGIN_ROOM,
      channelId: "discord-123",
    });
    await emitCredentialPrompt({
      runtime,
      metadata: legacy,
      credentialKeys: ["GITHUB_TOKEN"],
    });
    expect(sends).toEqual([{ source: "discord", roomId: ORIGIN_ROOM }]);
  });
});
