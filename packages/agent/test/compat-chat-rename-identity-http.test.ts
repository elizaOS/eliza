import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  OPTIMIZED_PROMPT_SERVICE,
  stringToUuid,
} from "@elizaos/core";
import { installHttpPluginLifecycle } from "@elizaos/host/protocol";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import {
  createDeterministicModelPlugin,
  strictTerminalReplyFixture,
} from "@elizaos/testing/models";
import { req } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import { buildCharacterFromConfig } from "../src/runtime/build-character-config.ts";

it("keeps the compat chat routes on the identity world after a rename and restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "compat-chat-rename-"));
  const configPath = path.join(dir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  // The config that PUT /api/character writes when Eliza is renamed to Nova.
  saveElizaConfig({
    ui: { assistant: { name: "Nova" } },
    agents: {
      list: [
        { id: "main", default: true, name: "Nova", identityName: "Eliza" },
      ],
    },
  });
  const runtime = new AgentRuntime({
    character: buildCharacterFromConfig(loadElizaConfig()),
    plugins: [],
    logLevel: "fatal",
  });
  runtime.setSetting("PGLITE_DATA_DIR", path.join(dir, "pg"));
  runtime.setSetting("POSTGRES_URL", "");
  runtime.setSetting("EMBEDDING_DIMENSION", "384");
  installHttpPluginLifecycle(runtime);
  await runtime.registerPlugin(sqlPlugin);
  await runtime.registerPlugin(createAssistantPlugin());
  await runtime.registerPlugin(
    createDeterministicModelPlugin({
      fixtures: [
        strictTerminalReplyFixture({
          input: "remember this chat",
          text: "Noted.",
        }),
        strictTerminalReplyFixture({ input: "and this one", text: "Noted." }),
      ],
    }),
  );
  await runtime.initialize();
  runtime.getService(OPTIMIZED_PROMPT_SERVICE);
  await runtime.getServiceLoadPromise(OPTIMIZED_PROMPT_SERVICE);
  const server = await startApiServer({
    port: 0,
    runtime,
    skipDeferredStartupWork: true,
  });
  try {
    expect(runtime.character.name).toBe("Nova");
    const completions = await req(
      server.port,
      "POST",
      "/v1/chat/completions",
      {
        model: "eliza",
        messages: [{ role: "user", content: "remember this chat" }],
      },
      undefined,
      { timeoutMs: 120_000 },
    );
    expect(completions.status).toBe(200);
    const messages = await req(
      server.port,
      "POST",
      "/v1/messages",
      {
        model: "eliza",
        max_tokens: 64,
        messages: [{ role: "user", content: "and this one" }],
      },
      undefined,
      { timeoutMs: 120_000 },
    );
    expect(messages.status).toBe(200);
    expect(
      await runtime.getWorld(stringToUuid("Eliza-web-chat-world")),
    ).toBeTruthy();
    expect(
      await runtime.getWorld(stringToUuid("Nova-web-chat-world")),
    ).toBeNull();
  } finally {
    await server.close();
    await runtime.stop().catch(() => undefined);
    await (
      runtime.adapter as { close?: () => Promise<void> } | undefined
    )?.close?.();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}, 240_000);
