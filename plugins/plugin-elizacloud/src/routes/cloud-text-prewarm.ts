import { type IAgentRuntime, ModelType } from "@elizaos/core";

// Admission warming is tied to the local runtime/provider lifecycle, not to a
// voice turn. Re-running a real one-token inference for every newly opened
// voice session can overlap the user's first utterance and recreate the exact
// multi-second "Thinking" delay this hint exists to remove. A runtime restart
// recreates this module and therefore naturally permits one fresh warmup.
const DEFAULT_PREWARM_COOLDOWN_MS = Number.POSITIVE_INFINITY;

export type CloudTextPrewarmResult = "warmed" | "already-warm";

/**
 * Creates a process-local, coalescing text-gateway prewarmer. The probe uses
 * the normal runtime model router with a one-token response cap: it exercises
 * the exact Cloud auth, admission, billing, model-catalog, and provider path
 * without creating a conversation turn or persisting synthetic chat history.
 */
export function createCloudTextPrewarmer(options: {
  cooldownMs?: number;
  now?: () => number;
} = {}) {
  const cooldownMs = options.cooldownMs ?? DEFAULT_PREWARM_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  let lastWarmedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  return async (
    runtime: Pick<IAgentRuntime, "useModel">,
  ): Promise<CloudTextPrewarmResult> => {
    if (now() - lastWarmedAt < cooldownMs) return "already-warm";

    if (!inFlight) {
      inFlight = (async () => {
        try {
          await runtime.useModel(ModelType.RESPONSE_HANDLER, {
            prompt: "ping",
            maxTokens: 32,
            temperature: 0,
            // Voice replies use the streaming Cloud route. Warming the buffered
            // sibling leaves `chat/completions:stream` cold and simply moves its
            // 503 backoff into the user's first Thinking interval.
            stream: true,
            streamStructured: true,
            streamSecurity: "required",
            voiceOutput: "internal",
            onStreamChunk: async () => undefined,
            responseSkeleton: {
              spans: [
                { kind: "literal", value: '{"replyText":' },
                { kind: "free-string", key: "replyText" },
                { kind: "literal", value: "}" },
              ],
            },
            tools: [
              {
                name: "HANDLE_RESPONSE",
                type: "function",
                strict: true,
                description: "Return one tiny warmup response.",
                parameters: {
                  type: "object",
                  properties: { replyText: { type: "string" } },
                  required: ["replyText"],
                  additionalProperties: false,
                },
              },
            ],
            toolChoice: "required",
            // Native options select the same OpenAI-compatible streaming
            // transport used by the real RESPONSE_HANDLER call.
            providerOptions: { eliza: { thinking: "off" } },
          });
        } catch (error) {
          // A provider that successfully returns zero output still completed
          // the transport/admission warmup. Every other failure remains
          // visible to the local gateway, whose real turn keeps its normal
          // typed retry/fallback behavior.
          if (!(error instanceof Error && error.name === "AI_NoOutputGeneratedError")) {
            throw error;
          }
        }
        lastWarmedAt = now();
      })().finally(() => {
        inFlight = null;
      });
    }

    await inFlight;
    return "warmed";
  };
}

export const prewarmCloudTextGateway = createCloudTextPrewarmer();
