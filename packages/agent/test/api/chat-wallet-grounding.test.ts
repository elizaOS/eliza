/** Exercises the chat adapter with the real runtime, message service, and persistence; model transport and wallet observations are controlled. */
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  createMessageMemory,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
  ModelType,
  type State,
} from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { generateChatResponse } from "../../src/api/chat-routes.js";

it.each([2, 4])(
  "delivers and persists the observed %s SOL through the real message service",
  async (observedAmount) => {
    const owner = crypto.randomUUID();
    const runtime = new AgentRuntime({
      character: createCharacter({
        name: "Wallet route proof",
        bio: "Local boundary test",
        settings: { ELIZA_ADMIN_ENTITY_ID: owner },
      }),
      adapter: new InMemoryDatabaseAdapter(),
      enableAutonomy: false,
      logLevel: "fatal",
    });
    await runtime.initialize({ skipMigrations: true });
    try {
      await runtime.ensureConnection({
        entityId: owner,
        roomId: runtime.agentId,
        worldId: runtime.agentId,
        userName: "owner",
        name: "owner",
        source: "client_chat",
        type: ChannelType.DM,
      });
      runtime.actions.length = 0;
      runtime.evaluators.length = 0;
      runtime.composeState = vi.fn(
        async (): Promise<State> => ({
          values: { availableContexts: "general" },
          data: {
            providers: {
              BIRDEYE_WALLET_PORTFOLIO: {
                data: {
                  portfolio: {
                    items: [{ symbol: "SOL", uiAmount: observedAmount }],
                  },
                },
              },
            },
          },
          text: "Current controlled wallet observation.",
        }),
      );
      runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => ({
          text: "",
          toolCalls: [
            {
              id: "wallet-reply",
              name: "HANDLE_RESPONSE",
              arguments: {
                shouldRespond: "RESPOND",
                thought: "Answer from the wallet observation.",
                contexts: ["general"],
                intents: ["read wallet balance"],
                candidateActionNames: [],
                replyText: "Your wallet balance is 4 SOL.",
                facts: [],
                relationships: [],
                addressedTo: [],
                requiresTool: false,
              },
            },
          ],
          finishReason: "tool_calls",
        }),
        "wallet-route-test",
        100,
      );
      const corrected = `Your wallet balance is ${observedAmount} SOL.`;
      const rewrite = vi.fn(
        async (_runtime: IAgentRuntime, params: { prompt: string }) =>
          params.prompt.startsWith("Compose a user-facing response")
            ? JSON.stringify({ response: corrected })
            : corrected,
      );
      runtime.registerModel(
        ModelType.TEXT_SMALL,
        rewrite,
        "wallet-route-test",
        100,
      );
      const message = createMessageMemory({
        agentId: runtime.agentId,
        entityId: owner,
        roomId: runtime.agentId,
        content: {
          text: "What is my SOL balance?",
          source: "client_chat",
          channelType: ChannelType.DM,
        },
      });
      const result = await generateChatResponse(
        runtime,
        message,
        "Wallet route proof",
      );
      expect(result.text).toBe(corrected);
      if (observedAmount === 2) expect(rewrite).toHaveBeenCalled();
      else expect(rewrite).not.toHaveBeenCalled();
      expect(result.persistedResponseMessageIds?.length).toBeGreaterThan(0);
      const persisted = await Promise.all(
        (result.persistedResponseMessageIds ?? []).map((id) =>
          runtime.getMemoryById(id),
        ),
      );
      expect(
        persisted.some((memory) => memory?.content.text === result.text),
      ).toBe(true);
      if (observedAmount === 2)
        expect(
          persisted.some(
            (memory) =>
              memory?.content.text === "Your wallet balance is 4 SOL.",
          ),
        ).toBe(false);
    } finally {
      await runtime.stop();
      await runtime.close();
    }
  },
);
