/**
 * Shared llama.cpp (eliza-fork `llama-server`) adapter for the local prompt-
 * optimization measurement scripts. We use llama.cpp — NOT Ollama — because the
 * production local-inference path is the eliza llama.cpp fork. That fork carries
 * the Gemma 4 chat-template, long-context, and separate-drafter MTP support used
 * by the active eliza-1 text tiers.
 *
 * Start a server first, e.g.:
 *   BC=plugins/plugin-local-inference/native/llama.cpp/build-cuda
 *   LD_LIBRARY_PATH="$BC/bin" "$BC/bin/llama-server" \
 *     -m /path/eliza-1-2b-128k.gguf --host 127.0.0.1 --port 8080 -ngl 99 -c 8192 --jinja
 *
 * Then point a script at it via LLAMACPP_URL (default http://127.0.0.1:8080).
 * One server serves ONE model, so these scripts test whichever GGUF is loaded
 * (label it via LABEL=...).
 *
 * Decoding is schema-constrained (OpenAI `response_format: json_schema`, mirrors
 * production guided decode). `chat_template_kwargs.enable_thinking=false` is
 * included for llama.cpp builds/models that expose thinking controls; these are
 * cheap structured classifications, so private reasoning tokens are not useful.
 */
import type { LlmAdapter } from "../../src/optimizers/types.js";

export const LLAMACPP_URL = process.env.LLAMACPP_URL ?? "http://127.0.0.1:8080";

export function llamacppAdapter(
  schema: object,
  url: string = LLAMACPP_URL,
): LlmAdapter {
  return {
    async complete({ system, user, temperature, maxTokens }) {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "out", schema, strict: true },
          },
          chat_template_kwargs: { enable_thinking: false },
          temperature: temperature ?? 0,
          max_tokens: maxTokens ?? 80,
        }),
      });
      if (!res.ok) {
        throw new Error(`llama-server ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? "";
    },
  };
}
