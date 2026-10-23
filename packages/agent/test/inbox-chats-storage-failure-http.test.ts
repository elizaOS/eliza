/** Real HTTP, PGlite, and room-graph proof that an unreadable inbox message history is reported as a failure, not as an empty chat list. */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelType, type UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

/** Enough rooms that the per-room preview scan would fan one outage out loudly. */
const EMPTY_ROOM_COUNT = 24;

it("reports an unreadable message history as a failure instead of an empty chat list", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eliza-inbox-history-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  })) {
    vi.stubEnv(key, value);
  }
  for (const key of [
    "POSTGRES_URL",
    "DATABASE_URL",
    "ELIZA_CLOUD_PROVISIONED",
  ]) {
    vi.stubEnv(key, undefined);
  }

  const fixture = await createTestRuntime({
    characterName: "InboxHistoryStorage",
    pgliteDir: path.join(directory, ".elizadb"),
  });
  const runtime = fixture.runtime;
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    const ownerId = randomUUID() as UUID;
    const worldId = randomUUID() as UUID;
    const filledRoomId = randomUUID() as UUID;
    const emptyRoomIds = Array.from(
      { length: EMPTY_ROOM_COUNT },
      () => randomUUID() as UUID,
    );
    await runtime.createWorld({
      id: worldId,
      agentId: runtime.agentId,
      name: "Inbox history world",
    });
    await runtime.createEntities([
      { id: ownerId, agentId: runtime.agentId, names: ["Owner"] },
      {
        id: runtime.agentId,
        agentId: runtime.agentId,
        names: ["InboxHistoryStorage"],
      },
    ]);
    await runtime.createRooms([
      {
        id: filledRoomId,
        agentId: runtime.agentId,
        worldId,
        type: ChannelType.DM,
        source: "telegram",
      },
      ...emptyRoomIds.map((id) => ({
        id,
        agentId: runtime.agentId,
        worldId,
        type: ChannelType.DM as ChannelType,
        source: "telegram",
      })),
    ]);
    for (const roomId of [filledRoomId, ...emptyRoomIds]) {
      await runtime.addParticipant(ownerId, roomId);
      await runtime.addParticipant(runtime.agentId, roomId);
    }
    await runtime.createMemory(
      {
        id: randomUUID() as UUID,
        agentId: runtime.agentId,
        entityId: ownerId,
        roomId: filledRoomId,
        createdAt: Date.now(),
        content: { text: "hello from telegram", source: "telegram" },
      },
      "messages",
    );

    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;

    // Healthy control: the room with history renders its preview, and rooms
    // with no rows are reported as empty chats, not as failures.
    const healthy = await fetch(`${base}/api/inbox/chats?sources=telegram`);
    expect(healthy.status).toBe(200);
    const healthyBody = (await healthy.json()) as {
      chats: Array<{
        id: string;
        lastMessageText: string;
        messageCount: number;
      }>;
      count: number;
    };
    expect(healthyBody.count).toBe(EMPTY_ROOM_COUNT + 1);
    const filledChat = healthyBody.chats.find(
      (chat) => chat.id === filledRoomId,
    );
    expect(filledChat?.lastMessageText).toBe("hello from telegram");
    expect(filledChat?.messageCount).toBe(1);
    for (const roomId of emptyRoomIds) {
      const emptyChat = healthyBody.chats.find((chat) => chat.id === roomId);
      expect(emptyChat?.messageCount).toBe(0);
    }

    // Real storage fault: the message store disappears under a live server.
    const db = runtime.adapter.db as {
      execute: (statement: ReturnType<typeof sql>) => Promise<unknown>;
    };
    await db.execute(sql`ALTER TABLE memories RENAME TO memories_unavailable`);

    const failed = await fetch(`${base}/api/inbox/chats?sources=telegram`);
    expect(failed.status).toBe(500);
    const failedBody = await failed.text();
    // The client learns the read failed, and learns nothing about the driver.
    expect(failedBody).toContain("Inbox message history is unavailable.");
    expect(failedBody).not.toContain("memories");
    expect(failedBody).not.toContain("does not exist");
    expect(failedBody).not.toContain(directory);

    // The diagnostic hook received the driver detail exactly once for the
    // request, however many rooms the preview scan covered.
    const reported = runtime
      .getRecentReportedErrors()
      .filter((entry) => entry.scope === "inbox-message-history");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain("memories");
    expect(reported[0]?.context).toMatchObject({ tableName: "messages" });
  } finally {
    if (server) await server.close();
    await fixture.cleanup();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
