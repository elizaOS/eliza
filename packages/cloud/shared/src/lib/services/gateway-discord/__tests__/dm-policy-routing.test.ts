/**
 * Verifies the Discord event router enforces DM policy before character or
 * runtime work. The deterministic harness uses real payload validation and
 * policy logic while replacing only repository and runtime boundaries.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const CHARACTER_ID = "33333333-3333-4333-8333-333333333333";
const OWNER = "123456789012345678";
const STRANGER = "345678901234567890";

let metadata: Record<string, unknown> = {};
const findConnection = mock(async () => ({
  id: CONNECTION_ID,
  organization_id: ORGANIZATION_ID,
  character_id: CHARACTER_ID,
  bot_user_id: "456789012345678901",
  metadata,
}));
const findCharacter = mock(async () => null);
const createRuntimeForUser = mock(async () => {
  throw new Error("test: runtime creation must not be reached");
});

const realRepositories = await import("../../../../db/repositories");
mock.module("../../../../db/repositories", () => ({
  ...realRepositories,
  discordConnectionsRepository: { findById: findConnection },
  userCharactersRepository: { findById: findCharacter },
}));
mock.module("../../eliza/runtime-factory", () => ({
  runtimeFactory: { createRuntimeForUser },
}));
mock.module("../../eliza/user-context", () => ({
  userContextService: { createSystemContext: () => ({}) },
}));

const { routeDiscordEvent } = await import("../event-router");

function directMessage(authorId: string) {
  return {
    connection_id: CONNECTION_ID,
    organization_id: ORGANIZATION_ID,
    platform_connection_id: "discord-platform-1",
    event_type: "MESSAGE_CREATE" as const,
    event_id: `event-${authorId}`,
    guild_id: "",
    channel_id: "dm-channel-1",
    timestamp: "2026-08-15T08:00:00.000Z",
    data: {
      id: `message-${authorId}`,
      channel_id: "dm-channel-1",
      author: { id: authorId, username: "sender", bot: false },
      content: "hello",
      timestamp: "2026-08-15T08:00:00.000Z",
    },
  };
}

beforeEach(() => {
  metadata = {};
  findConnection.mockClear();
  findCharacter.mockClear();
  createRuntimeForUser.mockClear();
});

describe("Discord event-router DM policy", () => {
  test("blocked senders stop before character lookup or runtime creation", async () => {
    metadata = { dmPolicy: "allowlist", ownerDiscordUserId: OWNER };

    await expect(routeDiscordEvent(directMessage(STRANGER))).resolves.toEqual({
      processed: true,
    });
    expect(findConnection).toHaveBeenCalledTimes(1);
    expect(findCharacter).not.toHaveBeenCalled();
    expect(createRuntimeForUser).not.toHaveBeenCalled();
  });

  test("admitted owners continue into character lookup", async () => {
    metadata = { dmPolicy: "allowlist", ownerDiscordUserId: OWNER };

    await expect(routeDiscordEvent(directMessage(OWNER))).resolves.toEqual({
      processed: false,
    });
    expect(findCharacter).toHaveBeenCalledWith(CHARACTER_ID);
    expect(createRuntimeForUser).not.toHaveBeenCalled();
  });
});
