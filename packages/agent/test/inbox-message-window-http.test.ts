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

it("answers inbox and character history reads with 503 before the runtime exists", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "eliza-inbox-no-runtime-"),
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
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
    const routes = [
      "/api/inbox/messages",
      "/api/inbox/chats",
      "/api/inbox/sources",
      "/api/character/history",
    ];
    const statuses: Record<string, number> = {};
    for (const route of routes) {
      const response = await fetch(`http://127.0.0.1:${server.port}${route}`);
      statuses[route] = response.status;
    }
    expect(statuses).toEqual(
      Object.fromEntries(routes.map((route) => [route, 503])),
    );
  } finally {
    if (server) await server.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

it("keeps an inbox reply that the connector leaves for the caller to save", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eliza-inbox-reply-"));
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
    character: createCharacter({ name: "InboxReply" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.initialize({ skipMigrations: true });
    const contactId = randomUUID() as UUID;
    const worldId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    await runtime.createWorld({
      id: worldId,
      agentId: runtime.agentId,
      name: "Inbox world",
    });
    await runtime.createEntities([
      { id: contactId, agentId: runtime.agentId, names: ["Sam"] },
      { id: runtime.agentId, agentId: runtime.agentId, names: ["InboxReply"] },
    ]);
    await runtime.createRooms([
      {
        id: roomId,
        agentId: runtime.agentId,
        worldId,
        type: ChannelType.DM,
        source: "imessage",
        channelId: "+15550100",
      },
    ]);
    await runtime.addParticipant(contactId, roomId);
    await runtime.addParticipant(runtime.agentId, roomId);
    await runtime.createMemory(
      {
        id: randomUUID() as UUID,
        agentId: runtime.agentId,
        entityId: contactId,
        roomId,
        createdAt: Date.now() - 60_000,
        content: { text: "Where are you?", source: "imessage" },
      },
      "messages",
    );
    // The iMessage send handler's result: provider receipt only, no memory.
    runtime.registerSendHandler("imessage", async () => ({
      kind: "delivered",
      receipt: {
        providerMessageIds: ["blooio-msg-1"],
        acceptedAt: Date.now(),
        evidenceKind: "provider",
        persistence: {
          status: "not_attempted",
          reason:
            "Provider accepted the message; caller owns local persistence",
        },
      },
      memories: [],
    }));

    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}/api/inbox/messages`;
    const sent = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, source: "imessage", text: "On my way" }),
    });
    const sentBody = (await sent.json()) as {
      ok: boolean;
      message?: { text: string; role: string };
    };
    expect(sent.status, JSON.stringify(sentBody)).toBe(200);
    expect(sentBody.message).toMatchObject({
      text: "On my way",
      role: "assistant",
    });

    const thread = await fetch(
      `${base}?limit=10&sources=imessage&roomId=${roomId}&roomSource=imessage`,
    );
    const threadBody = (await thread.json()) as {
      messages: Array<{ text: string }>;
    };
    expect(threadBody.messages.map((message) => message.text)).toEqual([
      "On my way",
      "Where are you?",
    ]);
  } finally {
    if (server) await server.close();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
