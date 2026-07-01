/**
 * ChatTurnStatusContext — isolated context for the live, server-reported phase
 * of the in-flight assistant turn (the rich status indicator, issue #8813).
 *
 * The server streams additive `{ type: "status" }` SSE events (thinking →
 * streaming / running_action → …) during a turn. They arrive faster than the
 * coarse `chatSending` boolean and carry detail (which action is running) that a
 * boolean can't. Keeping the live status in its own context — like
 * ConversationMessagesContext — means only the chat surfaces re-render as status
 * events land, never the ~135 useApp() subscribers.
 *
 * The provider holds `serverTurnStatus`: the latest server status for the
 * current turn, or null between turns. `useShellController` reads it and folds
 * it together with its client-derived signals (thinking / streaming / speaking /
 * waking) into the single `turnStatus` the overlay renders.
 */

import { createContext, useContext } from "react";
import type { ChatTurnStatus } from "../api";

export interface ChatTurnStatusValue {
  /** Latest server-streamed status for the active turn, or null between turns. */
  serverTurnStatus: ChatTurnStatus | null;
  /** Set the live server status (called from the chat-send SSE `onStatus`),
   *  or clear it (null) when a turn ends. */
  setServerTurnStatus: (status: ChatTurnStatus | null) => void;
}

export const ChatTurnStatusCtx = createContext<ChatTurnStatusValue>({
  serverTurnStatus: null,
  setServerTurnStatus: () => {},
});

export function useChatTurnStatus(): ChatTurnStatusValue {
  return useContext(ChatTurnStatusCtx);
}
