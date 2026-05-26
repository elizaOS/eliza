import { ModelType, type Plugin } from "@elizaos/core";

export function createDeterministicLlmProxyPlugin(opts: {
  embeddingDimensions: number;
}): Plugin {
  return {
    name: "deterministic-llm-proxy",
    description: "Deterministic LLM proxy for scenario testing",
    models: {
      [ModelType.TEXT_SMALL]: async (_runtime: never, params: { messages: Array<{ role: string; content: string }> }) => {
        const lastMessage = params.messages[params.messages.length - 1]?.content ?? "";
        return `deterministic-test-response: ${lastMessage}`;
      },
      [ModelType.TEXT_EMBEDDING]: async (_runtime: never, _text: string) => {
        return new Array(opts.embeddingDimensions).fill(0);
      },
    },
  };
}
