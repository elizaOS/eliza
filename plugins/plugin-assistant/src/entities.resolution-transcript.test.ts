/**
 * findEntityByName's model-facing transcript against a real in-memory SQLite
 * runtime: pronouns resolve against the latest mention, so the room history
 * must reach the resolution prompt oldest-first. Only the model is a stub.
 */

import {
  ChannelType,
  type Memory,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { findEntityByName } from "./entities.ts";

it("gives the resolution prompt the room history oldest-first", async () => {
  const prompts: string[] = [];
  const runtime = createSQLiteTestRuntime({
    character: { name: "Router", bio: "test" },
    logLevel: "fatal",
    plugins: [
      {
        name: "capture-resolution-prompt",
        description: "Captures the entity resolution prompt",
        models: {
          [ModelType.TEXT_SMALL]: async (
            _runtime,
            params: { prompt: string },
          ) => {
            prompts.push(params.prompt);
            return JSON.stringify({ type: "UNKNOWN", matches: [] });
          },
        },
      },
    ],
  });
  await runtime.initialize({ skipMigrations: true });
  const ownerId = stringToUuid("resolution-owner");
  const bobId = stringToUuid("resolution-bob");
  const daveId = stringToUuid("resolution-dave");
  const worldId = stringToUuid("resolution-world");
  const roomId = stringToUuid("resolution-room");
  await runtime.createEntities([
    { id: ownerId, agentId: runtime.agentId, names: ["Owner"] },
    { id: bobId, agentId: runtime.agentId, names: ["Bob"] },
    { id: daveId, agentId: runtime.agentId, names: ["Dave"] },
  ]);
  await runtime.createWorlds([
    { id: worldId, agentId: runtime.agentId, name: "Team", serverId: worldId },
  ]);
  await runtime.createRooms([
    {
      id: roomId,
      agentId: runtime.agentId,
      worldId,
      name: "Team chat",
      source: "client_chat",
      type: ChannelType.GROUP,
    },
  ]);
  await runtime.createRoomParticipants([ownerId, bobId, daveId], roomId);
  const turns = ["Dave sent the draft", "Bob reviewed the draft"];
  for (const [index, text] of turns.entries()) {
    await runtime.createMemory(
      {
        id: stringToUuid(`resolution-turn-${index}`),
        agentId: runtime.agentId,
        entityId: ownerId,
        roomId,
        createdAt: 1_000 + index,
        content: { text, source: "client_chat" },
      },
      "messages",
    );
  }
  const message: Memory = {
    id: stringToUuid("resolution-request"),
    agentId: runtime.agentId,
    entityId: ownerId,
    roomId,
    content: { text: "him", source: "client_chat" },
  };

  try {
    await findEntityByName(runtime, message, {
      values: {},
      data: {},
      text: "",
    });
  } finally {
    await runtime.stop();
  }

  const prompt = prompts[0] ?? "";
  expect(prompt.indexOf("Dave sent the draft")).toBeGreaterThanOrEqual(0);
  expect(prompt.indexOf("Dave sent the draft")).toBeLessThan(
    prompt.indexOf("Bob reviewed the draft"),
  );
});
