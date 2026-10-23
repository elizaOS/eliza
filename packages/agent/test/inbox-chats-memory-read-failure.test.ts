/** Proves inbox chat enumeration reports a messages read failure instead of an empty chat. */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelType, createCharacter, type UUID } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

it("reports a messages read failure instead of an empty chat row", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "eliza-inbox-chats-read-"),
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
    character: createCharacter({ name: "InboxChatsRead" }),
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

    // The chat sidebar backfills a room without an accumulator entry by
    // reading that room's latest memory. A storage fault there used to be
    // reported to the client as "this room has zero messages".
    const readFailure = new Error("messages table unavailable");
    const readMemories = runtime.getMemories.bind(runtime);
    vi.spyOn(runtime, "getMemories").mockImplementation((async (
      params: Parameters<typeof runtime.getMemories>[0],
    ) => {
      if (
        params?.tableName === "messages" &&
        params.roomId === roomId &&
        params.limit === 10
      ) {
        throw readFailure;
      }
      return readMemories(params);
    }) as typeof runtime.getMemories);

    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/inbox/chats?sources=discord`,
    );
    const body = (await response.json()) as {
      chats?: Array<{ id: string; messageCount: number }>;
      error?: string;
    };
    console.log(
      `[response] status=${response.status} body=${JSON.stringify(body)}`,
    );
    expect(response.status).toBe(500);
    expect(body.error).toContain("messages table unavailable");
  } finally {
    vi.restoreAllMocks();
    if (server) await server.close();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
