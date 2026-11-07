/**
 * A transient Discord user-lookup failure must not be memoized as "this user
 * has no profile": the inbox retries the lookup on the next read instead of
 * rendering every later message from that sender without a name.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChannelType,
  createCharacter,
  type IAgentRuntime,
  Service,
  type UUID,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

const RAW_DISCORD_USER_ID = "4242424242424242";

class FlakyDiscordService extends Service {
  static override serviceType = "discord";
  override capabilityDescription = "Discord connector";
  private lookups = 0;

  client = {
    users: {
      fetch: async () => {
        this.lookups += 1;
        // First read: Discord is momentarily unavailable (rate limit / 5xx).
        if (this.lookups === 1) {
          throw Object.assign(new Error("Discord responded 500"), {
            status: 500,
          });
        }
        return {
          id: RAW_DISCORD_USER_ID,
          username: "ada",
          globalName: "Ada Lovelace",
        };
      },
    },
  };

  static override async start(runtime: IAgentRuntime) {
    return new FlakyDiscordService(runtime);
  }

  override async stop() {}
}

it("retries a failed Discord profile lookup instead of caching the absence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eliza-inbox-profile-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  })) {
    vi.stubEnv(key, value);
  }

  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "InboxProfile" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.initialize({ skipMigrations: true });
    const ownerId = randomUUID() as UUID;
    const worldId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    await runtime.createWorld({
      id: worldId,
      agentId: runtime.agentId,
      name: "Inbox world",
    });
    await runtime.createEntities([
      { id: ownerId, agentId: runtime.agentId, names: ["Owner"] },
      {
        id: runtime.agentId,
        agentId: runtime.agentId,
        names: ["InboxProfile"],
      },
    ]);
    await runtime.createRooms([
      {
        id: roomId,
        agentId: runtime.agentId,
        worldId,
        type: ChannelType.DM,
        source: "discord",
      },
    ]);
    await runtime.addParticipant(ownerId, roomId);
    await runtime.addParticipant(runtime.agentId, roomId);
    await runtime.createMemory(
      {
        id: randomUUID() as UUID,
        agentId: runtime.agentId,
        entityId: ownerId,
        roomId,
        createdAt: Date.now(),
        content: { text: "hello from ada", source: "discord" },
        metadata: { fromId: RAW_DISCORD_USER_ID },
      },
      "messages",
    );

    await runtime.registerService(FlakyDiscordService);
    await runtime.getServiceLoadPromise("discord");

    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const readInbox = async () => {
      const response = await fetch(
        `http://127.0.0.1:${server?.port}/api/inbox/messages?limit=5&sources=discord`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        messages: Array<{ from?: string; fromUserName?: string }>;
      };
      return body.messages[0];
    };

    // The lookup fails here; the endpoint still answers (degraded), but must
    // not remember the failure as "this sender has no profile".
    const failedRead = await readInbox();
    expect(failedRead.from).not.toBe("Ada Lovelace");

    const retriedRead = await readInbox();
    expect(retriedRead.from).toBe("Ada Lovelace");
    expect(retriedRead.fromUserName).toBe("ada");
  } finally {
    if (server) await server.close();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

/**
 * The other half of the same contract: a real channel object that genuinely
 * has no message history is durable evidence of absence, so it must still be
 * memoized. Without this, the guard in `resolveDiscordMessageAuthorProfile`
 * would turn every read of an unusable channel into another Discord call.
 */
const NO_HISTORY_CHANNEL_ID = "910000000000000001";
const NO_HISTORY_MESSAGE_ID = "910000000000000002";

let noHistoryService: NoHistoryChannelDiscordService | undefined;

class NoHistoryChannelDiscordService extends Service {
  static override serviceType = "discord";
  override capabilityDescription = "Discord connector";
  channelLookups = 0;

  client = {
    channels: {
      // Resolves fine, but the channel exposes no `messages` collection.
      fetch: async () => {
        this.channelLookups += 1;
        return { id: NO_HISTORY_CHANNEL_ID, type: 0 };
      },
    },
    users: {
      fetch: async () => ({ id: "910000000000000003", username: "ghost" }),
    },
  };

  static override async start(runtime: IAgentRuntime) {
    noHistoryService = new NoHistoryChannelDiscordService(runtime);
    return noHistoryService;
  }

  override async stop() {}
}

it("still memoizes an absent author when a real channel has no message history", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "eliza-inbox-nohistory-"),
  );
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  })) {
    vi.stubEnv(key, value);
  }

  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "InboxNoHistory" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.initialize({ skipMigrations: true });
    const ownerId = randomUUID() as UUID;
    const worldId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    await runtime.createWorld({
      id: worldId,
      agentId: runtime.agentId,
      name: "Inbox no-history world",
    });
    await runtime.createEntities([
      { id: ownerId, agentId: runtime.agentId, names: ["Owner"] },
      {
        id: runtime.agentId,
        agentId: runtime.agentId,
        names: ["InboxNoHistory"],
      },
    ]);
    await runtime.createRooms([
      {
        id: roomId,
        agentId: runtime.agentId,
        worldId,
        type: ChannelType.DM,
        source: "discord",
      },
    ]);
    await runtime.addParticipant(ownerId, roomId);
    await runtime.addParticipant(runtime.agentId, roomId);
    await runtime.createMemory(
      {
        id: randomUUID() as UUID,
        agentId: runtime.agentId,
        entityId: ownerId,
        roomId,
        createdAt: Date.now(),
        content: { text: "hello from nowhere", source: "discord" },
        metadata: {
          discordChannelId: NO_HISTORY_CHANNEL_ID,
          discordMessageId: NO_HISTORY_MESSAGE_ID,
        },
      },
      "messages",
    );

    await runtime.registerService(NoHistoryChannelDiscordService);
    await runtime.getServiceLoadPromise("discord");

    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const readInbox = async () => {
      const response = await fetch(
        `http://127.0.0.1:${server?.port}/api/inbox/messages?limit=5&sources=discord`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        messages: Array<{ from?: string; fromUserName?: string }>;
      };
      return body.messages[0];
    };

    expect((await readInbox()).from).toBeUndefined();
    expect((await readInbox()).from).toBeUndefined();
    // The durable absence was cached: the channel was resolved only once.
    expect(noHistoryService?.channelLookups).toBe(1);
  } finally {
    if (server) await server.close();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

/**
 * The message-author path resolves the channel before it can fetch the
 * message. A transient `channels.fetch` failure must not be memoized as "this
 * author has no profile" either: otherwise the sender stays nameless for the
 * whole cache TTL even after Discord recovers.
 */
const CHANNEL_ID = "900000000000000001";
const MESSAGE_ID = "900000000000000002";
const MESSAGE_AUTHOR_ID = "900000000000000003";

class FlakyChannelDiscordService extends Service {
  static override serviceType = "discord";
  override capabilityDescription = "Discord connector";
  private channelLookups = 0;

  client = {
    channels: {
      fetch: async () => {
        this.channelLookups += 1;
        // First read: Discord is momentarily unavailable (rate limit / 5xx).
        if (this.channelLookups === 1) {
          throw Object.assign(new Error("Discord responded 500"), {
            status: 500,
          });
        }
        return {
          id: CHANNEL_ID,
          messages: {
            fetch: async () => ({
              author: {
                id: MESSAGE_AUTHOR_ID,
                username: "ada",
                globalName: "Ada Lovelace",
              },
            }),
          },
        };
      },
    },
    users: {
      fetch: async () => ({
        id: MESSAGE_AUTHOR_ID,
        username: "ada",
        globalName: "Ada Lovelace",
      }),
    },
  };

  static override async start(runtime: IAgentRuntime) {
    return new FlakyChannelDiscordService(runtime);
  }

  override async stop() {}
}

it("retries a failed Discord channel fetch instead of caching the absence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eliza-inbox-channel-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  })) {
    vi.stubEnv(key, value);
  }

  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "InboxChannelProfile" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.initialize({ skipMigrations: true });
    const ownerId = randomUUID() as UUID;
    const worldId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    await runtime.createWorld({
      id: worldId,
      agentId: runtime.agentId,
      name: "Inbox channel world",
    });
    await runtime.createEntities([
      { id: ownerId, agentId: runtime.agentId, names: ["Owner"] },
      {
        id: runtime.agentId,
        agentId: runtime.agentId,
        names: ["InboxChannelProfile"],
      },
    ]);
    await runtime.createRooms([
      {
        id: roomId,
        agentId: runtime.agentId,
        worldId,
        type: ChannelType.DM,
        source: "discord",
      },
    ]);
    await runtime.addParticipant(ownerId, roomId);
    await runtime.addParticipant(runtime.agentId, roomId);
    await runtime.createMemory(
      {
        id: randomUUID() as UUID,
        agentId: runtime.agentId,
        entityId: ownerId,
        roomId,
        createdAt: Date.now(),
        content: { text: "hello from ada", source: "discord" },
        // No `fromId`: forces the message-author path, which resolves the
        // channel before fetching the message.
        metadata: {
          discordChannelId: CHANNEL_ID,
          discordMessageId: MESSAGE_ID,
        },
      },
      "messages",
    );

    await runtime.registerService(FlakyChannelDiscordService);
    await runtime.getServiceLoadPromise("discord");

    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const readInbox = async () => {
      const response = await fetch(
        `http://127.0.0.1:${server?.port}/api/inbox/messages?limit=5&sources=discord`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        messages: Array<{ from?: string; fromUserName?: string }>;
      };
      return body.messages[0];
    };

    const failedRead = await readInbox();
    expect(failedRead.from).not.toBe("Ada Lovelace");

    const retriedRead = await readInbox();
    expect(retriedRead.from).toBe("Ada Lovelace");
    expect(retriedRead.fromUserName).toBe("ada");
  } finally {
    if (server) await server.close();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

/**
 * The chat list resolves the live Discord channel for every row to show the
 * real channel name (and a thread's parent, which carries the mute scope).
 * A transient `channels.fetch` failure says nothing about that room, so it
 * must not be memoized as "this room has no title": the row would keep the
 * generic fallback for the whole cache TTL even after Discord recovers.
 */
const CHAT_CHANNEL_ID = "920000000000000001";

class FlakyRoomDiscordService extends Service {
  static override serviceType = "discord";
  override capabilityDescription = "Discord connector";
  channelLookups = 0;

  client = {
    channels: {
      fetch: async () => {
        this.channelLookups += 1;
        // First read: Discord is momentarily unavailable (rate limit / 5xx).
        if (this.channelLookups === 1) {
          throw Object.assign(new Error("Discord responded 500"), {
            status: 500,
          });
        }
        return { id: CHAT_CHANNEL_ID, name: "general" };
      },
    },
    users: {
      fetch: async () => ({ id: "920000000000000009", username: "ada" }),
    },
  };

  static override async start(runtime: IAgentRuntime) {
    return new FlakyRoomDiscordService(runtime);
  }

  override async stop() {}
}

it("retries a failed Discord channel fetch instead of caching an untitled room", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eliza-inbox-room-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  })) {
    vi.stubEnv(key, value);
  }

  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "InboxRoomProfile" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.initialize({ skipMigrations: true });
    const ownerId = randomUUID() as UUID;
    const worldId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    await runtime.createWorld({
      id: worldId,
      agentId: runtime.agentId,
      name: "Inbox room world",
    });
    await runtime.createEntities([
      { id: ownerId, agentId: runtime.agentId, names: ["Owner"] },
      {
        id: runtime.agentId,
        agentId: runtime.agentId,
        names: ["InboxRoomProfile"],
      },
    ]);
    await runtime.createRooms([
      {
        id: roomId,
        agentId: runtime.agentId,
        worldId,
        type: ChannelType.DM,
        source: "discord",
      },
    ]);
    await runtime.addParticipant(ownerId, roomId);
    await runtime.addParticipant(runtime.agentId, roomId);
    await runtime.createMemory(
      {
        id: randomUUID() as UUID,
        agentId: runtime.agentId,
        entityId: ownerId,
        roomId,
        createdAt: Date.now(),
        content: { text: "hello from general", source: "discord" },
        metadata: { discordChannelId: CHAT_CHANNEL_ID },
      },
      "messages",
    );

    await runtime.registerService(FlakyRoomDiscordService);
    await runtime.getServiceLoadPromise("discord");

    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const readChats = async () => {
      const response = await fetch(
        `http://127.0.0.1:${server?.port}/api/inbox/chats?sources=discord`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        chats: Array<{ title?: string }>;
      };
      return body.chats[0];
    };

    // The first read hits a failing channel lookup; the row degrades. The
    // second read must retry Discord instead of serving the memoized absence.
    await readChats();

    expect((await readChats()).title).toBe("general");
  } finally {
    if (server) await server.close();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
