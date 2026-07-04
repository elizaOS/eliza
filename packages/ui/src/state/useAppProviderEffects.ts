/**
 * Side-effect wiring for AppProvider: subscribes to the app-shell page
 * registry, syncs navigation to the browser path, and seeds the onboarding
 * greeting. Kept out of the provider body so the render stays declarative.
 */
import { type RefObject, useEffect, useRef, useSyncExternalStore } from "react";
import { type ConversationMessage, client } from "../api";
import {
  getAppShellPageRegistrySnapshot,
  subscribeAppShellPages,
} from "../app-shell-registry";
import {
  getWindowNavigationPath,
  isRouteRootPath,
  type Tab,
  tabFromPath,
} from "../navigation";
import { isNavAllowed } from "../navigation/nav-lock";
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
  // App-shell pages (e.g. `@elizaos/plugin-facewear/register` →
  // `/apps/smartglasses/tui`) register from idle-loaded side-effect modules, so
  // a deep link / refresh can boot before the matching registration exists.
  // `tabFromPath` then falls through to the `apps` catalog, and that
  // misresolution is otherwise sticky because this effect only re-runs on
  // tab/navigation change. Re-running it when the registry version bumps lets a
  // late registration reconcile the active tab to the real page.
  const appShellRegistryVersion = useSyncExternalStore(
    subscribeAppShellPages,
    getAppShellPageRegistrySnapshot,
    getAppShellPageRegistrySnapshot,
  );
  useEffect(() => {
    // `appShellRegistryVersion` is a re-run trigger, not a value read here:
    // `tabFromPath` consults the live registry, so a version bump must re-run
    // this effect to reconcile a deep link that booted before its page landed.
    void appShellRegistryVersion;
    const navPath = getWindowNavigationPath();
    if (isRouteRootPath(navPath)) {
      return;
    }
    const routeTab = tabFromPath(navPath);
    // Respect a guided-flow nav lock: don't let a diverging URL (deep link,
    // browser back) reconcile the tab to a state the tour doesn't allow.
    if (routeTab && routeTab !== tab && isNavAllowed(routeTab)) {
      setTabRaw(routeTab);
    }
  }, [tab, setTabRaw, appShellRegistryVersion]);
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
