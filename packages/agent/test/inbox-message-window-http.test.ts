/** Real HTTP, SQLite, room graph, and persisted-message proof for inbox paging. */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelType, createCharacter, type UUID } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

it("fills the inbox limit past newer persisted rows that cannot render", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eliza-inbox-window-"));
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
    character: createCharacter({ name: "InboxWindow" }),
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
        names: ["InboxWindow"],
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

    const now = Date.now();
    for (let index = 0; index < 6; index += 1) {
      await runtime.createMemory(
        {
          id: randomUUID() as UUID,
          agentId: runtime.agentId,
          entityId: ownerId,
          roomId,
          createdAt: now - index,
          content: { text: "", source: "discord" },
        },
        "messages",
      );
    }
    for (const [index, text] of [
      "older visible one",
      "older visible two",
    ].entries()) {
      await runtime.createMemory(
        {
          id: randomUUID() as UUID,
          agentId: runtime.agentId,
          entityId: ownerId,
          roomId,
          createdAt: now - 100 - index,
          content: { text, source: "discord" },
        },
        "messages",
      );
    }

    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const expected = {
      count: 2,
      messages: [{ text: "older visible one" }, { text: "older visible two" }],
    };
    for (const scope of [`&roomId=${roomId}&roomSource=discord`, ""]) {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/inbox/messages?limit=2&sources=discord${scope}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        messages: Array<{ text: string }>;
        count: number;
      };
      expect(body).toMatchObject(expected);
    }
  } finally {
    if (server) await server.close();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
