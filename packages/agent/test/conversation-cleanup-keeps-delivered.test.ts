/**
 * Starting a new chat sweeps empty drafts with
 * `POST /api/conversations/cleanup-empty { keepId }`. A conversation that holds
 * an agent message delivered while the owner was away (a reminder or routine
 * written by the owner_chat send handler) is not a draft: the sweep must keep
 * it, and still reap a draft holding nothing or only a stored agent greeting.
 * Real PGlite runtime, the real agent HTTP server and its send handlers.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMessageMemory,
  MESSAGE_SOURCE_AGENT_GREETING,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { startApiServer } from "../src/api/server.ts";

it("keeps a conversation holding a delivered reminder when a new chat sweeps empty drafts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-cleanup-delivered-"));
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  });
  const fixture = await createTestRuntime({
    characterName: "Cleanup Delivered",
    settings: { BASIC_CAPABILITIES_DEFLLMOFF: true },
    plugins: [createAssistantPlugin()],
    pgliteDir: join(directory, "pglite"),
  });
  const { runtime } = fixture;
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };
    type Listed = { id: string; roomId: string; title: string };
    const list = async () =>
      (
        (await call("GET", "/api/conversations")).body.conversations as Listed[]
      ).map((conversation) => conversation.id);

    // While away, a reminder is delivered to the owner. With no conversation
    // left, the owner_chat handler creates one and stores the reminder there.
    const reminder = await runtime.sendMessageToTarget(
      { source: "owner_chat" } as never,
      { text: "Reminder: take your 9pm medication." },
    );
    const [reminderConversationId] = await list();
    expect(reminderConversationId).toBeDefined();

    // Drafts from the next visit: one untouched, one holding a stored
    // greeting row (older servers persisted greetings) — both still swept.
    const blank = (await call("POST", "/api/conversations", { title: "D1" }))
      .body.conversation as Listed;
    const greeted = (await call("POST", "/api/conversations", { title: "D2" }))
      .body.conversation as Listed;
    await runtime.createMemory(
      createMessageMemory({
        entityId: runtime.agentId,
        roomId: greeted.roomId as UUID,
        content: { text: "Hi there!", source: MESSAGE_SOURCE_AGENT_GREETING },
      }),
      "messages",
    );

    // The owner taps "New chat": the UI creates one and sweeps the rest.
    const fresh = (await call("POST", "/api/conversations", { title: "New" }))
      .body.conversation as Listed;
    const sweep = await call("POST", "/api/conversations/cleanup-empty", {
      keepId: fresh.id,
    });
    expect(sweep.status).toBe(200);
    expect(sweep.body.deleted).not.toContain(reminderConversationId);
    expect([...(sweep.body.deleted as string[])].sort()).toEqual(
      [blank.id, greeted.id].sort(),
    );
    expect(await list()).toContain(reminderConversationId);
    const history = await call(
      "GET",
      `/api/conversations/${reminderConversationId}/messages`,
    );
    expect(
      (history.body.messages as Array<{ text: string }>).map((m) => m.text),
    ).toEqual(["Reminder: take your 9pm medication."]);
    expect(
      await runtime.getMemoryById((reminder as { id: string }).id as never),
    ).not.toBeNull();
  } finally {
    await server?.close();
    await fixture.cleanup();
    process.env = previousEnv;
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
