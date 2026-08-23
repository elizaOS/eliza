/** Builds the durable authority key that fences ambiguous paid call submissions. */

import { createHash } from "node:crypto";

export const TWILIO_CALL_FENCE_EXPIRY = new Date("9999-12-31T23:59:59.999Z");

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
