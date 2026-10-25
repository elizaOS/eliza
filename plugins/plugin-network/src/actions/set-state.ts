/**
 * SET_STATE: change the member's availability state (open, busy, traveling,
 * paused). Member identity comes from host authority, never from parameters.
 * Writes are idempotent per (app, member, message, ordinal) and return an effect
 * receipt so the shared runtime's reply-grounding review can bind the confirmation.
 * The planner only proposes: the handler runs the same deterministic authz as the
 * structured route (audit plugin-prototypes-1), against the member's own message.
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
import { authorizeSetState, sanitize } from "../routing/authz.js";
import { clarificationFor } from "../routing/structured-field.js";
import {
  NETWORK_CONTEXTS,
  NETWORK_MEMBER_STATES,
  type NetworkMemberState,
  type NetworkStore,
  type NetworkTurnAuthority,
  setStateIdempotencyKey,
} from "../types.js";

export interface SetStateActionOptions {
  store: NetworkStore;
  authority: NetworkTurnAuthority;
  roleGate?: Action["roleGate"];
  now?: () => Date;
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
  authority: NetworkTurnAuthority,
  message: Memory,
  options: HandlerOptions | undefined,
): string | null {
  const content = message.content as Record<string, unknown> | undefined;
  const marker = content?.chatIdempotency as
    | Record<string, unknown>
    | undefined;
  const origin =
    (typeof marker?.clientMessageId === "string" && marker.clientMessageId) ||
    (typeof message.id === "string" && message.id) ||
    null;
  if (!origin) return null;
  const ordinal =
    options?.actionContext?.previousResults.filter(
      (r) => r.data?.actionName === "SET_STATE",
    ).length ?? 0;
  return setStateIdempotencyKey(authority, origin, ordinal);
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
    similes: [
      "SET_AVAILABILITY",
      "PAUSE_NETWORK",
      "MARK_BUSY",
      "MARK_TRAVELING",
    ],
    parameters: [
      {
        name: "state",
        description: "open | busy | traveling | paused",
        required: true,
        schema: { type: "string" as const, enum: [...NETWORK_MEMBER_STATES] },
      },
      {
        name: "from",
        description:
          "Optional ISO-8601 date when the state starts, for plans that start later.",
        required: false,
        schema: { type: "string" as const },
      },
      {
        name: "until",
        description: "Optional ISO-8601 date/time when the state ends.",
        required: false,
        schema: { type: "string" as const },
      },
      {
        name: "evidence",
        description:
          "Exact quote from the member's own message that asks for this change.",
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
      const params = (handlerOptions?.parameters ?? {}) as Record<
        string,
        unknown
      >;
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
      const from = readIsoDate(params.from);
      if (from === "invalid") {
        return failure("invalid_param", "from must be an ISO-8601 date");
      }
      const note =
        typeof params.note === "string" && params.note.trim()
          ? params.note.trim()
          : null;
      if (note && note.length > 280) {
        return failure("invalid_param", "note must not exceed 280 characters");
      }
      // Same authz as the structured route: the member's own words must ask for this state, and
      // dates must be theirs and not in the past. Without an evidence quote, the whole message is it.
      const memberText = sanitize(String(message.content?.text ?? ""));
      const evidence =
        typeof params.evidence === "string" && params.evidence.trim()
          ? params.evidence
          : memberText;
      const decision = authorizeSetState(
        { state: params.state, from, until, evidence },
        memberText,
        (options.now ?? (() => new Date()))(),
        { timeZone: options.authority.timeZone },
      );
      if (!decision.allowed) {
        return {
          ...failure(
            "not_authorized",
            clarificationFor(decision.reason, params.state),
          ),
          continueChain: false,
        };
      }
      const idempotencyKey = idempotencyKeyFor(
        options.authority,
        message,
        handlerOptions,
      );
      if (!idempotencyKey) {
        return {
          ...failure("missing_idempotency", "message has no stable id"),
          continueChain: false,
        };
      }
      const exec = await options.store.setState({
        memberId: options.authority.memberId,
        state: decision.state,
        from: decision.from,
        until: decision.until,
        note,
        idempotencyKey,
      });
      if (!exec.unchanged && !exec.replayed && !exec.eventId) {
        return failure(
          "missing_commit_receipt",
          "Network state commit has no event receipt",
        );
      }
      const observedAt = exec.committedAt.toISOString();
      const receiptId = `network:state:${exec.eventId ?? `noop:${idempotencyKey}`}`;
      const resource = {
        kind: "network.member_state",
        id: options.authority.memberId,
      };
      const receipt: EffectReceipt = exec.unchanged
        ? {
            receiptId,
            operation: "network.set_state",
            resource,
            artifacts: [],
            idempotency: { key: idempotencyKey, replayed: exec.replayed },
            observedAt,
            outcome: "noop",
            reason:
              "Member was already in the requested state; no event written",
          }
        : exec.replayed
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
              commit: {
                kind: "durable",
                id: exec.eventId as string,
                committedAt: observedAt,
              },
            };
      return {
        success: true,
        text: exec.unchanged
          ? `Network state unchanged: already ${exec.current}${exec.until ? ` until ${exec.until}` : ""}.`
          : `Network state is now ${exec.current}${exec.until ? ` until ${exec.until}` : ""} (was ${exec.previous}).`,
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
