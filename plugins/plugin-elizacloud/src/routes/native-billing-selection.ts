/** Exposes the runtime's exact native inference product selection without granting subscription access. */
import type { NativeApplicationBillingSelection } from "@elizaos/cloud-sdk/app-billing";
import type { IAgentRuntime } from "@elizaos/core";
import { getNativeApplicationSlot } from "../utils/config";

export function nativeBillingSelection(
  runtime: IAgentRuntime | null,
): NativeApplicationBillingSelection {
  if (!runtime) {
    return {
      kind: "unavailable",
      reason: "Start the agent to read its application billing selection.",
    };
  }
  const slotKey = getNativeApplicationSlot(runtime);
  if (slotKey === undefined) return { kind: "unconfigured" };
  if (!/^[a-z][a-z0-9_-]{0,99}$/.test(slotKey)) {
    return {
      kind: "unavailable",
      reason: "The configured application product is invalid. Correct the runtime product selection.",
    };
  }
  return { kind: "configured", slotKey };
}
