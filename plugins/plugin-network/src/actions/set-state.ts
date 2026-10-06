/**
 * SET_STATE: change the member's availability state (open, busy, traveling,
 * paused). Member identity comes from host authority, never from parameters.
 * Writes are idempotent per (message, ordinal) and return an effect receipt so
 * the shared runtime's reply-grounding review can bind the confirmation.
 */
import type {
  Action,
  ActionResult,
  EffectReceipt,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  NETWORK_CONTEXTS,
  NETWORK_MEMBER_STATES,
  type NetworkMemberState,
  type NetworkStore,
  type NetworkTurnAuthority,
} from "../types.js";

export interface SetStateActionOptions {
  store: NetworkStore;
  authority: NetworkTurnAuthority;
  roleGate?: Action["roleGate"];
}

function isState(value: unknown): value is NetworkMemberState {
  return (
    typeof value === "string" &&
    (NETWORK_MEMBER_STATES as readonly string[]).includes(value)
  );
}

function readIsoDate(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return "invalid";
  const t = Date.parse(value);
  return Number.isNaN(t) ? "invalid" : new Date(t).toISOString();
}

function idempotencyKeyFor(
  message: Memory,
  options: HandlerOptions | undefined,
): string | null {
  const content = message.content as Record<string, unknown> | undefined;
  const marker = content?.chatIdempotency as Record<string, unknown> | undefined;
  const origin =
    (typeof marker?.clientMessageId === "string" && marker.clientMessageId) ||
    (typeof message.id === "string" && message.id) ||
    null;
  if (!origin) return null;
  const ordinal =
    options?.actionContext?.previousResults.filter(
      (r) => r.data?.actionName === "SET_STATE",
    ).length ?? 0;
  return `network:set_state:v1:${origin}:${ordinal}`;
}

function failure(code: string, text: string): ActionResult {
  return {
    success: false,
    text: `[Network] ${text}`,
    error: code,
    modelReplyRequired: true,
    data: { actionName: "SET_STATE", code },
  };
}

export function createSetStateAction(options: SetStateActionOptions): Action {
  return {
    name: "SET_STATE",
    description:
      "Set the Network member's availability state: open (wants introductions), busy (hold new introductions), traveling (in another city until a date), paused (stop all Network outreach). Optional `until` ISO date.",
    descriptionCompressed:
      "network availability: state=open|busy|traveling|paused, until?=ISO date",
    routingHint:
      "member says they are busy/away/traveling/want a break/are back -> SET_STATE; opt-out of all texts (STOP) is handled by the gateway, NOT this action",
    contexts: [...NETWORK_CONTEXTS],
    contextGate: { anyOf: [...NETWORK_CONTEXTS] },
    roleGate: options.roleGate ?? { minRole: "GUEST" },
    tags: [
      "domain:network",
      "capability:update",
      "effect:idempotent",
      "effect:receipt-required",
    ],
    similes: ["SET_AVAILABILITY", "PAUSE_NETWORK", "MARK_BUSY", "MARK_TRAVELING"],
    parameters: [
      {
        name: "state",
        description: "open | busy | traveling | paused",
        required: true,
        schema: { type: "string" as const, enum: [...NETWORK_MEMBER_STATES] },
      },
      {
        name: "until",
        description: "Optional ISO-8601 date/time when the state ends.",
        required: false,
        schema: { type: "string" as const },
      },
      {
        name: "note",
        description: "Optional short reason in the member's words.",
        required: false,
        schema: { type: "string" as const },
      },
    ],
    validate: async () => true,
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      handlerOptions?: HandlerOptions,
      _callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const params = (handlerOptions?.parameters ?? {}) as Record<string, unknown>;
      if (!isState(params.state)) {
        return failure(
          "invalid_param",
          `state must be one of ${NETWORK_MEMBER_STATES.join(", ")}`,
        );
      }
      const until = readIsoDate(params.until);
      if (until === "invalid") {
        return failure("invalid_param", "until must be an ISO-8601 date");
      }
      const note =
        typeof params.note === "string" && params.note.trim()
          ? params.note.trim().slice(0, 280)
          : null;
      const idempotencyKey = idempotencyKeyFor(message, handlerOptions);
      if (!idempotencyKey) {
        return { ...failure("missing_idempotency", "message has no stable id"), continueChain: false };
      }
      const exec = await options.store.setState({
        memberId: options.authority.memberId,
        state: params.state,
        until,
        note,
        idempotencyKey,
      });
      const observedAt = exec.committedAt.toISOString();
      const receiptId = `network:state:${exec.eventId}`;
      const resource = { kind: "network.member_state", id: options.authority.memberId };
      const receipt: EffectReceipt = exec.replayed
        ? {
            receiptId,
            operation: "network.set_state",
            resource,
            artifacts: [],
            idempotency: { key: idempotencyKey, replayed: true },
            observedAt,
            outcome: "noop",
            reason: "Reused the previously committed state change",
          }
        : {
            receiptId,
            operation: "network.set_state",
            resource,
            artifacts: [],
            idempotency: { key: idempotencyKey, replayed: false },
            observedAt,
            outcome: "applied",
            commit: { kind: "durable", id: exec.eventId, committedAt: observedAt },
          };
      return {
        success: true,
        text: `Network state is now ${exec.current}${exec.until ? ` until ${exec.until}` : ""} (was ${exec.previous}).`,
        modelReplyRequired: true,
        data: {
          actionName: "SET_STATE",
          previous: exec.previous,
          current: exec.current,
          until: exec.until,
          eventId: exec.eventId,
        },
        effectReceipts: [receipt],
      };
    },
  };
}
