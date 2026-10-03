/** Keyword search must not drop a visible hit that ranks behind an internal row. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, createMessageMemory, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

it("returns a visible search hit when the top-ranked row is internal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-search-visible-"));
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
  const userId = randomUUID() as UUID;
  let runtime: AgentRuntime | undefined;
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    runtime = new AgentRuntime({
      agentId,
      character: { name: "Search page", bio: [], settings: {} },
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
      body: JSON.stringify({ title: "Budget thread" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = (await created.json()) as {
      conversation: { id: string; roomId: UUID };
    };
    const visibleId = "00000000-0000-4000-8000-000000000001" as UUID;
    await runtime.createMemory(
      {
        ...createMessageMemory({
          id: visibleId,
          entityId: userId,
          agentId,
          roomId: conversation.roomId,
          content: {
            text: "please review the household budget assumptions for next quarter",
            source: "client_chat",
          },
        }),
        createdAt: 1_700_000_000_000,
      },
      "messages",
    );
    await runtime.createMemory(
      {
        ...createMessageMemory({
          id: "00000000-0000-4000-8000-000000000002" as UUID,
          entityId: agentId,
          agentId,
          roomId: conversation.roomId,
          content: {
            text: "budget budget budget",
            source: "client_chat",
            transcriptVisibility: "internal",
          },
        }),
        createdAt: 1_700_000_000_100,
      },
      "messages",
    );

    const response = await fetch(
      `${base}/api/conversations/messages/search?q=budget&limit=1`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{ messageId: string; text: string }>;
    };
    expect(body.results.map((result) => result.messageId)).toEqual([visibleId]);
  } finally {
    if (server) await server.close();
    if (runtime) await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
