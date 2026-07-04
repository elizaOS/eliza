/**
 * View-bundle `interact` capability handler for the terminal surface. Kept in
 * its own module (not the React component file) so the view bundle can re-export
 * `interact` via ./messages-view-bundle.ts without coupling to JSX.
 */

import { Messages } from "@elizaos/capacitor-messages";
import { System } from "@elizaos/capacitor-system";
import {
  loadMessagesState,
  normalizeMessagesLimit,
} from "./messages-view-helpers.ts";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-list-threads") {
    const state = await loadMessagesState(
      normalizeMessagesLimit(params?.limit),
    );
    return {
      viewType: "tui",
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
  }

  if (capability === "terminal-send-sms") {
    const address =
      typeof params?.address === "string" ? params.address.trim() : "";
    const body = typeof params?.body === "string" ? params.body.trim() : "";
    if (!address) throw new Error("address is required");
    if (!body) throw new Error("body is required");
    await Messages.sendSms({ address, body });
    return { sent: true, address, bodyLength: body.length, viewType: "tui" };
  }

  if (capability === "terminal-request-sms-role") {
    await System.requestRole({ role: "sms" });
    const state = await loadMessagesState(200);
    return {
      requested: true,
      ownsSmsRole: state.ownsSmsRole,
      smsRoleHolder: state.smsRoleHolder,
      viewType: "tui",
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
