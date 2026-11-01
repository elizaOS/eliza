/** Private policy projection and stable rate-counter identity shared by Worker callers and the organization authority. */
export interface InferenceBudgetPolicy {
  organizationId: string;
  enabled: boolean;
  /** Independent rate-only delegation; never grants authority to spend. */
  rateEnabled?: boolean;
  epoch: string;
  policyGeneration: string;
  validUntil: number;
  rateLimits: {
    completionsRpm: number;
    embeddingsRpm: number;
    standardRpm: number;
    strictRpm: number;
  };
}

export function isInferenceBudgetPolicy(value: unknown): value is InferenceBudgetPolicy {
  if (value === null || typeof value !== "object") return false;
  const p = value as Partial<InferenceBudgetPolicy>;
  return (
    typeof p.organizationId === "string" &&
    p.organizationId.length > 0 &&
    typeof p.enabled === "boolean" &&
    (p.rateEnabled === undefined || typeof p.rateEnabled === "boolean") &&
    typeof p.epoch === "string" &&
    /^(0|[1-9]\d*)$/.test(p.epoch) &&
    typeof p.policyGeneration === "string" &&
    /^(0|[1-9]\d*)$/.test(p.policyGeneration) &&
    Number.isSafeInteger(p.validUntil) &&
    (p.validUntil ?? 0) > 0 &&
    p.rateLimits !== undefined &&
    p.rateLimits !== null &&
    typeof p.rateLimits === "object" &&
    [
      p.rateLimits.completionsRpm,
      p.rateLimits.embeddingsRpm,
      p.rateLimits.standardRpm,
      p.rateLimits.strictRpm,
    ].every((rate) => Number.isSafeInteger(rate) && rate > 0)
  );
}

/** Stable existing counter owner; policy admission must never reset its windows. */
export const INFERENCE_RATE_LIMIT_GATE_PREFIX = "rate-limit:v2:";
