import type { IAgentRuntime } from "@elizaos/core";
import { AgentRuntime, createCharacter, ModelType } from "@elizaos/core";
import {
  createDatabaseAdapter,
  DatabaseMigrationService,
  plugin as sqlPluginInstance,
} from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openaiPlugin } from "../index";
import { getAuthHeader, getBaseURL } from "../utils/config";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function createLiveRuntime(): Promise<{
  runtime: IAgentRuntime;
  cleanup: () => Promise<void>;
}> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for OpenAI live tests");
  }

  const agentId = uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
  const adapter = createDatabaseAdapter({ dataDir: "memory://" }, agentId);
  await adapter.init();

  const migrationService = new DatabaseMigrationService();
  const db = (adapter as { getDatabase(): () => unknown }).getDatabase();
  await migrationService.initializeWithDatabase(db);
  migrationService.discoverAndRegisterPluginSchemas([sqlPluginInstance]);
  await migrationService.runAllPluginMigrations();

  const character = createCharacter({
    name: "OpenAI Live Test",
    bio: ["Exercises the real OpenAI plugin against live infrastructure."],
    system: "Reply concisely.",
    plugins: [],
    settings: {},
    secrets: {
      OPENAI_API_KEY,
      OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL,
      OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL,
      OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL,
    },
    messageExamples: [],
    postExamples: [],
    topics: ["testing"],
    adjectives: ["concise"],
    style: { all: [], chat: [], post: [] },
  });

  await adapter.createAgent({
    id: agentId,
    ...character,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const runtime = new AgentRuntime({
    agentId,
    character,
    adapter,
    plugins: [openaiPlugin],
  });

  await runtime.initialize();
  if (openaiPlugin.init) {
    await openaiPlugin.init({}, runtime);
  }

  return {
    runtime,
    cleanup: async () => {
      await runtime.stop();
      await adapter.close();
    },
  };
}

describe.skipIf(!OPENAI_API_KEY)("OpenAI plugin live", () => {
  let runtime: IAgentRuntime;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await createLiveRuntime();
    runtime = started.runtime;
    cleanup = started.cleanup;
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("connects to the live models endpoint", async () => {
    const response = await fetch(`${getBaseURL(runtime)}/models`, {
      headers: getAuthHeader(runtime),
    });

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as { data?: unknown[] };
    expect(Array.isArray(payload.data)).toBe(true);
    expect(payload.data?.length ?? 0).toBeGreaterThan(0);
  }, 30_000);

  it("generates text with TEXT_SMALL", async () => {
    const handler = openaiPlugin.models?.[ModelType.TEXT_SMALL];
    expect(typeof handler).toBe("function");
    if (!handler) {
      throw new Error("TEXT_SMALL handler is unavailable");
    }

    const response = await handler(runtime, {
      prompt: "Reply with exactly two words: live ready",
    });

    expect(typeof response).toBe("string");
    expect(response.length).toBeGreaterThan(0);
  }, 30_000);

  it("generates embeddings with TEXT_EMBEDDING", async () => {
    const handler = openaiPlugin.models?.[ModelType.TEXT_EMBEDDING];
    expect(typeof handler).toBe("function");
    if (!handler) {
      throw new Error("TEXT_EMBEDDING handler is unavailable");
    }

    const response = await handler(runtime, {
      text: "Milady live embedding smoke test",
    });

    expect(Array.isArray(response)).toBe(true);
    expect(response.length).toBeGreaterThan(0);
    expect(typeof response[0]).toBe("number");
  }, 30_000);
});
