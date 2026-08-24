/** Builds the durable authority key that fences ambiguous paid call submissions. */

import { createHash } from "node:crypto";

export const TWILIO_CALL_FENCE_EXPIRY = new Date("9999-12-31T23:59:59.999Z");
const TWILIO_CALL_FENCE_SOURCE_PREFIX = "twilio-voice-outbound-fence:";

export function twilioCallFenceKey(
  organizationId: string,
  userId: string,
  destination: string,
): string {
  const digest = createHash("sha256")
    .update(`${organizationId}:${userId}:${destination}`)
    .digest("hex");
  return `twilio-call-fence:${digest}`;
}

/** Binds a shared destination fence to the exact durable outbound call row. */
export function twilioCallFenceSource(callId: string): string {
  return `${TWILIO_CALL_FENCE_SOURCE_PREFIX}${callId}`;
}
