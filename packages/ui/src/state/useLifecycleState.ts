/**
 * Lifecycle & startup state — consolidated via useReducer.
 *
 * Replaces 20+ individual useState hooks from AppContext with a single
 * reducer + dispatch, cutting hook count and making state transitions explicit.
 */

import { useCallback, useMemo, useReducer, useRef } from "react";
import type { AgentStatus } from "../api";
import {
  loadPersistedOnboardingComplete,
  savePersistedOnboardingComplete,
} from "./persistence";
import type {
  ActionNotice,
  AppState,
  LifecycleAction,
  StartupErrorState,
  StartupPhase,
} from "./types";

// ── State shape ────────────────────────────────────────────────────────

export interface LifecycleState {
  connected: boolean;
  agentStatus: AgentStatus | null;
  onboardingComplete: boolean;
  onboardingUiRevealNonce: number;
  onboardingLoading: boolean;
  startupPhase: StartupPhase;
  startupError: StartupErrorState | null;
  startupRetryNonce: number;
  authRequired: boolean;
  actionNotice: ActionNotice | null;
  lifecycleBusy: boolean;
  lifecycleAction: LifecycleAction | null;
  pendingRestart: boolean;
  pendingRestartReasons: string[];
  restartBannerDismissed: boolean;
  backendConnection: AppState["backendConnection"];
  backendDisconnectedBannerDismissed: boolean;
  systemWarnings: string[];
}

const INITIAL_LIFECYCLE_STATE: LifecycleState = {
  connected: false,
  agentStatus: null,
  onboardingComplete: loadPersistedOnboardingComplete(),
  onboardingUiRevealNonce: 0,
  onboardingLoading: true,
  startupPhase: "starting-backend",
  startupError: null,
  startupRetryNonce: 0,
  authRequired: false,
  actionNotice: null,
  lifecycleBusy: false,
  lifecycleAction: null,
  pendingRestart: false,
  pendingRestartReasons: [],
  restartBannerDismissed: false,
  backendConnection: {
    state: "disconnected",
    reconnectAttempt: 0,
    maxReconnectAttempts: 15,
    showDisconnectedUI: false,
  },
  backendDisconnectedBannerDismissed: false,
  systemWarnings: [],
};

// ── Actions ────────────────────────────────────────────────────────────

type LifecycleAction_ =
  | { type: "SET_CONNECTED"; value: boolean }
  | { type: "SET_AGENT_STATUS"; value: AgentStatus | null }
  | { type: "SET_ONBOARDING_COMPLETE"; value: boolean }
  | { type: "INCREMENT_ONBOARDING_REVEAL_NONCE" }
  | { type: "SET_ONBOARDING_LOADING"; value: boolean }
  | { type: "SET_STARTUP_PHASE"; value: StartupPhase }
  | { type: "SET_STARTUP_ERROR"; value: StartupErrorState | null }
  | { type: "RETRY_STARTUP" }
  | { type: "SET_AUTH_REQUIRED"; value: boolean }
  | { type: "SET_ACTION_NOTICE"; value: ActionNotice | null }
  | { type: "BEGIN_LIFECYCLE"; action: LifecycleAction }
  | { type: "FINISH_LIFECYCLE" }
  | { type: "SET_PENDING_RESTART"; pending: boolean; reasons?: string[] }
  | { type: "DISMISS_RESTART_BANNER" }
  | { type: "SHOW_RESTART_BANNER" }
  | {
      type: "SET_BACKEND_CONNECTION";
      value: Partial<AppState["backendConnection"]>;
    }
  | { type: "DISMISS_BACKEND_BANNER" }
  | { type: "RESET_BACKEND_CONNECTION" }
  | { type: "ADD_SYSTEM_WARNING"; warning: string }
  | { type: "DISMISS_SYSTEM_WARNING"; message: string }
  | { type: "SET_SYSTEM_WARNINGS"; value: string[] };

function lifecycleReducer(
  state: LifecycleState,
  action: LifecycleAction_,
): LifecycleState {
  switch (action.type) {
    case "SET_CONNECTED":
      return { ...state, connected: action.value };
    case "SET_AGENT_STATUS":
      return { ...state, agentStatus: action.value };
    case "SET_ONBOARDING_COMPLETE":
      return { ...state, onboardingComplete: action.value };
    case "INCREMENT_ONBOARDING_REVEAL_NONCE":
      return {
        ...state,
        onboardingUiRevealNonce: state.onboardingUiRevealNonce + 1,
      };
    case "SET_ONBOARDING_LOADING":
      return { ...state, onboardingLoading: action.value };
    case "SET_STARTUP_PHASE":
      return { ...state, startupPhase: action.value };
    case "SET_STARTUP_ERROR":
      return { ...state, startupError: action.value };
    case "RETRY_STARTUP":
      return {
        ...state,
        startupError: null,
        authRequired: false,
        onboardingLoading: true,
        startupPhase: "starting-backend",
        startupRetryNonce: state.startupRetryNonce + 1,
      };
    case "SET_AUTH_REQUIRED":
      return { ...state, authRequired: action.value };
    case "SET_ACTION_NOTICE":
      return { ...state, actionNotice: action.value };
    case "BEGIN_LIFECYCLE":
      return {
        ...state,
        lifecycleBusy: true,
        lifecycleAction: action.action,
      };
    case "FINISH_LIFECYCLE":
      return { ...state, lifecycleBusy: false, lifecycleAction: null };
    case "SET_PENDING_RESTART":
      return {
        ...state,
        pendingRestart: action.pending,
        pendingRestartReasons:
          action.reasons ?? (action.pending ? state.pendingRestartReasons : []),
      };
    case "DISMISS_RESTART_BANNER":
      return { ...state, restartBannerDismissed: true };
    case "SHOW_RESTART_BANNER":
      return { ...state, restartBannerDismissed: false };
    case "SET_BACKEND_CONNECTION":
      return {
        ...state,
        backendConnection: { ...state.backendConnection, ...action.value },
        backendDisconnectedBannerDismissed:
          action.value.state === "failed"
            ? state.backendDisconnectedBannerDismissed
            : false,
      };
    case "DISMISS_BACKEND_BANNER":
      return { ...state, backendDisconnectedBannerDismissed: true };
    case "RESET_BACKEND_CONNECTION":
      return {
        ...state,
        backendConnection: {
          ...state.backendConnection,
          state: "disconnected",
          reconnectAttempt: 0,
          showDisconnectedUI: false,
        },
        backendDisconnectedBannerDismissed: false,
      };
    case "ADD_SYSTEM_WARNING": {
      if (state.systemWarnings.includes(action.warning)) return state;
      return {
        ...state,
        systemWarnings: [...state.systemWarnings, action.warning].slice(-50),
      };
    }
    case "DISMISS_SYSTEM_WARNING":
      return {
        ...state,
        systemWarnings: state.systemWarnings.filter(
          (m) => m !== action.message,
        ),
      };
    case "SET_SYSTEM_WARNINGS":
      return { ...state, systemWarnings: action.value };
    default:
      return state;
  }
}

// ── Hook ───────────────────────────────────────────────────────────────

export interface LifecycleStateHook {
  /** The consolidated lifecycle state. */
  state: LifecycleState;
  /** Dispatch an action to the lifecycle reducer. */
  dispatch: React.Dispatch<LifecycleAction_>;

  // ── Convenience setters (thin wrappers around dispatch) ──
  setConnected: (v: boolean) => void;
  setAgentStatus: (v: AgentStatus | null) => void;
  /** Only calls setAgentStatus when the payload has materially changed. */
  setAgentStatusIfChanged: (next: AgentStatus | null) => void;
  setOnboardingComplete: (v: boolean) => void;
  incrementOnboardingRevealNonce: () => void;
  setOnboardingLoading: (v: boolean) => void;
  setStartupPhase: (v: StartupPhase) => void;
  setStartupError: (v: StartupErrorState | null) => void;
  retryStartup: () => void;
  setAuthRequired: (v: boolean) => void;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;
  beginLifecycleAction: (action: LifecycleAction) => boolean;
  finishLifecycleAction: () => void;
  setPendingRestart: (pending: boolean, reasons?: string[]) => void;
  dismissRestartBanner: () => void;
  showRestartBanner: () => void;
  setBackendConnection: (v: Partial<AppState["backendConnection"]>) => void;
  dismissBackendBanner: () => void;
  resetBackendConnection: () => void;
  addSystemWarning: (warning: string) => void;
  dismissSystemWarning: (message: string) => void;
  setSystemWarnings: (v: string[]) => void;

  /** Derived startup status. */
  startupStatus: AppState["startupStatus"];

  // Refs for synchronous checks
  lifecycleBusyRef: React.RefObject<boolean>;
  lifecycleActionRef: React.RefObject<LifecycleAction | null>;
  agentStatusRef: React.RefObject<AgentStatus | null>;
}

export function useLifecycleState(): LifecycleStateHook {
  const [state, dispatch] = useReducer(
    lifecycleReducer,
    INITIAL_LIFECYCLE_STATE,
  );

  // Refs for synchronous checks (used by lifecycle actions to avoid race conditions)
  const lifecycleBusyRef = useRef(false);
  const lifecycleActionRef = useRef<LifecycleAction | null>(null);
  const agentStatusRef = useRef<AgentStatus | null>(null);
  const actionNoticeTimer = useRef<number | null>(null);
  const shownOnceNotices = useRef<Set<string>>(new Set());

  // ── Convenience setters ──

  const setConnected = useCallback(
    (v: boolean) => dispatch({ type: "SET_CONNECTED", value: v }),
    [],
  );
  const setAgentStatus = useCallback((v: AgentStatus | null) => {
    agentStatusRef.current = v;
    dispatch({ type: "SET_AGENT_STATUS", value: v });
  }, []);

  const setAgentStatusIfChanged = useCallback((next: AgentStatus | null) => {
    const prev = agentStatusRef.current;
    if (
      prev &&
      next &&
      prev.state === next.state &&
      prev.agentName === next.agentName &&
      prev.model === next.model &&
      prev.startedAt === next.startedAt
    ) {
      return;
    }
    agentStatusRef.current = next;
    dispatch({ type: "SET_AGENT_STATUS", value: next });
  }, []);

  const setOnboardingComplete = useCallback((v: boolean) => {
    savePersistedOnboardingComplete(v);
    dispatch({ type: "SET_ONBOARDING_COMPLETE", value: v });
  }, []);
  const incrementOnboardingRevealNonce = useCallback(
    () => dispatch({ type: "INCREMENT_ONBOARDING_REVEAL_NONCE" }),
    [],
  );
  const setOnboardingLoading = useCallback(
    (v: boolean) => dispatch({ type: "SET_ONBOARDING_LOADING", value: v }),
    [],
  );
  const setStartupPhase = useCallback(
    (v: StartupPhase) => dispatch({ type: "SET_STARTUP_PHASE", value: v }),
    [],
  );
  const setStartupError = useCallback(
    (v: StartupErrorState | null) =>
      dispatch({ type: "SET_STARTUP_ERROR", value: v }),
    [],
  );
  const retryStartup = useCallback(
    () => dispatch({ type: "RETRY_STARTUP" }),
    [],
  );
  const setAuthRequired = useCallback(
    (v: boolean) => dispatch({ type: "SET_AUTH_REQUIRED", value: v }),
    [],
  );

  const setActionNotice = useCallback(
    (
      text: string,
      tone: "info" | "success" | "error" = "info",
      ttlMs = 2800,
      once = false,
      busy = false,
    ) => {
      if (once && shownOnceNotices.current.has(text)) return;
      if (once) shownOnceNotices.current.add(text);
      dispatch({
        type: "SET_ACTION_NOTICE",
        value: { tone, text, ...(busy ? { busy: true } : {}) },
      });
      if (actionNoticeTimer.current != null) {
        window.clearTimeout(actionNoticeTimer.current);
      }
      actionNoticeTimer.current = window.setTimeout(() => {
        dispatch({ type: "SET_ACTION_NOTICE", value: null });
        actionNoticeTimer.current = null;
      }, ttlMs);
    },
    [],
  );

  const beginLifecycleAction = useCallback(
    (action: LifecycleAction): boolean => {
      if (lifecycleBusyRef.current) return false;
      lifecycleBusyRef.current = true;
      lifecycleActionRef.current = action;
      dispatch({ type: "BEGIN_LIFECYCLE", action });
      return true;
    },
    [],
  );

  const finishLifecycleAction = useCallback(() => {
    lifecycleBusyRef.current = false;
    lifecycleActionRef.current = null;
    dispatch({ type: "FINISH_LIFECYCLE" });
  }, []);

  const setPendingRestart = useCallback(
    (pending: boolean, reasons?: string[]) => {
      dispatch({ type: "SET_PENDING_RESTART", pending, reasons });
    },
    [],
  );

  const dismissRestartBanner = useCallback(
    () => dispatch({ type: "DISMISS_RESTART_BANNER" }),
    [],
  );
  const showRestartBanner = useCallback(
    () => dispatch({ type: "SHOW_RESTART_BANNER" }),
    [],
  );

  const setBackendConnection = useCallback(
    (v: Partial<AppState["backendConnection"]>) => {
      dispatch({ type: "SET_BACKEND_CONNECTION", value: v });
    },
    [],
  );

  const dismissBackendBanner = useCallback(
    () => dispatch({ type: "DISMISS_BACKEND_BANNER" }),
    [],
  );
  const resetBackendConnection = useCallback(
    () => dispatch({ type: "RESET_BACKEND_CONNECTION" }),
    [],
  );

  const addSystemWarning = useCallback((warning: string) => {
    dispatch({ type: "ADD_SYSTEM_WARNING", warning });
  }, []);

  const dismissSystemWarning = useCallback((message: string) => {
    dispatch({ type: "DISMISS_SYSTEM_WARNING", message });
  }, []);

  const setSystemWarnings = useCallback((v: string[]) => {
    dispatch({ type: "SET_SYSTEM_WARNINGS", value: v });
  }, []);

  // ── Derived state ──

  const startupStatus = useMemo<AppState["startupStatus"]>(() => {
    if (state.startupError) return "recoverable-error";
    if (state.authRequired) return "auth-blocked";
    if (state.onboardingLoading || state.startupPhase !== "ready")
      return "loading";
    if (!state.onboardingComplete) return "onboarding";
    return "ready";
  }, [
    state.authRequired,
    state.onboardingComplete,
    state.onboardingLoading,
    state.startupError,
    state.startupPhase,
  ]);

  return {
    state,
    dispatch,
    setConnected,
    setAgentStatus,
    setAgentStatusIfChanged,
    setOnboardingComplete,
    incrementOnboardingRevealNonce,
    setOnboardingLoading,
    setStartupPhase,
    setStartupError,
    retryStartup,
    setAuthRequired,
    setActionNotice,
    beginLifecycleAction,
    finishLifecycleAction,
    setPendingRestart,
    dismissRestartBanner,
    showRestartBanner,
    setBackendConnection,
    dismissBackendBanner,
    resetBackendConnection,
    addSystemWarning,
    dismissSystemWarning,
    setSystemWarnings,
    startupStatus,
    lifecycleBusyRef,
    lifecycleActionRef,
    agentStatusRef,
  };
}

export type { LifecycleAction_ as LifecycleDispatchAction };
