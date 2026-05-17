import { logger } from "@elizaos/core";

export async function ensureModelAvailable(
  model: string,
  providedBaseURL?: string,
  customFetch?: typeof fetch | null
): Promise<void> {
  const baseURL = providedBaseURL || "http://localhost:11434/api";
  const apiBase = baseURL.endsWith("/api") ? baseURL.slice(0, -4) : baseURL;
  const fetcher = customFetch ?? fetch;

  try {
    const showRes = await fetcher(`${apiBase}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });

    if (showRes.ok) {
      return;
    }

    logger.info(`[Ollama] Model ${model} not found locally. Downloading...`);

    const pullRes = await fetcher(`${apiBase}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false }),
    });

    if (!pullRes.ok) {
      logger.error(`Failed to pull model ${model}: ${pullRes.statusText}`);
    } else {
      logger.info(`[Ollama] Downloaded model ${model}`);
    }
  } catch (err) {
    logger.error({ error: err }, "Error ensuring model availability");
  }
}
