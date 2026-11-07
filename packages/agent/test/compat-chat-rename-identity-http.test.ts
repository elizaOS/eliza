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

/** Boots a real runtime and API server from `config`, as a start does. */
async function withBootedAgent(
  config: Parameters<typeof saveElizaConfig>[0],
  run: (runtime: AgentRuntime, port: number) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "compat-chat-rename-"));
  const configPath = path.join(dir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  saveElizaConfig(config);
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
    await run(runtime, server.port);
  } finally {
    await server.close();
    await runtime.stop().catch(() => undefined);
    await (
      runtime.adapter as { close?: () => Promise<void> } | undefined
    )?.close?.();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}

function chatCompletion(port: number) {
  return req(
    port,
    "POST",
    "/v1/chat/completions",
    {
      model: "eliza",
      messages: [{ role: "user", content: "remember this chat" }],
    },
    undefined,
    { timeoutMs: 120_000 },
  );
}

it("keeps the compat chat routes on the identity world after a rename and restart", async () => {
  // The config that PUT /api/character writes when Eliza is renamed to Nova.
  await withBootedAgent(
    {
      ui: { assistant: { name: "Nova" } },
      agents: {
        list: [
          { id: "main", default: true, name: "Nova", identityName: "Eliza" },
        ],
      },
    },
    async (runtime, port) => {
      expect(runtime.character.name).toBe("Nova");
      expect((await chatCompletion(port)).status).toBe(200);
      const messages = await req(
        port,
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
    },
  );
}, 240_000);

it("keeps the chat world and agent id when first-run names a running agent", async () => {
  // The app starts the agent with the default name, then onboarding names it.
  await withBootedAgent({}, async (runtime, port) => {
    const bootName = runtime.character.name;
    const firstRun = await req(port, "POST", "/api/first-run", {
      name: "Luna",
      deploymentTarget: { runtime: "local" },
    });
    expect(firstRun.status).toBe(200);
    expect(runtime.character.name).toBe("Luna");
    expect((await chatCompletion(port)).status).toBe(200);
    expect(
      await runtime.getWorld(stringToUuid(`${bootName}-web-chat-world`)),
    ).toBeTruthy();

    // The next boot builds the character from the saved config.
    const restarted = new AgentRuntime({
      character: buildCharacterFromConfig(loadElizaConfig()),
    });
    expect(restarted.character.name).toBe("Luna");
    expect(restarted.agentId).toBe(runtime.agentId);
    expect(restarted.character.settings?.identityName).toBe(bootName);
  });
}, 240_000);
