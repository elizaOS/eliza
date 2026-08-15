/**
 * Boots the published Eliza Workers runtime inside a real Workerd isolate.
 * The fixture exercises runtime construction and initialization without a
 * model or external database so edge compatibility failures surface directly.
 */

import {
  AgentRuntime,
  asUUID,
  ChannelType,
  createMessageMemory,
  InMemoryDatabaseAdapter,
  ModelType,
} from "@elizaos/core/edge";

function uuid(): ReturnType<typeof asUUID> {
  return asUUID(crypto.randomUUID());
}

export default {
  async fetch(): Promise<Response> {
    const runtime = new AgentRuntime({
      character: {
        name: "Shared Eliza Edge Probe",
        bio: [],
        plugins: [],
        settings: {
          ALLOW_NO_DATABASE: "true",
          DISABLE_EMBEDDINGS: "true",
          ELIZA_CANONICAL_EMBEDDINGS_ENABLED: false,
        },
      },
      adapter: new InMemoryDatabaseAdapter(),
      plugins: [],
      logLevel: "error",
      enableAutonomy: false,
    });

    try {
      await runtime.initialize({
        skipMigrations: true,
      });
      const entityId = uuid();
      const roomId = uuid();
      await runtime.ensureConnection({
        entityId,
        roomId,
        worldId: uuid(),
        userName: "Edge tester",
        source: "cloudflare-probe",
        type: ChannelType.DM,
      });
      runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => ({
          text: "",
          toolCalls: [
            {
              id: "edge-handle-response",
              name: "HANDLE_RESPONSE",
              arguments: {
                shouldRespond: "RESPOND",
                thought: "The Workerd runtime handled the turn.",
                contexts: ["simple"],
                intents: [],
                candidateActionNames: [],
                replyText: "hello from the real edge runtime",
                facts: [],
                relationships: [],
                addressedTo: [],
              },
            },
          ],
          finishReason: "tool_calls",
        }),
        "edge-probe",
        100,
      );
      const delivered: string[] = [];
      const result = await runtime.messageService?.handleMessage(
        runtime,
        createMessageMemory({
          id: uuid(),
          entityId,
          roomId,
          content: {
            text: "say hello",
            source: "cloudflare-probe",
            channelType: ChannelType.DM,
          },
        }),
        async (content) => {
          if (content.text) delivered.push(content.text);
          return [];
        },
      );
      return Response.json({
        agentId: runtime.agentId,
        character: runtime.character.name,
        messageServiceReady:
          typeof runtime.messageService?.handleMessage === "function",
        plugins: runtime.plugins.map((plugin) => plugin.name),
        didRespond: result?.didRespond,
        reply: result?.responseContent?.text,
        delivered,
      });
    } finally {
      await runtime.stop();
      await runtime.close();
    }
  },
};
