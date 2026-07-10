/**
 * HARNESS-ONLY LLM leg.
 *
 * PRODUCTION TRUTH: in the real voice-session service (VOICE-INTEGRATION-DECISION
 * section 7 / 9), the middle leg is the EXISTING Eliza conversation SSE, which
 * reaches the Cerebras `gemma-4-31b` byte pass-through. That bridge
 * (`eliza-sse-bridge.ts`) writes no history and forwards abort + trace headers.
 *
 * This harness cannot reach a funded Cerebras/Eliza-cloud org from a laptop
 * (VOICE-INTEGRATION-DECISION section 12 flags the funded-staging blocker), so
 * the harness substitutes an EQUIVALENT REAL streaming LLM over OpenRouter:
 * real network, real token-by-token SSE, real first-text latency, real abort
 * semantics. It is NOT a mock — it is a different real streaming LLM standing in
 * for the specific model while the provider contract (streaming deltas + abort)
 * is exercised for real. When the funded staging org lands, point
 * `LLM_STREAM_URL` / model at the Eliza SSE endpoint and nothing else changes.
 *
 * The abort path is the one that matters for barge-in: an AbortSignal must
 * actually stop upstream token generation. This uses `fetch` streaming with the
 * caller's AbortSignal so cancellation is real, matching the SSE bridge contract.
 */

export interface LlmStreamHandlers {
  onFirstText: (elapsedFromCallMs: number) => void;
  onDelta: (text: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

export interface LlmStreamConfig {
  apiKey: string;
  baseUrl?: string; // OpenAI-compatible /chat/completions
  model?: string;
  systemPrompt?: string;
}

const DEFAULT_BASE = "https://openrouter.ai/api/v1/chat/completions";
// A small, fast, cheap real model. Pennies per run.
const DEFAULT_MODEL = "meta-llama/llama-3.1-8b-instruct";

export async function streamLlmReply(
  userText: string,
  config: LlmStreamConfig,
  signal: AbortSignal,
  handlers: LlmStreamHandlers,
): Promise<void> {
  const started = performance.now();
  let firstEmitted = false;
  let full = "";
  try {
    const res = await fetch(config.baseUrl ?? DEFAULT_BASE, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "X-Title": "voice-evidence-harness",
      },
      body: JSON.stringify({
        model: config.model ?? DEFAULT_MODEL,
        stream: true,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content:
              config.systemPrompt ??
              "You are a concise voice assistant. Reply in 2-3 short spoken sentences.",
          },
          { role: "user", content: userText },
        ],
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`LLM HTTP ${res.status} ${res.statusText}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const delta: string | undefined = j?.choices?.[0]?.delta?.content;
          if (delta) {
            if (!firstEmitted) {
              firstEmitted = true;
              handlers.onFirstText(performance.now() - started);
            }
            full += delta;
            handlers.onDelta(delta);
          }
        } catch (ignoredError) {
          void ignoredError;
          // skip keepalive/comment lines
        }
      }
    }
    handlers.onDone(full);
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      // abort is a first-class outcome for barge-in; surface partial text
      handlers.onDone(full);
      return;
    }
    handlers.onError(err as Error);
  }
}
