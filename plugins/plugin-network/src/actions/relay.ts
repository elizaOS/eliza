/**
 * RELAY: the member asks the agent to pass something to a match ("tell Sam I'm running late",
 * "send her my number"). The action sends the member's OWN message to the Network service's
 * /internal/relay, which parses the request, runs the relay classifier (relayItemAsync) and, on a
 * pass, delivers only its own `rendered` wording to the other member. The model chooses at most
 * which active item the message is for; it never supplies the text that is relayed, and member
 * identity comes from host authority. Registered only when the store implements relay.
 */
import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  NETWORK_CONTEXTS,
  type NetworkStore,
  type NetworkTurnAuthority,
} from "../types.js";

export interface RelayActionOptions {
  store: NetworkStore & Required<Pick<NetworkStore, "relay">>;
  authority: NetworkTurnAuthority;
  roleGate?: Action["roleGate"];
}

const MAX_RELAY_TEXT = 2000;

function failure(code: string, text: string): ActionResult {
  return {
    success: false,
    text: `[Network] ${text}`,
    error: code,
    modelReplyRequired: true,
    continueChain: false,
    data: { actionName: "RELAY", code },
  };
}

/** The stable id of the member's inbound message (the service's idempotency key for this turn). */
function originId(message: Memory): string | null {
  const content = message.content as Record<string, unknown> | undefined;
  const marker = content?.chatIdempotency as
    | Record<string, unknown>
    | undefined;
  return (
    (typeof marker?.clientMessageId === "string" && marker.clientMessageId) ||
    (typeof message.id === "string" && message.id) ||
    null
  );
}

export function createRelayAction(options: RelayActionOptions): Action {
  return {
    name: "RELAY",
    description:
      "Pass the member's message, contact or photo to someone they were introduced to through the Network. The Network service checks it and sends its own wording; nothing is sent when it is held or blocked.",
    descriptionCompressed:
      "network: relay member's message to their match, itemId?=active item id",
    routingHint:
      'member asks to tell/ask/send something to their match or introduction ("tell Sam I\'m late", "send her my number") -> RELAY; never for messages to the agent itself',
    contexts: [...NETWORK_CONTEXTS],
    contextGate: { anyOf: [...NETWORK_CONTEXTS] },
    roleGate: options.roleGate ?? { minRole: "GUEST" },
    tags: ["domain:network", "capability:send", "effect:idempotent"],
    similes: ["RELAY_MESSAGE", "TELL_MATCH", "PASS_MESSAGE", "MESSAGE_MATCH"],
    parameters: [
      {
        name: "itemId",
        description:
          "Optional id of the active Network item (introduction or plan) this message is for, exactly as listed in the member context. Omit when unsure.",
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
    ): Promise<ActionResult> => {
      const params = (handlerOptions?.parameters ?? {}) as Record<
        string,
        unknown
      >;
      const text = String(message.content?.text ?? "").trim();
      if (!text) return failure("empty_message", "nothing to relay");
      if (text.length > MAX_RELAY_TEXT)
        return failure(
          "invalid_param",
          `message is longer than ${MAX_RELAY_TEXT} characters`,
        );
      const messageId = originId(message);
      if (!messageId)
        return failure("missing_idempotency", "message has no stable id");
      const itemId =
        typeof params.itemId === "string" && params.itemId.trim()
          ? params.itemId.trim()
          : null;

      const result = await options.store.relay({
        memberId: options.authority.memberId,
        messageId,
        itemId,
        text,
      });

      if (result.decision === "none") {
        return {
          success: false,
          text: "[Network] The member's message did not ask to pass anything on. Ask what they want sent and to whom.",
          error: "no_relay_request",
          modelReplyRequired: true,
          continueChain: false,
          data: { actionName: "RELAY", decision: "none" },
        };
      }
      return {
        success: result.decision === "pass",
        text:
          result.senderNotice ||
          (result.decision === "pass" ? "Passed on." : "That wasn't sent."),
        modelReplyRequired: true,
        continueChain: false,
        data: {
          actionName: "RELAY",
          decision: result.decision,
          delivered: result.delivered,
          replayed: result.replayed,
        },
      };
    },
  };
}
