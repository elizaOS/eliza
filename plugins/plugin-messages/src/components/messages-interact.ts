/**
 * Dispatches the Messages view bundle's classified interaction operations.
 * Keeping the exact handler map keyed by the production declaration union
 * makes an undeclared operation or an unimplemented declaration a type error.
 */

import { Messages } from "@elizaos/capacitor-messages";
import { System } from "@elizaos/capacitor-system";
import { ElizaError } from "@elizaos/core";
import type { MessagesViewCapabilityId } from "../view-capabilities.ts";
import { loadMessagesState } from "./messages-view-helpers.ts";

type MessagesCapabilityHandler = (
  params?: Record<string, unknown>,
) => Promise<unknown>;

const COMPLETE_MESSAGES_READ_LIMIT = 500;

const MESSAGES_CAPABILITY_HANDLERS: Record<
  MessagesViewCapabilityId,
  MessagesCapabilityHandler
> = {
  "list-threads": async () => {
    const state = await loadMessagesState(COMPLETE_MESSAGES_READ_LIMIT);
    if (state.messages.length === COMPLETE_MESSAGES_READ_LIMIT) {
      throw new ElizaError(
        "Messages read reached the native bridge boundary; refusing to return a potentially incomplete conversation history.",
        {
          code: "NATIVE_MESSAGES_READ_INCOMPLETE",
          context: { limit: COMPLETE_MESSAGES_READ_LIMIT },
        },
      );
    }
    return {
      threads: state.threads.map((thread) => ({
        id: thread.id,
        address: thread.address,
        messageCount: thread.messages.length,
        unreadCount: thread.unreadCount,
        lastMessage: thread.lastMessage.body,
        lastMessageAt: thread.lastMessage.date,
      })),
      ownsSmsRole: state.ownsSmsRole,
      smsRoleHolder: state.smsRoleHolder,
    };
  },
  "send-sms": async (params) => {
    const address =
      typeof params?.address === "string"
        ? params.address.trim()
        : typeof params?.recipient === "string"
          ? params.recipient.trim()
          : typeof params?.to === "string"
            ? params.to.trim()
            : typeof params?.phoneNumber === "string"
              ? params.phoneNumber.trim()
              : "";
    const body =
      typeof params?.body === "string"
        ? params.body.trim()
        : typeof params?.message === "string"
          ? params.message.trim()
          : typeof params?.text === "string"
            ? params.text.trim()
            : "";
    if (!address) throw new Error("address is required");
    if (!body) throw new Error("body is required");
    await Messages.sendSms({ address, body });
    return { sent: true, address, bodyLength: body.length };
  },
  "request-sms-role": async () => {
    await System.requestRole({ role: "sms" });
    const state = await loadMessagesState(200);
    return {
      requested: true,
      ownsSmsRole: state.ownsSmsRole,
      smsRoleHolder: state.smsRoleHolder,
    };
  },
};

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (!Object.hasOwn(MESSAGES_CAPABILITY_HANDLERS, capability)) {
    throw new Error(`Unsupported capability "${capability}"`);
  }
  return MESSAGES_CAPABILITY_HANDLERS[capability as MessagesViewCapabilityId](
    params,
  );
}
