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
