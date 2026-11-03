import type { GenerateTextParams, IAgentRuntime, Plugin } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { evaluateCoinAction, pnlAction, tradingControlAction } from "./actions.ts";
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

export const valhallaCopybotPlugin: Plugin = {
  name: "valhalla-copybot",
  description:
    "Valhalla Mech Solana memecoin copy trading. Google AI Studio Gemini text. Paper by default. No transfer or withdraw actions.",
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
    [ModelType.TEXT_SMALL]: (runtime, params) => geminiText(runtime, params, "small"),
    [ModelType.TEXT_LARGE]: (runtime, params) => geminiText(runtime, params, "large"),
    [ModelType.TEXT_MEDIUM]: (runtime, params) => geminiText(runtime, params, "small"),
    [ModelType.TEXT_NANO]: (runtime, params) => geminiText(runtime, params, "small"),
    [ModelType.TEXT_MEGA]: (runtime, params) => geminiText(runtime, params, "large"),
    [ModelType.RESPONSE_HANDLER]: (runtime, params) => geminiText(runtime, params, "small"),
    [ModelType.ACTION_PLANNER]: (runtime, params) => geminiText(runtime, params, "small"),
  },
};

export default valhallaCopybotPlugin;
