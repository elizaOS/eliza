import path from "node:path";
import type { GenerateTextParams, IAgentRuntime, Plugin } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { evaluateCoinAction, pnlAction, tradingControlAction } from "./actions.ts";
import { brainFor } from "./brain.ts";
import { generateWithGemini, promptOf } from "./gemini.ts";
import { valhallaStatusProvider } from "./provider.ts";
import { ValhallaTradingService } from "./service.ts";

const env = process.env;

async function geminiText(
  runtime: IAgentRuntime,
  params: GenerateTextParams | string | null | undefined,
  tier: "small" | "large"
): Promise<string> {
  const apiKey = String(
    runtime.getSetting("GOOGLE_GENERATIVE_AI_API_KEY") || env.GOOGLE_GENERATIVE_AI_API_KEY || ""
  );
  const small = String(
    runtime.getSetting("VALHALLA_GEMINI_MODEL") || env.VALHALLA_GEMINI_MODEL || "gemini-2.5-flash"
  );
  const large = String(
    runtime.getSetting("VALHALLA_GEMINI_LARGE_MODEL") ||
      env.VALHALLA_GEMINI_LARGE_MODEL ||
      "gemini-2.5-pro"
  );
  const prompt = promptOf(params);
  const maxTokens = typeof params === "object" && params ? params.maxTokens : undefined;
  const temperature = typeof params === "object" && params ? params.temperature : undefined;
  return generateWithGemini({
    apiKey,
    model: tier === "large" ? large : small,
    prompt: prompt.prompt,
    ...(prompt.system ? { system: prompt.system } : {}),
    ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
    ...(temperature != null ? { temperature } : {}),
  });
}

/**
 * The ElizaOS runtime model call. It answers with the Brain provider when one is
 * ready, so the fork uses the provider picked in Controls or named in .env.
 * Otherwise it keeps the Gemini path, so an existing setup does not change.
 */
async function runtimeText(
  runtime: IAgentRuntime,
  params: GenerateTextParams | string | null | undefined,
  tier: "small" | "large"
): Promise<string> {
  const dataDir = String(
    runtime.getSetting("VALHALLA_DATA_DIR") ||
      env.VALHALLA_DATA_DIR ||
      path.join(process.cwd(), "data")
  );
  const brain = brainFor(dataDir);
  if (!brain.ready()) return geminiText(runtime, params, tier);
  const prompt = promptOf(params);
  const maxTokens = typeof params === "object" && params ? params.maxTokens : undefined;
  return brain.generateText("chat", prompt.prompt, {
    ...(prompt.system ? { system: prompt.system } : {}),
    ...(maxTokens != null ? { maxOutputTokens: maxTokens } : {}),
  });
}

export const valhallaCopybotPlugin: Plugin = {
  name: "valhalla-copybot",
  description:
    "Valhalla Mech Solana memecoin copy trading. Brain provider text, Gemini when no Brain key is set. Paper by default. No transfer or withdraw actions.",
  autoEnable: { envKeys: ["VALHALLA_COPYBOT"] },
  priority: 10,
  config: {
    GOOGLE_GENERATIVE_AI_API_KEY: env.GOOGLE_GENERATIVE_AI_API_KEY ?? null,
    VALHALLA_GEMINI_MODEL: env.VALHALLA_GEMINI_MODEL ?? "gemini-2.5-flash",
    VALHALLA_LIVE_TRADING: env.VALHALLA_LIVE_TRADING ?? "false",
    HELIUS_API_KEY: env.HELIUS_API_KEY ?? null,
    BIRDEYE_API_KEY: env.BIRDEYE_API_KEY ?? env.BIRDEYE ?? null,
    VALHALLA_PUBKEY: env.VALHALLA_PUBKEY ?? null,
  },
  actions: [evaluateCoinAction, tradingControlAction, pnlAction],
  providers: [valhallaStatusProvider],
  services: [ValhallaTradingService],
  models: {
    [ModelType.TEXT_SMALL]: (runtime, params) => runtimeText(runtime, params, "small"),
    [ModelType.TEXT_LARGE]: (runtime, params) => runtimeText(runtime, params, "large"),
    [ModelType.TEXT_MEDIUM]: (runtime, params) => runtimeText(runtime, params, "small"),
    [ModelType.TEXT_NANO]: (runtime, params) => runtimeText(runtime, params, "small"),
    [ModelType.TEXT_MEGA]: (runtime, params) => runtimeText(runtime, params, "large"),
    [ModelType.RESPONSE_HANDLER]: (runtime, params) => runtimeText(runtime, params, "small"),
    [ModelType.ACTION_PLANNER]: (runtime, params) => runtimeText(runtime, params, "small"),
  },
};

export default valhallaCopybotPlugin;
