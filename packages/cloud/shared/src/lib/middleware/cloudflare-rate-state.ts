import { createHash } from "node:crypto";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";

export interface DurableRateResult {
  allowed: boolean;
  count: number;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

export class RateStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateStateError";
  }
}

export class CloudflareRateState {
  constructor(private readonly namespace: RuntimeDurableObjectNamespace) {}

  async request(key: string, operation: Record<string, unknown>): Promise<DurableRateResult> {
    const shard = createHash("sha256").update(key).digest("hex").slice(0, 2);
    const response = await this.namespace
      .getByName(`rate-v1:${shard}`)
      .fetch("https://rate-state.internal/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...operation, key }),
      });
    if (!response.ok) throw new RateStateError(`Rate state failed (${response.status})`);
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("allowed" in result) ||
      typeof result.allowed !== "boolean" ||
      !("count" in result) ||
      !Number.isSafeInteger(result.count) ||
      !("remaining" in result) ||
      typeof result.remaining !== "number" ||
      result.remaining < 0 ||
      !("resetAt" in result) ||
      !Number.isSafeInteger(result.resetAt)
    ) {
      throw new RateStateError("Invalid rate state response");
    }
    return result as DurableRateResult;
  }
}

/** Explicit selection never falls back to Redis or an isolate-local bucket. */
export function getCloudflareRateState(
  env: { CLOUD_RATE_STATE_BACKEND?: string } = {
    CLOUD_RATE_STATE_BACKEND: getCloudAwareEnv().CLOUD_RATE_STATE_BACKEND,
  },
  namespace = getCloudBinding<RuntimeDurableObjectNamespace>("RATE_LIMIT_STATE"),
): CloudflareRateState | null {
  const backend = env.CLOUD_RATE_STATE_BACKEND ?? "redis";
  if (backend === "redis") return null;
  if (backend !== "cloudflare") throw new RateStateError("Invalid CLOUD_RATE_STATE_BACKEND");
  if (!namespace) throw new RateStateError("RATE_LIMIT_STATE binding is required");
  return new CloudflareRateState(namespace);
}

/** Operator-only binding transfer. Readers must remain fenced until all imports finish. */
export async function importCloudflareRateState(
  namespace: RuntimeDurableObjectNamespace,
  entry: { key: string; expiresAt: number | null } & (
    | { mode: "fixed"; count: number }
    | { mode: "sliding"; events: Array<{ at: number; count: number }> }
  ),
  sourceQuiesced: true,
): Promise<"imported" | "identical" | "expired"> {
  const shard = createHash("sha256").update(entry.key).digest("hex").slice(0, 2);
  const response = await namespace
    .getByName(`rate-v1:${shard}`)
    .fetch("https://rate-state.internal/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...entry, operation: "import", sourceQuiesced }),
    });
  if (!response.ok) throw new RateStateError(`Rate state import rejected (${response.status})`);
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("status" in result) ||
    (result.status !== "imported" && result.status !== "identical" && result.status !== "expired")
  )
    throw new RateStateError("Invalid rate import receipt");
  return result.status;
}
