/**
 * PLACE_CALL action — agent-initiated phone call placement.
 *
 * Delegates to `@elizaos/capacitor-phone`'s `placeCall` method. Android-only;
 * any other platform's web fallback rejects, which surfaces as a failed action
 * rather than a silent no-op.
 *
 * Session gating is applied by the agent Android runtime adapter, so this
 * action only validates while the Phone overlay app is the active session
 * once registered in the mobile runtime.
 */

import { Phone } from "@elizaos/capacitor-phone";
import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

interface PlaceCallParams {
  phoneNumber?: string;
}

const PLACE_CALL_CONTEXTS = ["phone", "contacts", "messaging"] as const;
const PLACE_CALL_KEYWORDS = [
  "call",
  "dial",
  "phone",
  "ring",
  "llamar",
  "marcar",
  "teléfono",
  "appeler",
  "composer",
  "téléphone",
  "anrufen",
  "telefon",
  "ligar",
  "telefone",
  "chiamare",
  "telefono",
  "電話",
  "発信",
  "拨打",
  "电话",
  "전화",
  "통화",
] as const;

/** Strip whitespace and visual separators while keeping leading + and digits. */
function normalizeNumber(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const leadingPlus = trimmed.startsWith("+") ? "+" : "";
  return `${leadingPlus}${trimmed.replace(/[^0-9]/g, "")}`;
}

function hasSelectedContext(state: State | undefined): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  const contextObject = (state?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return PLACE_CALL_CONTEXTS.some((context) => selected.has(context));
}

function hasPlaceCallIntent(
  message: Memory,
  state: State | undefined,
): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  return PLACE_CALL_KEYWORDS.some((keyword) =>
    text.includes(keyword.toLowerCase()),
  );
}

export const placeCallAction: Action = {
  name: "PLACE_CALL",
  contexts: [...PLACE_CALL_CONTEXTS],
  contextGate: { anyOf: [...PLACE_CALL_CONTEXTS] },
  roleGate: { minRole: "USER" },
  similes: ["CALL", "DIAL", "RING", "PHONE_CALL", "MAKE_CALL"],
  description:
    "Place a phone call to a given number using the Android Telecom service. " +
    "Requires the Phone app session to be active and the host device to have " +
    "granted the CALL_PHONE runtime permission. The number is dialled directly " +
    "via TelecomManager.placeCall — there is no confirmation step. Pass an " +
    "E.164 or local number string in `phoneNumber`.",
  descriptionCompressed:
    "Place a phone call via Android Telecom. Requires CALL_PHONE permission.",

  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) => {
    return hasSelectedContext(state) || hasPlaceCallIntent(message, state);
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
