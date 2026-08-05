import type { Plugin } from "@elizaos/core";
import { recallMemoryAction, rememberTradeAction } from "./actions/remember-trade.js";
import { tradingMemoryProvider } from "./providers/trading-memory.js";

export {
  buildMemoryStoreFromConfig,
  createHermesMemoryStore,
  createHonchoMemoryStore,
  createHybridMemoryStore,
  createOfflineMemoryStore,
} from "./memory-client.js";
export { memoryBackendStatus, readCheshireMemoryConfig } from "./config.js";
export { tradingMemoryProvider } from "./providers/trading-memory.js";
export { recallMemoryAction, rememberTradeAction } from "./actions/remember-trade.js";

export const cheshireMemoryPlugin: Plugin = {
  name: "@elizaos/plugin-cheshire-memory",
  description:
    "Persistent trading + chat memory: HERMES_API_KEY (vault/trade recall) and HONCHO_API_KEY (peer dialectic memory).",
  actions: [rememberTradeAction, recallMemoryAction],
  providers: [tradingMemoryProvider],
  services: [],
};

export default cheshireMemoryPlugin;
