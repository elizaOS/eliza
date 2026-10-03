/** GET /messages must order a same-millisecond burst like the store: UUID order. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, createMessageMemory, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

const lowerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const upperId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB" as UUID;

it("orders same-millisecond messages by UUID rather than letter case", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-message-order-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  }))
    vi.stubEnv(key, value);

  const agentId = randomUUID() as UUID;
  let runtime: AgentRuntime | undefined;
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    runtime = new AgentRuntime({
      agentId,
      character: { name: "Message order", bio: [], settings: {} },
      logLevel: "fatal",
      enableAutonomy: false,
    });
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(join(directory, "state.sqlite"), agentId),
    );
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
      body: JSON.stringify({ title: "Tied messages" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = (await created.json()) as {
      conversation: { id: string; roomId: UUID };
    };
    for (const id of [upperId, lowerId]) {
      await runtime.createMemory(
        {
          ...createMessageMemory({
            id,
            entityId: agentId,
            agentId,
            roomId: conversation.roomId,
            content: { text: `turn ${id}`, source: "client_chat" },
          }),
          createdAt: 1_700_000_000_000,
        },
        "messages",
      );
    }
    const response = await fetch(
      `${base}/api/conversations/${conversation.id}/messages`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: Array<{ id: string }> };
    expect(
      body.messages
        .map((message) => message.id)
        .filter((id) => id === lowerId || id === upperId),
    ).toEqual([lowerId, upperId]);
  } finally {
    if (server) await server.close();
    if (runtime) await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
