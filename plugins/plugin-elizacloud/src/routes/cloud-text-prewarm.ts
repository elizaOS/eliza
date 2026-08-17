import {
  type IAgentRuntime,
  ModelType,
  type ServiceRoutingConfig,
} from "@elizaos/core";

// The Cloud inference auth context has a 60-second physical TTL and refreshes
// off-response after 30 seconds. Refreshing this local lease at 45 seconds keeps
// an active dev voice gateway inside that window without racing a synthetic
// warmup beside each session start or real utterance.
const DEFAULT_PREWARM_COOLDOWN_MS = 45_000;

export type CloudTextPrewarmResult = "warmed" | "already-warm";
export type CloudTextPrewarmLane = "response-handler" | "committed-reply";

/**
 * The loopback voice probe exists to refresh Eliza Cloud's short-lived text
 * admission/auth leases. An explicitly direct text route has no such lease;
 * probing it would instead launch two unrelated provider generations beside
 * the user's real turn. Keep legacy/missing routing eligible so existing Cloud
 * proxy installs preserve their warmup behavior.
 */
export function shouldPrewarmCloudTextGateway(
  serviceRouting: ServiceRoutingConfig | null | undefined,
  cloudUseInference: string | undefined,
): boolean {
  if (cloudUseInference?.trim().toLowerCase() === "false") return false;
  return serviceRouting?.llmText?.transport !== "direct";
}

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
  const lastWarmedAt: Record<CloudTextPrewarmLane, number> = {
    "response-handler": Number.NEGATIVE_INFINITY,
    "committed-reply": Number.NEGATIVE_INFINITY,
  };
  const inFlight: Record<CloudTextPrewarmLane, Promise<void> | null> = {
    "response-handler": null,
    "committed-reply": null,
  };

  const acceptNoOutput = async (
    lane: CloudTextPrewarmLane,
    task: Promise<unknown>,
  ): Promise<void> => {
    try {
      await task;
    } catch (error) {
      // error-policy:J5 the provider model handler already records its
      // diagnostic. Re-throw only a fixed lane identifier so the loopback
      // control plane never exposes provider payloads.
      // A provider that successfully returns zero output still completed the
      // transport/admission warmup. Every other failure remains visible to the
      // local gateway, whose real turn keeps its normal typed retry/fallback.
      if (!(error instanceof Error && error.name === "AI_NoOutputGeneratedError")) {
        throw new CloudTextPrewarmError(lane, error);
      }
    }
  };

  const warmLane = (
    lane: CloudTextPrewarmLane,
    runtime: Pick<IAgentRuntime, "useModel">,
  ): Promise<void> => {
    if (now() - lastWarmedAt[lane] < cooldownMs) return Promise.resolve();
    if (inFlight[lane]) return inFlight[lane];

    const task =
      lane === "response-handler"
        ? runtime.useModel(ModelType.RESPONSE_HANDLER, {
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
                { kind: "literal" as const, value: '{"replyText":' },
                { kind: "free-string" as const, key: "replyText" },
                { kind: "literal" as const, value: "}" },
              ],
            },
            tools: [
              {
                name: "HANDLE_RESPONSE",
                type: "function" as const,
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
            providerOptions: { eliza: { thinking: "off" } },
          })
        : runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: "Reply with exactly one word: ready.",
            maxTokens: 32,
            temperature: 0,
            stream: true,
            streamCommittedReply: true,
            streamSecurity: "required",
            voiceOutput: "internal",
            onStreamChunk: async () => undefined,
            providerOptions: { eliza: { thinking: "off" } },
          });

    const pending = acceptNoOutput(lane, task)
      .then(() => {
        lastWarmedAt[lane] = now();
      })
      .finally(() => {
        inFlight[lane] = null;
      });
    inFlight[lane] = pending;
    return pending;
  };

  return async (
    runtime: Pick<IAgentRuntime, "useModel">,
  ): Promise<CloudTextPrewarmResult> => {
    const lanes: CloudTextPrewarmLane[] = [
      "response-handler",
      "committed-reply",
    ];
    const alreadyWarm = lanes.every(
      (lane) => now() - lastWarmedAt[lane] < cooldownMs,
    );
    if (alreadyWarm) return "already-warm";

    // Voice turns use two independently routed Cloud streaming models:
    // RESPONSE_HANDLER for the private structured participation gate, then
    // TEXT_LARGE for committed user-visible prose. Their admission caches can
    // warm independently, so preserve a successful lane even when its sibling
    // still returns a cold-gateway 503. The next probe then pays only for the
    // lane that is actually cold instead of throwing away successful work.
    await Promise.all(lanes.map((lane) => warmLane(lane, runtime)));
    return "warmed";
  };
}

export const prewarmCloudTextGateway = createCloudTextPrewarmer();
