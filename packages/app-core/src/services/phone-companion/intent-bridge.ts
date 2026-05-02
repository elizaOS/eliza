import {
  ElizaIntent,
  type ReceiveIntentPayload,
  type ReceiveIntentResult,
} from "./eliza-intent";
import { logger } from "./logger";

/**
 * Intent bridge — single entry point used by UI layers to forward an
 * agent-issued device-bus intent (see plan §6.24) to the native plugin.
 *
 * This is a thin wrapper, not an abstraction layer. It exists so that
 * when push payloads land (T9c) there is one place to attach decoding +
 * authentication rather than scattering `ElizaIntent.receiveIntent` calls.
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
