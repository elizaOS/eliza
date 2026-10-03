/** Real SQLite history: scrolling up must keep messages that share the cursor millisecond. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, createMessageMemory, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

const sharedAt = 1_700_000_000_000;
const newestId = "00000000-0000-4000-8000-000000000003" as UUID;
const middleId = "00000000-0000-4000-8000-000000000002" as UUID;
const oldestTiedId = "00000000-0000-4000-8000-000000000001" as UUID;
const earlierId = "00000000-0000-4000-8000-000000000000" as UUID;

it("keeps same-millisecond siblings when the older page names the cursor message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-older-page-"));
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
      character: { name: "Older page", bio: [], settings: {} },
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
      body: JSON.stringify({ title: "Same millisecond" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = (await created.json()) as {
      conversation: { id: string; roomId: UUID };
    };

    for (const message of [
      { id: earlierId, text: "earlier", createdAt: sharedAt - 5_000 },
      { id: oldestTiedId, text: "tied-oldest", createdAt: sharedAt },
      { id: middleId, text: "tied-middle", createdAt: sharedAt },
      { id: newestId, text: "tied-newest", createdAt: sharedAt },
    ]) {
      await runtime.createMemory(
        {
          ...createMessageMemory({
            id: message.id,
            entityId: agentId,
            agentId,
            roomId: conversation.roomId,
            content: { text: message.text, source: "client_chat" },
          }),
          createdAt: message.createdAt,
        },
        "messages",
      );
    }

    const timestampOnly = await fetch(
      `${base}/api/conversations/${conversation.id}/messages?before=${sharedAt}&limit=10`,
    );
    expect(timestampOnly.status).toBe(200);
    const timestampOnlyBody = (await timestampOnly.json()) as {
      messages: Array<{ id: string; text: string }>;
    };
    expect(timestampOnlyBody.messages.map((message) => message.text)).toEqual([
      "earlier",
    ]);

    const keyed = await fetch(
      `${base}/api/conversations/${conversation.id}/messages?before=${sharedAt}&beforeId=${newestId}&limit=2`,
    );
    expect(keyed.status).toBe(200);
    const keyedBody = (await keyed.json()) as {
      messages: Array<{ id: string; text: string }>;
      hasMore: boolean;
    };
    expect(keyedBody.messages.map((message) => message.text)).toEqual([
      "tied-oldest",
      "tied-middle",
    ]);
    expect(keyedBody.hasMore).toBe(true);

    const rest = await fetch(
      `${base}/api/conversations/${conversation.id}/messages?before=${sharedAt}&beforeId=${oldestTiedId}&limit=10`,
    );
    expect(rest.status).toBe(200);
    const restBody = (await rest.json()) as {
      messages: Array<{ text: string }>;
      hasMore: boolean;
    };
    expect(restBody.messages.map((message) => message.text)).toEqual([
      "earlier",
    ]);
    expect(restBody.hasMore).toBe(false);

    const rejected = await fetch(
      `${base}/api/conversations/${conversation.id}/messages?beforeId=not-a-uuid`,
    );
    expect(rejected.status).toBe(400);
  } finally {
    if (server) await server.close();
    if (runtime) await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
