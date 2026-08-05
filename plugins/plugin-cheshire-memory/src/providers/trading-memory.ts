import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { buildMemoryStoreFromConfig } from "../memory-client.js";
import { memoryBackendStatus, readCheshireMemoryConfig } from "../config.js";

export const tradingMemoryProvider: Provider = {
  name: "CHESHIRE_TRADING_MEMORY",
  description:
    "Persistent trading + chat memory via Hermes (HERMES_API_KEY) and Honcho (HONCHO_API_KEY).",
  dynamic: true,
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const cfg = readCheshireMemoryConfig((k) => runtime.getSetting(k) as string | undefined);
    if (!cfg.tradingMemoryEnabled) {
      return { text: "Trading memory disabled (CHESHIRE_TRADING_MEMORY=false)." };
    }
    const status = memoryBackendStatus(cfg);
    const store = buildMemoryStoreFromConfig(cfg);
    const recent = await store.recent(8);
    const lines = recent.map(
      (m) => `- ${new Date(m.ts).toISOString()} [${m.role}] ${m.content.slice(0, 160)}`,
    );
    const text = [
      `Memory backends: Hermes=${status.hermes} · Honcho=${status.honcho} · store=${store.backend}`,
      lines.length ? "Recent:\n" + lines.join("\n") : "No recent memory rows.",
      status.hermes === "missing" && status.honcho === "missing"
        ? "Set HERMES_API_KEY and/or HONCHO_API_KEY for durable memory."
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      text,
      data: {
        status,
        backend: store.backend,
        recentCount: recent.length,
      },
    };
  },
};
