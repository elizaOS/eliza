/** `?before=0` is the Unix epoch, not a missing cursor. */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, createMessageMemory, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

const epochNeighbor = "00000000-0000-4000-8000-0000000003e8" as UUID;

it("does not reload the recent window when the older-page cursor is the epoch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-before-epoch-"));
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
      character: { name: "Before epoch", bio: [], settings: {} },
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
      body: JSON.stringify({ title: "Epoch cursor" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = (await created.json()) as {
      conversation: { id: string; roomId: UUID };
    };

    await runtime.createMemory(
      {
        ...createMessageMemory({
          id: epochNeighbor,
          entityId: agentId,
          agentId,
          roomId: conversation.roomId,
          content: { text: "just after the epoch", source: "client_chat" },
        }),
        createdAt: 1000,
      },
      "messages",
    );

    const response = await fetch(
      `${base}/api/conversations/${conversation.id}/messages?before=0`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<{ id: string; timestamp: number }>;
    };
    expect(body.messages.map((message) => message.id)).not.toContain(
      epochNeighbor,
    );
    expect(body.messages.every((message) => message.timestamp < 0)).toBe(true);
  } finally {
    if (server) await server.close();
    if (runtime) await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
