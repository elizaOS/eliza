/** Real HTTP and SQLite proof: a failed sender-profile read is not an empty profile. */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelType, createCharacter, type UUID } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

it("fails the inbox read when the stored sender profile cannot be read", async () => {
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
  let restoreEntityLookup: (() => void) | undefined;
  try {
    await runtime.initialize({ skipMigrations: true });
    const senderId = randomUUID() as UUID;
    const worldId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    await runtime.createWorld({
      id: worldId,
      agentId: runtime.agentId,
      name: "Inbox profile world",
    });
    await runtime.createEntities([
      { id: senderId, agentId: runtime.agentId, names: ["Sam"] },
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
        channelId: "profile-channel",
      },
    ]);
    await runtime.addParticipant(senderId, roomId);
    await runtime.addParticipant(runtime.agentId, roomId);
    await runtime.createMemory(
      {
        id: randomUUID() as UUID,
        agentId: runtime.agentId,
        entityId: senderId,
        roomId,
        createdAt: Date.now() - 60_000,
        content: { text: "hello from discord", source: "discord" },
      },
      "messages",
    );

    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const inbox = `http://127.0.0.1:${server.port}/api/inbox/messages?limit=10&sources=discord`;

    // Legitimate miss: the sender entity carries no profile metadata at all.
    // The inbox still renders the message, just without a stored name.
    const unlabelled = await fetch(inbox);
    const unlabelledBody = (await unlabelled.json()) as {
      messages: Array<{ text: string; from?: string }>;
    };
    expect(unlabelled.status, JSON.stringify(unlabelledBody)).toBe(200);
    expect(unlabelledBody.messages.map((message) => message.text)).toEqual([
      "hello from discord",
    ]);
    expect(unlabelledBody.messages[0]?.from ?? "").toBe("");

    // Real failure: the entity store read blows up. That is not "no profile".
    const readEntity = runtime.getEntityById.bind(runtime);
    const spy = vi
      .spyOn(runtime, "getEntityById")
      .mockImplementation(async (id: UUID) => {
        if (id === senderId) {
          throw new Error("entity store read failed");
        }
        return readEntity(id);
      });
    restoreEntityLookup = () => spy.mockRestore();

    const response = await fetch(inbox);
    const body = (await response.json()) as { error?: string };
    expect(response.status, JSON.stringify(body)).toBe(500);
    expect(body.error ?? "").toContain("entity store read failed");
  } finally {
    restoreEntityLookup?.();
    if (server) await server.close();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
