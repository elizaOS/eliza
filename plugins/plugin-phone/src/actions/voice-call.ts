import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

/**
 * VOICE_CALL umbrella action — outbound voice-call dispatch.
 *
 * MIGRATION STATUS: STUB.
 * TODO(migrate: plugins/plugin-lifeops/src/actions/voice-call.ts)
 *
 * The full implementation (Twilio voice dispatch, owner-escalation routing,
 * external recipient allow-list, draft/confirm + approval-queue flow, standing
 * policy acknowledgement) will be ported here in a follow-up pass. For now
 * this file exists so the plugin registers cleanly and the runtime knows the
 * contract. Each sub-op has a TODO pointing to the lifeops source it should
 * absorb behavior from.
 */

const ACTION_NAME = "VOICE_CALL";
const FAILURE_TEXT_PREFIX = `[${ACTION_NAME}]`;

const VOICE_CALL_SUBACTIONS = ["dial"] as const;
type VoiceCallSubaction = (typeof VOICE_CALL_SUBACTIONS)[number];

const RECIPIENT_KINDS = ["owner", "external", "e164"] as const;

function failure(reason: string, message: string): ActionResult {
  const text = `${FAILURE_TEXT_PREFIX} ${reason}: ${message}`;
  return { success: false, text, error: new Error(text) };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

interface VoiceCallActionParameters {
  op?: unknown;
  action?: unknown;
  recipientKind?: unknown;
  phoneNumber?: unknown;
  recipient?: unknown;
  bodyText?: unknown;
  confirmed?: unknown;
  reason?: unknown;
}

export const voiceCallAction: Action = {
  name: ACTION_NAME,
  similes: ["CALL_USER", "CALL_EXTERNAL", "PLACE_VOICE_CALL", "DIAL"],
  description:
    "Outbound voice call dispatch (Twilio-backed). Sub-op 'dial' routes by " +
    "recipientKind: owner (env-resolved owner number with standing-policy " +
    "acknowledgement), external (name-resolved third party + allow-list " +
    "check), or e164 (raw E.164 phoneNumber). Draft-first; confirmed:true to " +
    "dispatch through the approval queue.",
  contexts: ["communication", "messaging", "calls", "phone"],
  parameters: [
    {
      name: "op",
      description: "Which voice-call sub-operation to run.",
      required: true,
      schema: { type: "string", enum: [...VOICE_CALL_SUBACTIONS] },
    },
    {
      name: "recipientKind",
      description:
        "Recipient discriminator: owner | external | e164. Drives routing inside 'dial'.",
      schema: { type: "string", enum: [...RECIPIENT_KINDS] },
    },
    {
      name: "phoneNumber",
      description:
        "Resolved E.164 phone number. Required for recipientKind=e164.",
      schema: { type: "string" },
    },
    {
      name: "recipient",
      description:
        "Contact name or E.164 used for recipientKind=external lookup.",
      schema: { type: "string" },
    },
    {
      name: "bodyText",
      description: "Spoken text to deliver on the call.",
      schema: { type: "string" },
    },
    {
      name: "confirmed",
      description: "Set true to dispatch the previously drafted call.",
      schema: { type: "boolean" },
    },
    {
      name: "reason",
      description: "Free-text rationale surfaced in approval UI.",
      schema: { type: "string" },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // TODO(migrate: plugins/plugin-lifeops/src/actions/voice-call.ts) — port
    // validation (env owner-number presence, allow-list checks, etc.). For
    // now we accept whenever the planner asks; the handler returns a
    // not-implemented failure so callers see exactly which op is missing.
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options ?? {}) as VoiceCallActionParameters;
    const op = readString(params.op) ?? readString(params.action) ?? "dial";

    const known = VOICE_CALL_SUBACTIONS as readonly string[];
    if (!known.includes(op)) {
      return failure("unknown_op", `Unsupported op '${op}'.`);
    }

    switch (op as VoiceCallSubaction) {
      case "dial":
        // TODO(migrate: plugins/plugin-lifeops/src/actions/voice-call.ts) —
        // port Twilio dispatch (readTwilioCredentialsFromEnv +
        // sendTwilioVoiceCall), owner / external / e164 routing branches,
        // pending-call draft store, and approval-queue handoff.
        return failure("scaffold_stub", "VOICE_CALL.dial is not migrated yet.");
      default:
        return failure("unknown_op", `Unsupported op '${op}'.`);
    }
  },
  examples: [],
};

export default voiceCallAction;
