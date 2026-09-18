/** Shape accepted by the Cloud gateway's bounded trace-id validator. */
export const INFERENCE_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Tests whether a value is safe to adopt across an untrusted HTTP boundary.
 *
 * Inference trace ids are intentionally stricter than generic request ids: a
 * lower-case 32-hex value is safe to echo and doubles as a W3C trace-id,
 * while UUIDs, case-folded ids, and arbitrary caller text must be replaced at
 * ingress rather than normalized into a durable correlation key.
 */
export function isInferenceTraceId(value: unknown): value is string {
  return typeof value === "string" && INFERENCE_TRACE_ID_PATTERN.test(value);
}
