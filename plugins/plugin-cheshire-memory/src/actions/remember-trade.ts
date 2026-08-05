import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { buildMemoryStoreFromConfig } from "../memory-client.js";
import { readCheshireMemoryConfig } from "../config.js";

export const rememberTradeAction: Action = {
  name: "REMEMBER_TRADE",
  similes: ["STORE_TRADE_MEMORY", "LOG_TRADE_TO_MEMORY", "HERMES_REMEMBER"],
  description: "Persist a trade note to Hermes/Honcho memory for later chat/trading context.",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /remember\s+(this\s+)?trade|log\s+trade|store\s+trade\s+memory/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const cfg = readCheshireMemoryConfig((k) => runtime.getSetting(k) as string | undefined);
    const store = buildMemoryStoreFromConfig(cfg);
    const content = (message.content?.text || "").replace(/^.*?trade[:\s]*/i, "").trim() ||
      message.content?.text ||
      "";
    await store.append({
      role: "trade",
      content,
      ts: Date.now(),
      meta: { source: "eliza-plugin-cheshire-memory" },
    });
    const text = `Stored trade memory (${store.backend}).`;
    if (callback) await callback({ text, actions: ["REMEMBER_TRADE"] });
    return { success: true, text, data: { backend: store.backend } };
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Remember this trade: bought 0.5 SOL CLAWD at $0.00012" },
      },
      {
        name: "{{agent}}",
        content: { text: "Stored trade memory.", actions: ["REMEMBER_TRADE"] },
      },
    ],
  ],
};

export const recallMemoryAction: Action = {
  name: "RECALL_MEMORY",
  similes: ["HONCHO_CHAT", "ASK_MEMORY", "HERMES_RECALL"],
  description: "Query Hermes/Honcho durable memory for trading or chat context.",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /what\s+do\s+you\s+remember|recall\s+memory|honcho|hermes\s+memory/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const cfg = readCheshireMemoryConfig((k) => runtime.getSetting(k) as string | undefined);
    const store = buildMemoryStoreFromConfig(cfg);
    const query = message.content?.text || "preferences";
    const answer = await store.ask(query);
    if (callback) await callback({ text: answer, actions: ["RECALL_MEMORY"] });
    return { success: true, text: answer, data: { backend: store.backend } };
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "What do you remember about my trading style?" } },
      {
        name: "{{agent}}",
        content: { text: "Checking durable memory…", actions: ["RECALL_MEMORY"] },
      },
    ],
  ],
};
