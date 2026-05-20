import { elizaLogger } from "@elizaos/core";

/**
 * Auto-wire the `@elizaos/plugin-openai` env keys from a `CEREBRAS_API_KEY`
 * when no competing OpenAI-compat configuration is present.
 *
 * The `.env` in this repo typically defines `CEREBRAS_API_KEY` /
 * `CEREBRAS_BASE_URL` / `CEREBRAS_MODEL` but does NOT set `OPENAI_BASE_URL` /
 * `OPENAI_API_KEY` / `ELIZA_PROVIDER` — the keys the plugin code path
 * actually reads. Without those, the openai plugin is skipped at load time,
 * no TEXT_LARGE / TEXT_SMALL handler is registered, and every benchmark turn
 * falls back to the "no LLM provider configured" stub.
 *
 * Promotes Cerebras config to OpenAI-compat keys when ALL of these hold:
 *   - `CEREBRAS_API_KEY` is set
 *   - no competing OpenAI-compat key is present (`OPENAI_API_KEY`,
 *     `OPENAI_BASE_URL`, and `ELIZA_PROVIDER` are all unset)
 *
 * Never overwrites an existing OPENAI_* or ELIZA_PROVIDER value unless the
 * benchmark run explicitly selected Cerebras.
 *
 * The resulting `OPENAI_BASE_URL=https://api.cerebras.ai/v1` is the V1 root
 * onto which `@ai-sdk/openai`'s `openai.chat(model)` appends
 * `/chat/completions` (Cerebras's only supported endpoint). The Responses API
 * (`/v1/responses`) does not exist on Cerebras, so it is critical that
 * `plugin-openai/models/text.ts` uses `openai.chat()` (not
 * `openai.responses()` / `openai.languageModel()`).
 */
export function autoWireCerebras(): void {
  const cerebrasKey = process.env.CEREBRAS_API_KEY?.trim();
  if (!cerebrasKey) return;
  const cerebrasBase =
    process.env.CEREBRAS_BASE_URL?.trim() || "https://api.cerebras.ai/v1";
  const selectedModel =
    process.env.BENCHMARK_MODEL_NAME?.trim() ||
    process.env.CEREBRAS_MODEL?.trim() ||
    "";
  const modelIsCerebras =
    selectedModel === "gpt-oss-120b" ||
    selectedModel === "qwen-3-235b-a22b-instruct-2507";
  const explicitCerebras =
    process.env.BENCHMARK_MODEL_PROVIDER?.trim().toLowerCase() === "cerebras" ||
    process.env.ELIZA_PROVIDER?.trim().toLowerCase() === "cerebras" ||
    process.env.OPENAI_BASE_URL?.includes("cerebras.ai") === true ||
    modelIsCerebras;
  const hasOpenAiKey = !!process.env.OPENAI_API_KEY?.trim();
  const hasOpenAiBase = !!process.env.OPENAI_BASE_URL?.trim();
  const hasElizaProvider = !!process.env.ELIZA_PROVIDER?.trim();
  if (
    !explicitCerebras &&
    (hasOpenAiKey || hasOpenAiBase || hasElizaProvider)
  ) {
    return;
  }

  process.env.OPENAI_BASE_URL = cerebrasBase;
  process.env.OPENAI_API_KEY = cerebrasKey;
  process.env.ELIZA_PROVIDER = "cerebras";

  const cerebrasModel = process.env.CEREBRAS_MODEL?.trim() || "gpt-oss-120b";
  if (!process.env.OPENAI_LARGE_MODEL?.trim()) {
    process.env.OPENAI_LARGE_MODEL = cerebrasModel;
  }
  if (!process.env.OPENAI_SMALL_MODEL?.trim()) {
    process.env.OPENAI_SMALL_MODEL = cerebrasModel;
  }

  elizaLogger.info(
    `[bench] Auto-wired Cerebras: OPENAI_BASE_URL=${cerebrasBase}, ` +
      `ELIZA_PROVIDER=cerebras, OPENAI_LARGE_MODEL=${process.env.OPENAI_LARGE_MODEL}, ` +
      `OPENAI_SMALL_MODEL=${process.env.OPENAI_SMALL_MODEL}`,
  );
}
