import { type RefObject, useEffect, useRef } from "react";
import { type ConversationMessage, client } from "../api";
import {
  canonicalPathForPath,
  getWindowNavigationPath,
  isRouteRootPath,
  shouldUseHashNavigation,
  type Tab,
  tabFromPath,
} from "../navigation";
import type { AppState } from "./internal";

function traceGreeting(phase: string, detail?: Record<string, unknown>): void {
  try {
    if (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("elizaos:debug:greeting") === "1"
    ) {
      console.info(`[eliza][greeting] ${phase}`, detail ?? "");
    }
  } catch {
    /* noop */
  }
}

export function useNavigationPathSync({
  tab,
  setTabRaw,
}: {
  tab: Tab;
  setTabRaw: (tab: Tab) => void;
}) {
  useEffect(() => {
    const navPath = getWindowNavigationPath();
    if (isRouteRootPath(navPath)) {
      return;
    }
    const routeTab = tabFromPath(navPath);
    const canonicalPath = canonicalPathForPath(navPath);
    if (canonicalPath && typeof window !== "undefined") {
      if (shouldUseHashNavigation()) {
        window.location.hash = canonicalPath;
      } else {
        window.history.replaceState(
          null,
          "",
          `${canonicalPath}${window.location.search}${window.location.hash}`,
        );
      }
    }
    if (routeTab && routeTab !== tab) {
      setTabRaw(routeTab);
    }
  }, [tab, setTabRaw]);
}

export function useBackendConnectionSync({
  setBackendConnection,
}: {
  setBackendConnection: (value: AppState["backendConnection"]) => void;
}) {
  useEffect(() => {
    const publishConnectionState = (state: {
      state: "connected" | "disconnected" | "reconnecting" | "failed";
      reconnectAttempt: number;
      maxReconnectAttempts: number;
    }) => {
      setBackendConnection({
        state: state.state,
        reconnectAttempt: state.reconnectAttempt,
        maxReconnectAttempts: state.maxReconnectAttempts,
        showDisconnectedUI: state.state === "failed",
      });
    };

    if (typeof client.getConnectionState === "function") {
      publishConnectionState(client.getConnectionState());
    }

    if (typeof client.onConnectionStateChange !== "function") {
      return;
    }

    return client.onConnectionStateChange((state) => {
      publishConnectionState(state);
    });
  }, [setBackendConnection]);
}

export function useAgentGreetingEffects({
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
}) {
  const previousAgentStateRef = useRef<string | null>(null);

  useEffect(() => {
    const current = agentState ?? null;
    const previous = previousAgentStateRef.current;
    previousAgentStateRef.current = current;

    if (current === "running" && previous !== "running") {
      void loadWorkbench();

      if (
        activeConversationId &&
        conversationMessages.length === 0 &&
        !chatSending &&
        !greetingFiredRef.current &&
        greetingInFlightConversationRef.current !== activeConversationId
      ) {
        void fetchGreeting(activeConversationId);
      }
    }
  }, [
    agentState,
    loadWorkbench,
    activeConversationId,
    conversationMessages.length,
    chatSending,
    fetchGreeting,
    greetingFiredRef,
    greetingInFlightConversationRef,
  ]);

  useEffect(() => {
    if (
      !activeConversationId ||
      conversationMessages.length > 0 ||
      agentState !== "running" ||
      chatSending
    ) {
      return;
    }
    if (greetingFiredRef.current) return;
    if (greetingInFlightConversationRef.current === activeConversationId) {
      return;
    }

    const timerId = window.setTimeout(() => {
      if (activeConversationIdRef.current !== activeConversationId) return;
      if (conversationMessagesRef.current.length > 0) return;
      if (greetingFiredRef.current) return;
      if (greetingInFlightConversationRef.current === activeConversationId) {
        return;
      }
      traceGreeting("effect:empty_thread_auto_greet", {
        activeConversationId,
      });
      void fetchGreeting(activeConversationId);
    }, 0);

    return () => window.clearTimeout(timerId);
  }, [
    activeConversationId,
    agentState,
    chatSending,
    conversationMessages.length,
    fetchGreeting,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    greetingInFlightConversationRef,
  ]);
}
