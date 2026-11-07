/** Actual owner chat HTTP/SQLite transport into the content-free native timing projection. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  type IMessageService,
  ModelType,
  type State,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createV5ReplyStrategyResult } from "../../../plugins/plugin-assistant/src/services/message/reply-policy.ts";
import { startApiServer } from "../src/api/server.ts";

it("projects the completed owner turn through status without reading logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-owner-timing-"));
  const token = randomUUID();
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
    ELIZA_HOST_CONTEXT_REVISION: "boot:timing-transport-test",
  }))
    vi.stubEnv(key, value);
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: { name: "Timing fixture", bio: [] },
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
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => "Paris is the capital.",
      "private-model-label",
      100,
    );
    runtime.messageService = {
      handleMessage: async (_runtime, message) => {
        const text = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "PRIVATE_PROMPT",
        });
        return {
          ...createV5ReplyStrategyResult({
            runtime,
            message,
            state: {} as State,
            responseId: randomUUID() as UUID,
            text,
            thought: "",
          }),
          didRespond: true,
          outcome: { status: "completed", effects: [] },
        };
      },
      shouldRespond: () => {
        throw Error("Unexpected response decision");
      },
      deleteMessage: async () => {
        throw Error("Unexpected message deletion");
      },
      clearChannel: async () => {
        throw Error("Unexpected channel clearing");
      },
    } satisfies IMessageService;
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const created = await fetch(`${base}/api/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Timing" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = await created.json();
    const reply = await fetch(
      `${base}/api/conversations/${conversation.id}/messages/stream`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: "What is the capital of France?",
          clientMessageId: randomUUID(),
        }),
      },
    );
    expect(reply.status).toBe(200);
    expect(await reply.text()).toContain("Paris is the capital.");
    const logs = vi.spyOn(runtime, "getLogs");
    try {
      const status = await fetch(`${base}/api/status`, { headers });
      expect(status.status).toBe(200);
      const { nativeInferenceTiming: timing } = await status.json();
      expect(timing).toMatchObject({
        version: 1,
        totalMs: expect.any(Number),
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      });
      expect(timing.stages.length).toBeGreaterThan(0);
      expect(JSON.stringify(timing)).not.toMatch(
        /PRIVATE|Paris|private-model-label|roomId|turnId|label|meta/,
      );
      expect(logs).not.toHaveBeenCalled();
    } finally {
      logs.mockRestore();
    }
  } finally {
    await server?.close();
    await runtime.stop();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
