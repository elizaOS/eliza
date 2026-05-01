/**
 * PLACE_CALL action — agent-initiated phone call placement.
 *
 * Delegates to `@elizaos/capacitor-phone`'s `placeCall` method. Android-only;
 * any other platform's web fallback rejects, which surfaces as a failed action
 * rather than a silent no-op.
 *
 * Session gating is applied at the plugin level via
 * `gatePluginSessionForHostedApp`, so this action only validates while the
 * Phone overlay app is the active session.
 */

import { hasRoleAccess } from "@elizaos/agent";
import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { Phone } from "@elizaos/capacitor-phone";

interface PlaceCallParams {
  phoneNumber?: string;
}

/** Strip whitespace and visual separators while keeping leading + and digits. */
function normalizeNumber(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const leadingPlus = trimmed.startsWith("+") ? "+" : "";
  return `${leadingPlus}${trimmed.replace(/[^0-9]/g, "")}`;
}

export const placeCallAction: Action = {
  name: "PLACE_CALL",
  similes: ["CALL", "DIAL", "RING", "PHONE_CALL", "MAKE_CALL"],
  description:
    "Place a phone call to a given number using the Android Telecom service. " +
    "Requires the Phone app session to be active and the host device to have " +
    "granted the CALL_PHONE runtime permission. The number is dialled directly " +
    "via TelecomManager.placeCall — there is no confirmation step. Pass an " +
    "E.164 or local number string in `phoneNumber`.",
  descriptionCompressed:
    "Place a phone call via Android Telecom. Requires CALL_PHONE permission.",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    if (!(await hasRoleAccess(runtime, message, "USER"))) return false;
    return true;
  },

  handler: async (_runtime, _message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | PlaceCallParams
      | undefined;
    const raw = params?.phoneNumber;
    if (typeof raw !== "string") {
      return { text: "phoneNumber is required", success: false };
    }
    const number = normalizeNumber(raw);
    if (!number) {
      return { text: "phoneNumber is required", success: false };
    }

    await Phone.placeCall({ number });

    return {
      text: `Calling ${number}.`,
      success: true,
      data: { phoneNumber: number },
    };
  },

  parameters: [
    {
      name: "phoneNumber",
      description:
        "Phone number to call. Accepts E.164 (`+15551234567`) or local " +
        "formats; non-digit separators (spaces, dashes, parentheses) are " +
        "stripped before dialling.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};
