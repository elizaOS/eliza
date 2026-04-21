import { logger } from "./logger";
import {
  MiladyIntent,
  type ReceiveIntentPayload,
  type ReceiveIntentResult,
} from "./milady-intent";

/**
 * Intent bridge — single entry point used by UI layers to forward an
 * agent-issued device-bus intent (see plan §6.24) to the native plugin.
 *
 * This is a thin wrapper, not an abstraction layer. It exists so that
 * when push payloads land (T9c) there is one place to attach decoding +
 * authentication rather than scattering `MiladyIntent.receiveIntent` calls.
 */
export async function forwardIntent(
  payload: ReceiveIntentPayload,
): Promise<ReceiveIntentResult> {
  logger.debug("[IntentBridge] forward", {
    kind: payload.kind,
    issuedAtIso: payload.issuedAtIso,
  });
  return MiladyIntent.receiveIntent(payload);
}
