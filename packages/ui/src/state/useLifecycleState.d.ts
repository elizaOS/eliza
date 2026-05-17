/**
 * Lifecycle & startup state — consolidated via useReducer.
 *
 * Replaces 20+ individual useState hooks from AppContext with a single
 * reducer + dispatch, cutting hook count and making state transitions explicit.
 */
import type { AgentStatus } from "../api";
import type { ActionNotice, AppState, LifecycleAction, StartupErrorState, StartupPhase } from "./types";
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
type LifecycleAction_ = {
    type: "SET_CONNECTED";
    value: boolean;
} | {
    type: "SET_AGENT_STATUS";
    value: AgentStatus | null;
} | {
    type: "SET_ONBOARDING_COMPLETE";
    value: boolean;
} | {
    type: "INCREMENT_ONBOARDING_REVEAL_NONCE";
} | {
    type: "SET_ONBOARDING_LOADING";
    value: boolean;
} | {
    type: "SET_STARTUP_PHASE";
    value: StartupPhase;
} | {
    type: "SET_STARTUP_ERROR";
    value: StartupErrorState | null;
} | {
    type: "RETRY_STARTUP";
} | {
    type: "SET_AUTH_REQUIRED";
    value: boolean;
} | {
    type: "SET_ACTION_NOTICE";
    value: ActionNotice | null;
} | {
    type: "BEGIN_LIFECYCLE";
    action: LifecycleAction;
} | {
    type: "FINISH_LIFECYCLE";
} | {
    type: "SET_PENDING_RESTART";
    pending: boolean;
    reasons?: string[];
} | {
    type: "DISMISS_RESTART_BANNER";
} | {
    type: "SHOW_RESTART_BANNER";
} | {
    type: "SET_BACKEND_CONNECTION";
    value: Partial<AppState["backendConnection"]>;
} | {
    type: "DISMISS_BACKEND_BANNER";
} | {
    type: "RESET_BACKEND_CONNECTION";
} | {
    type: "ADD_SYSTEM_WARNING";
    warning: string;
} | {
    type: "DISMISS_SYSTEM_WARNING";
    message: string;
} | {
    type: "SET_SYSTEM_WARNINGS";
    value: string[];
};
export interface LifecycleStateHook {
    /** The consolidated lifecycle state. */
    state: LifecycleState;
    /** Dispatch an action to the lifecycle reducer. */
    dispatch: React.Dispatch<LifecycleAction_>;
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
    setActionNotice: (text: string, tone?: "info" | "success" | "error", ttlMs?: number, once?: boolean, busy?: boolean) => void;
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
    lifecycleBusyRef: React.RefObject<boolean>;
    lifecycleActionRef: React.RefObject<LifecycleAction | null>;
    agentStatusRef: React.RefObject<AgentStatus | null>;
}
export declare function useLifecycleState(): LifecycleStateHook;
export type { LifecycleAction_ as LifecycleDispatchAction };
//# sourceMappingURL=useLifecycleState.d.ts.map