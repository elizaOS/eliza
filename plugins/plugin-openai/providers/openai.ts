/**
 * `createOpenAIClient`: builds the `@ai-sdk/openai` provider bound to the
 * runtime's resolved base URL and key. In proxy mode with no key it uses a
 * placeholder key (auth is injected upstream); otherwise a missing key means
 * this provider cannot serve the call.
 *
 * A missing credential is surfaced as a typed, *fallback-classifiable* error
 * (`OPENAI_CREDENTIAL_UNAVAILABLE`) rather than a bare `Error`. This mirrors
 * plugin-local-inference's `LOCAL_INFERENCE_UNAVAILABLE`: when a text provider
 * is registered but cannot serve a request, the runtime's `useModel` failover
 * loop must advance to the *next* registered handler (e.g. a pooled
 * ChatGPT/Codex `RESPONSE_HANDLER` from plugin-codex-cli that leases an
 * `openai-codex` subscription seat through the local codex-proxy) instead of
 * stranding the brain.
 *
 * Before this change, an Anthropic `RESPONSE_HANDLER` overload failed over to
 * plugin-openai, whose bare "OPENAI_API_KEY is required" throw is NOT a
 * fallback-class error (no rate-limit / 5xx / timeout signal), so the failover
 * chain rethrew and the whole turn died — even when a healthy pooled
 * openai-codex handler was registered later in the chain. Typing the error
 * lets that handler take over. It is still fail-closed: when no next handler
 * exists, the same terminal failure surfaces (no silent placeholder, no static
 * key invented).
 */
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { getApiKey, getBaseURL, isProxyMode } from "../utils/config";

const PROXY_API_KEY = "sk-proxy";

/**
 * Typed error code for "this OpenAI-compatible provider has no usable
 * credential for this runtime." Recognized by
 * `isModelProviderFallbackError` in `@elizaos/core` so `useModel` fails over
 * to the next registered text handler rather than stranding the brain.
 */
export const OPENAI_CREDENTIAL_UNAVAILABLE = "OPENAI_CREDENTIAL_UNAVAILABLE";

export function createOpenAIClient(runtime: IAgentRuntime): OpenAIProvider {
  const baseURL = getBaseURL(runtime);
  const apiKey = getApiKey(runtime);

  if (!apiKey && isProxyMode(runtime)) {
    return createOpenAI({
      apiKey: PROXY_API_KEY,
      baseURL,
    });
  }

  if (!apiKey) {
    // Fallback-classifiable: another registered text provider (e.g. a pooled
    // openai-codex RESPONSE_HANDLER via plugin-codex-cli) may safely answer.
    // The message preserves the operator-facing hint verbatim.
    throw new ElizaError(
      "OPENAI_API_KEY is required. Set it in your environment variables or runtime settings.",
      {
        code: OPENAI_CREDENTIAL_UNAVAILABLE,
        severity: "ephemeral",
      }
    );
  }

  return createOpenAI({
    apiKey,
    baseURL,
  });
}
