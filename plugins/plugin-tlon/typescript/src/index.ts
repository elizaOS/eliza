import type { Plugin } from "@elizaos/core";
import { SEND_MESSAGE_ACTION, sendMessageAction } from "./actions/sendMessage";
import {
  PLUGIN_DESCRIPTION,
  PLUGIN_NAME,
  TLON_SERVICE_NAME,
} from "./constants";
import { CHAT_STATE_PROVIDER, chatStateProvider } from "./providers/chatState";
import { TlonService } from "./service";

/**
 * Tlon/Urbit plugin for elizaOS
 *
 * Provides integration with Urbit ships via the Tlon messaging protocol.
 * Supports:
 * - Direct messages (DMs)
 * - Group channels
 * - Thread replies
 * - Real-time SSE-based message streaming
 * - Channel authorization
 */
const tlonPlugin: Plugin = {
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  services: [TlonService],
  actions: [sendMessageAction],
  providers: [chatStateProvider],
  tests: [],
};

// Export all public APIs
export {
  TlonService,
  sendMessageAction,
  SEND_MESSAGE_ACTION,
  chatStateProvider,
  CHAT_STATE_PROVIDER,
  TLON_SERVICE_NAME,
};

export * from "./client";
export * from "./environment";
// Export types
export * from "./types";
export * from "./utils";

export default tlonPlugin;
