import { type IAgentRuntime, ModelType } from "@elizaos/core";

// Coalesce a burst of closely spaced session starts, but keep this lease much
// shorter than the upstream streaming-admission cache. A long-lived local
// gateway can otherwise report `already-warm` after the upstream lane cooled,
// leaving the user's first real turn to pay the 503 warmup backoff.
const DEFAULT_PREWARM_COOLDOWN_MS = 5_000;

export type CloudTextPrewarmResult = "warmed" | "already-warm";
export type CloudTextPrewarmLane = "response-handler" | "committed-reply";

export class CloudTextPrewarmError extends Error {
  readonly causeClass: string;
  readonly causeCode?: string;
  readonly causeReason?: string;
  readonly statusCode?: number;

  constructor(
    readonly lane: CloudTextPrewarmLane,
    cause: unknown,
  ) {
    super("Cloud text prewarm failed", { cause });
    this.name = "CloudTextPrewarmError";
    this.causeClass = cause instanceof Error ? cause.name : "UnknownError";
    const candidateCode =
      cause && typeof cause === "object" && "code" in cause
        ? (cause as { code?: unknown }).code
        : undefined;
    this.causeCode =
      typeof candidateCode === "string" && /^[A-Z0-9_:-]{1,64}$/.test(candidateCode)
        ? candidateCode
        : undefined;
    const candidateContext =
      cause && typeof cause === "object" && "context" in cause
        ? (cause as { context?: unknown }).context
        : undefined;
    const candidateReason =
      candidateContext &&
      typeof candidateContext === "object" &&
      "reason" in candidateContext
        ? (candidateContext as { reason?: unknown }).reason
        : undefined;
    this.causeReason =
      this.causeCode === "ELIZA_CLOUD_STREAM_INVALID" &&
      typeof candidateReason === "string"
        ? candidateReason
        : undefined;
    const candidateStatus =
      cause && typeof cause === "object" && "statusCode" in cause
        ? (cause as { statusCode?: unknown }).statusCode
        : undefined;
    this.statusCode =
      typeof candidateStatus === "number" && Number.isFinite(candidateStatus)
        ? candidateStatus
        : undefined;
  }
}

/**
 * Creates a process-local, coalescing text-gateway prewarmer. The probe uses
 * the normal runtime model router with a tiny response cap: it exercises
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
        const acceptNoOutput = async (
          lane: CloudTextPrewarmLane,
          task: Promise<unknown>,
        ): Promise<void> => {
          try {
            await task;
          } catch (error) {
            // error-policy:J5 the provider model handler already records its
            // diagnostic. Re-throw only a fixed lane identifier so the
            // loopback control plane never exposes provider payloads.
            // A provider that successfully returns zero output still completed
            // the transport/admission warmup. Every other failure remains
            // visible to the local gateway, whose real turn keeps its normal
            // typed retry/fallback behavior.
            if (!(error instanceof Error && error.name === "AI_NoOutputGeneratedError")) {
              throw new CloudTextPrewarmError(lane, error);
            }
          }
        };

        // Voice turns use two independently routed Cloud streaming models:
        // RESPONSE_HANDLER for the private structured participation gate, then
        // TEXT_LARGE for committed user-visible prose. Warm both exact request
        // shapes concurrently; warming only Gemma leaves GLM's first committed
        // reply paying the provider's 503 admission backoff.
        await Promise.all([
          acceptNoOutput(
            "response-handler",
            runtime.useModel(ModelType.RESPONSE_HANDLER, {
              prompt: "ping",
              maxTokens: 32,
              temperature: 0,
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
            }),
          ),
          acceptNoOutput(
            "committed-reply",
            runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "Reply with exactly one word: ready.",
              maxTokens: 32,
              temperature: 0,
              stream: true,
              streamCommittedReply: true,
              streamSecurity: "required",
              voiceOutput: "internal",
              onStreamChunk: async () => undefined,
              providerOptions: { eliza: { thinking: "off" } },
            }),
          ),
        ]);
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
