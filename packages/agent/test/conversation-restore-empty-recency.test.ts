/**
 * After a restart the conversation list is rebuilt from the database. An
 * empty conversation (a "New chat" the owner never typed into) has no message
 * to date it, and must not be restored as updated "now": that floats the
 * abandoned draft above the conversation the owner was actually using, and an
 * owner-addressed delivery (a reminder sent while no client is connected)
 * lands in the draft. Real PGlite runtime and the real agent HTTP server,
 * restarted on the same database.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { startApiServer } from "../src/api/server.ts";

type Listed = { id: string; createdAt: string; updatedAt: string };

it("restores an empty conversation at its creation time, below newer activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-restore-recency-"));
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  });
  const boot = async () => {
    const fixture = await createTestRuntime({
      characterName: "Restore Recency",
      settings: { BASIC_CAPABILITIES_DEFLLMOFF: true },
      plugins: [createAssistantPlugin()],
      pgliteDir: join(directory, "pglite"),
    });
    const server = await startApiServer({
      port: 0,
      runtime: fixture.runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return (await response.json()) as Record<string, unknown>;
    };
    const list = async () =>
      (await call("GET", "/api/conversations")).conversations as Listed[];
    return { fixture, server, call, list };
  };

  let live: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    live = await boot();
    // The owner taps "New chat" and leaves it empty, then goes back to an
    // existing conversation and keeps talking there.
    const draft = (
      await live.call("POST", "/api/conversations", { title: "New Chat" })
    ).conversation as Listed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const used = (
      await live.call("POST", "/api/conversations", { title: "Groceries" })
    ).conversation as Listed;
    await live.call("POST", `/api/conversations/${used.id}/messages`, {
      text: "add oat milk to the list",
      channelType: "DM",
      clientMessageId: "groceries-1",
    });
    expect((await live.list()).map((c) => c.id)).toEqual([used.id, draft.id]);

    await live.server.close();
    await live.fixture.cleanup();
    live = undefined;
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Restart on the same database.
    live = await boot();
    const restored = await live.list();
    expect(restored.map((c) => c.id)).toEqual([used.id, draft.id]);
    const restoredDraft = restored.find((c) => c.id === draft.id);
    expect(restoredDraft?.createdAt).toBe(draft.createdAt);
    expect(restoredDraft?.updatedAt).toBe(draft.createdAt);
    expect(restored.find((c) => c.id === used.id)?.createdAt).toBe(
      used.createdAt,
    );

    // A reminder delivered while no client is connected goes to the
    // conversation the owner was using, not the abandoned draft.
    await live.fixture.runtime.sendMessageToTarget(
      { source: "owner_chat" } as never,
      { text: "Reminder: buy oat milk." },
    );
    const restarted = live;
    const texts = async (id: string) =>
      (
        (await restarted.call("GET", `/api/conversations/${id}/messages`))
          .messages as Array<{ text: string }>
      ).map((m) => m.text);
    expect(await texts(draft.id)).toEqual([]);
    expect(await texts(used.id)).toContain("Reminder: buy oat milk.");
  } finally {
    await live?.server.close();
    await live?.fixture.cleanup();
    process.env = previousEnv;
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
