/** Transcript GET hides scheduler input without changing stored/model history. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  createMessageMemory,
  MESSAGE_SOURCE_CLIENT_CHAT,
  MESSAGE_SOURCE_TRIGGER_PROMPT,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { recentMessagesProvider } from "../../../plugins/plugin-assistant/src/features/basic-capabilities/providers/recentMessages.ts";
import { startApiServer } from "../src/api/server.ts";

it("projects legacy scheduled input out of transcript pages while retaining complete model history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-trigger-projection-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  }))
    vi.stubEnv(key, value);
  const runtime = new AgentRuntime({
    character: { name: "Trigger projection", bio: [], settings: {} },
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "state.sqlite"),
      runtime.agentId,
    ),
  );
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.init();
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const created = await fetch(`${base}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Scheduled input projection" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = (await created.json()) as {
      conversation: { id: string; roomId: UUID };
    };
    const ownerId = randomUUID() as UUID;
    await runtime.createEntity({
      id: ownerId,
      agentId: runtime.agentId,
      names: ["Owner"],
    });
    await runtime.ensureParticipantInRoom(ownerId, conversation.roomId);
    const text =
      "Scheduled trigger QA fired. Do this now: Keep two  spaces.\nExact Ω🙂 instructions.";
    const now = Date.now() - 10_000;
    const rows = [
      { entityId: ownerId, source: MESSAGE_SOURCE_TRIGGER_PROMPT, text },
      {
        entityId: runtime.agentId,
        source: MESSAGE_SOURCE_TRIGGER_PROMPT,
        text: "QA prompt verified",
      },
      // Identical user text is not a scheduler input: provenance, not text, owns projection.
      { entityId: ownerId, source: MESSAGE_SOURCE_CLIENT_CHAT, text },
    ].map((row, index) => ({
      ...createMessageMemory({
        id: randomUUID() as UUID,
        entityId: row.entityId,
        agentId: runtime.agentId,
        roomId: conversation.roomId,
        content: { text: row.text, source: row.source },
      }),
      createdAt: now + index,
    }));
    for (const row of rows) await runtime.createMemory(row, "messages");
    const storedBefore = await runtime.getMemories({
      roomId: conversation.roomId,
      tableName: "messages",
      unique: false,
    });
    for (const query of [
      "",
      `?before=${Date.now()}&limit=10`,
      `?around=${rows[0].id}`,
    ]) {
      const response = await fetch(
        `${base}/api/conversations/${conversation.id}/messages${query}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        messages: Array<{ id: string; role: string; text: string }>;
      };
      expect(body.messages.map((message) => message.id)).toEqual([
        rows[1].id,
        rows[2].id,
      ]);
      expect(body.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "assistant", text: "QA prompt verified" },
        { role: "user", text },
      ]);
    }
    expect(
      await runtime.getMemories({
        roomId: conversation.roomId,
        tableName: "messages",
        unique: false,
      }),
    ).toEqual(storedBefore);
    const history = await recentMessagesProvider.get(runtime, rows[2], {
      values: {},
      data: {},
      text: "",
    });
    expect(history.data?.recentMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: rows[0].id,
          content: expect.objectContaining({
            text,
            source: MESSAGE_SOURCE_TRIGGER_PROMPT,
          }),
        }),
      ]),
    );
    expect(history.text).toContain(text);
  } finally {
    if (server) await server.close();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
