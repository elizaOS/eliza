import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { fetchYieldSignal, type YieldSignalAsset } from "../client.js";

function parseAsset(text: string): YieldSignalAsset {
  return /weth|eth\b/i.test(text) ? "WETH" : "USDC";
}

export const getYieldSignalAction: Action = {
  name: "GET_YIELD_SIGNAL",
  similes: ["CHECK_YIELD_SIGNAL", "BEST_LENDING_RATE", "USDC_WETH_APY"],
  description:
    "Real-time risk-weighted USDC or WETH lending APY across Aave, Compound, Morpho, Moonwell, Euler and Fluid on Base. Costs $0.01 USDC per call via x402.",
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => true,
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const asset = parseAsset(
      typeof message.content?.text === "string" ? message.content.text : "",
    );
    try {
      const signal = await fetchYieldSignal(asset);
      const text = `Best ${asset} lending rate on Base right now: ${signal.bestProtocol} (${signal.gapBps}bps ahead of the runner-up).`;
      await callback?.({ text });
      // `ActionResult.data` is `ProviderDataRecord`; the concrete response
      // object satisfies it structurally (all fields are JSON-serialisable),
      // but TS needs the cast because the interface has no index signature.
      return {
        success: true,
        text,
        data: signal as unknown as ActionResult["data"],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await callback?.({
        text: `Failed to fetch the ${asset} yield signal: ${error}`,
      });
      return { success: false, error };
    }
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "What's the best USDC lending rate on Base right now?",
        },
      },
      {
        name: "{{agent}}",
        content: { text: "Checking...", action: "GET_YIELD_SIGNAL" },
      },
    ],
  ],
};
