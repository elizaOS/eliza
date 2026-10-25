import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, ModelType } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { generateMediaAction } from "../../../plugins/plugin-assistant/src/features/advanced-capabilities/actions/generateMedia.ts";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { startApiServer } from "../src/api/server.ts";
import { saveElizaConfig } from "../src/config/config.ts";
import { AgentMediaGenerationService } from "../src/services/media-generation.ts";

const PROVIDER_IMAGE_URL =
  "https://imgen.x.ai/xai-imgen/generated-lighthouse.png";

it("returns and persists the GENERATE_MEDIA image attachment on the app chat reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-chat-media-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
    ELIZA_TRAJECTORY_RECORDING: "0",
  }))
    vi.stubEnv(key, value);
  const providerKey = `fake-xai-${crypto.randomUUID()}`;
  saveElizaConfig({
    media: {
      image: { mode: "own-key", provider: "xai", xai: { apiKey: providerKey } },
    },
  });
  const realFetch = globalThis.fetch;
  const providerRequests: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.x.ai/v1/images/generations") {
        providerRequests.push(url);
        return Response.json({
          data: [{ url: PROVIDER_IMAGE_URL, revised_prompt: "a lighthouse" }],
        });
      }
      return realFetch(input, init);
    },
  );
  const runtime = new AgentRuntime({
    character: { name: "Media chat fixture", bio: [] },
    plugins: [
      createAssistantPlugin(),
      {
        name: "chat-media-fixture",
        description: "GENERATE_MEDIA with the agent media service",
        actions: [generateMediaAction],
        services: [AgentMediaGenerationService],
      },
    ],
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
    await runtime.initialize();
    runtime.registerModel(
      ModelType.RESPONSE_HANDLER,
      async () => ({
        text: "",
        toolCalls: [
          {
            id: "handle-response-media",
            name: "HANDLE_RESPONSE",
            arguments: {
              shouldRespond: "RESPOND",
              thought: "The user wants a generated image.",
              contexts: ["media"],
              intents: ["generate an image"],
              candidateActionNames: ["GENERATE_MEDIA"],
              replyText: "",
              facts: [],
              relationships: [],
              addressedTo: [],
              requiresTool: true,
            },
          },
        ],
        finishReason: "tool_calls",
      }),
      "chat-media-fixture",
      1000,
    );
    runtime.registerModel(
      ModelType.ACTION_PLANNER,
      async () => ({
        text: "",
        toolCalls: [
          {
            id: "generate-media",
            name: "GENERATE_MEDIA",
            arguments: {
              mediaType: "image",
              prompt: "a lighthouse at dusk",
            },
          },
        ],
      }),
      "chat-media-fixture",
      1000,
    );
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const created = await fetch(`${base}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Generated media" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = (await created.json()) as {
      conversation: { id: string; roomId: string };
    };
    const sent = await fetch(
      `${base}/api/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "generate an image of a lighthouse at dusk",
          channelType: "DM",
          clientMessageId: "generated-media-turn",
        }),
      },
    );
    const reply = (await sent.json()) as Record<string, unknown>;
    expect(sent.status).toBe(200);
    expect(providerRequests).toEqual([
      "https://api.x.ai/v1/images/generations",
    ]);
    expect(reply.text).toBe("here's your image.");
    expect(reply.historyRefreshRequired).toBe(true);

    const streamed = await fetch(
      `${base}/api/conversations/${conversation.id}/messages/stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "generate another image of a lighthouse at dusk",
          channelType: "DM",
          clientMessageId: "generated-media-stream-turn",
        }),
      },
    );
    expect(streamed.status).toBe(200);
    const frames = await streamed.text();
    expect(frames).toContain('"type":"done"');
    expect(frames).toContain('"historyRefreshRequired":true');

    const history = (await (
      await fetch(`${base}/api/conversations/${conversation.id}/messages`)
    ).json()) as { messages: Array<Record<string, unknown>> };
    const assistant = history.messages.filter(
      (row) => row.role === "assistant",
    );
    expect(assistant).toHaveLength(2);
    for (const row of assistant) {
      expect(row.text).toBe("here's your image.");
      expect(row.attachments).toEqual([
        expect.objectContaining({
          url: PROVIDER_IMAGE_URL,
          contentType: "image",
          source: "media-generation",
        }),
      ]);
    }
  } finally {
    if (server) await server.close();
    await runtime.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
