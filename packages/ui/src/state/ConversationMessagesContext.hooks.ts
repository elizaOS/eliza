/**
 * ConversationMessagesContext — isolated context for the active conversation's
 * message list.
 *
 * conversationMessages gets a new array reference on every streamed token while
 * the agent is responding. Keeping it in the giant AppContext value would
 * cascade those per-token updates to every useApp() subscriber (~135 of them:
 * sidebars, settings panels, the companion overlay, etc.). This dedicated
 * context lets only the chat surfaces (ChatView and the shell controller that
 * drives ContinuousChatOverlay) re-render as tokens arrive.
 *
 * The context object + hook live here (not in the sibling AppContext.tsx) so the
 * Provider file stays React Fast Refresh-compatible.
 */

import { createContext, useContext } from "react";
import type { ConversationMessage } from "../api";

export interface ConversationMessagesValue {
  conversationMessages: ConversationMessage[];
}

export const ConversationMessagesCtx = createContext<ConversationMessagesValue>(
  {
    conversationMessages: [],
  },
);

export function useConversationMessages(): ConversationMessagesValue {
  return useContext(ConversationMessagesCtx);
}
