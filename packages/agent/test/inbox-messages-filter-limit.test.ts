/**
 * GET /api/inbox/messages against a real PGlite runtime: the source filter
 * runs after the read, so a busy room of another connector must not crowd
 * the requested source out of the page. Drives the real route handler.
 */
import type http from "node:http";
import {
  ChannelType,
  type Room,
  stringToUuid,
  type World,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { createRealTestRuntime } from "../../app/test/helpers/real-runtime.ts";
import { handleInboxRoute } from "../src/api/inbox-routes.ts";

it("returns older messages of the requested source behind a busier connector", async () => {
  const { runtime, cleanup } = await createRealTestRuntime({
    characterName: "Inbox",
  });
  try {
    const worldId = stringToUuid("inbox-world");
    const senderId = stringToUuid("inbox-sender");
    await runtime.createEntities([
      { id: senderId, agentId: runtime.agentId, names: ["Sender"] },
    ]);
    await runtime.createWorlds([
      {
        id: worldId,
        agentId: runtime.agentId,
        name: "Community",
        serverId: worldId,
      } as World,
    ]);
    const room = (source: string): Room =>
      ({
        id: stringToUuid(`inbox-room-${source}`),
        agentId: runtime.agentId,
        worldId,
        name: `${source} chat`,
        source,
        type: ChannelType.GROUP,
      }) as Room;
    const discord = room("discord");
    const telegram = room("telegram");
    await runtime.createRooms([discord, telegram]);
    await runtime.createRoomParticipants(
      [senderId, runtime.agentId],
      discord.id as never,
    );
    await runtime.createRoomParticipants(
      [senderId, runtime.agentId],
      telegram.id as never,
    );
    const post = (target: Room, index: number, createdAt: number) =>
      runtime.createMemory(
        {
          id: stringToUuid(`inbox-${target.source}-${index}`),
          agentId: runtime.agentId,
          entityId: senderId,
          roomId: target.id as never,
          createdAt,
          content: {
            text: `${target.source} message ${index}`,
            source: target.source,
          },
        },
        "messages",
      );
    for (let index = 0; index < 3; index += 1)
      await post(telegram, index, 1_000 + index);
    for (let index = 0; index < 20; index += 1)
      await post(discord, index, 5_000 + index);

    let body: { messages: Array<{ text: string }>; count: number } | undefined;
    await handleInboxRoute(
      {
        url: "/api/inbox/messages?sources=telegram&limit=5",
      } as http.IncomingMessage,
      {} as http.ServerResponse,
      "/api/inbox/messages",
      "GET",
      { runtime },
      {
        json: (_res: unknown, data: unknown) => {
          body = data as typeof body;
        },
        error: (_res: unknown, message: string) => {
          throw new Error(message);
        },
      } as never,
    );

    expect(body?.messages.map((message) => message.text)).toEqual([
      "telegram message 2",
      "telegram message 1",
      "telegram message 0",
    ]);
  } finally {
    await cleanup();
  }
}, 120_000);
