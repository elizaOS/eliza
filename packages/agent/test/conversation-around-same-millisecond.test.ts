/** Real SQLite history: jump-to-message must keep the pivot inside a same-millisecond burst. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, createMessageMemory, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

const sharedAt = 1_700_000_000_000;
const burstSize = 205;
const pivotIndex = 102;

function burstId(index: number): UUID {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}` as UUID;
}

it("keeps the jumped-to message when its millisecond holds more neighbors than the window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-around-page-"));
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
      character: { name: "Around page", bio: [], settings: {} },
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
      body: JSON.stringify({ title: "Same millisecond jump" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = (await created.json()) as {
      conversation: { id: string; roomId: UUID };
    };

    for (let index = 0; index < burstSize; index++) {
      await runtime.createMemory(
        {
          ...createMessageMemory({
            id: burstId(index),
            entityId: agentId,
            agentId,
            roomId: conversation.roomId,
            content: { text: `burst-${index}`, source: "client_chat" },
          }),
          createdAt: sharedAt,
        },
        "messages",
      );
    }

    const pivotId = burstId(pivotIndex);
    const response = await fetch(
      `${base}/api/conversations/${conversation.id}/messages?around=${pivotId}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<{ id: string; text: string }>;
    };
    const ids = new Set(body.messages.map((message) => message.id));
    expect(ids.has(pivotId)).toBe(true);
    expect(ids.has(burstId(pivotIndex - 1))).toBe(true);
    expect(ids.has(burstId(pivotIndex + 1))).toBe(true);
    expect(ids.has(burstId(0))).toBe(false);
    expect(ids.has(burstId(burstSize - 1))).toBe(false);
    expect(body.messages.find((message) => message.id === pivotId)?.text).toBe(
      `burst-${pivotIndex}`,
    );
  } finally {
    if (server) await server.close();
    if (runtime) await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
