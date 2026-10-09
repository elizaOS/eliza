import {
  ElizaIntent,
  type ReceiveIntentPayload,
  type ReceiveIntentResult,
} from "./eliza-intent";
import { logger } from "./logger";

/**
 * Single entry point UI layers use to forward an agent-issued device-bus intent
 * to the native plugin via `ElizaIntent.receiveIntent`.
 *
 * A thin wrapper, not an abstraction layer: it gives push-payload decoding and
 * authentication one place to live rather than scattering `receiveIntent` calls
 * across the surface.
 */
export async function forwardIntent(
  payload: ReceiveIntentPayload,
): Promise<ReceiveIntentResult> {
  logger.debug("[IntentBridge] forward", {
    kind: payload.kind,
    issuedAtIso: payload.issuedAtIso,
  });
  return ElizaIntent.receiveIntent(payload);
}
