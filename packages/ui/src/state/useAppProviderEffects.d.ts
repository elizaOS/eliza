import { type RefObject } from "react";
import { type ConversationMessage } from "../api";
import { type Tab } from "../navigation";
import type { AppState } from "./internal";
export declare function useNavigationPathSync({
  tab,
  setTabRaw,
}: {
  tab: Tab;
  setTabRaw: (tab: Tab) => void;
}): void;
export declare function useBackendConnectionSync({
  setBackendConnection,
}: {
  setBackendConnection: (value: AppState["backendConnection"]) => void;
}): void;
export declare function useAgentGreetingEffects({
  agentState,
  loadWorkbench,
  activeConversationId,
  conversationMessages,
  chatSending,
  fetchGreeting,
  activeConversationIdRef,
  conversationMessagesRef,
  greetingFiredRef,
  greetingInFlightConversationRef,
}: {
  agentState: string | null | undefined;
  loadWorkbench: () => Promise<void>;
  activeConversationId: string | null;
  conversationMessages: ConversationMessage[];
  chatSending: boolean;
  fetchGreeting: (conversationId: string) => Promise<boolean>;
  activeConversationIdRef: RefObject<string | null>;
  conversationMessagesRef: RefObject<ConversationMessage[]>;
  greetingFiredRef: RefObject<boolean>;
  greetingInFlightConversationRef: RefObject<string | null>;
}): void;
//# sourceMappingURL=useAppProviderEffects.d.ts.map
