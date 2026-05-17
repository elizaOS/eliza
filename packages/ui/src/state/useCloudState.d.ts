/**
 * Eliza Cloud state — extracted from AppContext.
 *
 * Manages:
 * - Cloud connection state (enabled, connected, persisted key, user ID)
 * - Credits state (balance, low/critical thresholds, errors, top-up URL)
 * - Login / disconnect flow (busy flags, error messages, poll timers)
 * - Cloud dashboard view preference
 * - Auth-rejected notice effect
 *
 * Cross-domain dependencies accepted as params:
 * - `setActionNotice`        — from useLifecycleState, used for disconnect / auth notices
 * - `loadWalletConfig`       — from useWalletState, called after successful login
 * - `t`                      — translation function, used for auth-rejected notice key
 *
 * Note: `handleCloudOnboardingFinish` is kept in AppContext (one-liner that calls
 * `submitOnboardingAndComplete`, which is defined later in AppContext's render order).
 */
interface CloudStateParams {
    setActionNotice: (text: string, tone?: "info" | "success" | "error", ttlMs?: number, once?: boolean, busy?: boolean) => void;
    /** From useWalletState — called after successful cloud login to reload wallet. */
    loadWalletConfig: () => Promise<void>;
    /** Translation function — used for the auth-rejected notice. */
    t: (key: string) => string;
    /** Product/runtime policy can lock cloud auth on, hiding disconnect affordances. */
    disconnectLocked?: boolean;
}
export declare function useCloudState({ setActionNotice, loadWalletConfig, t, disconnectLocked, }: CloudStateParams): {
    elizaCloudEnabled: boolean;
    setElizaCloudEnabled: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    elizaCloudVoiceProxyAvailable: boolean;
    setElizaCloudVoiceProxyAvailable: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    elizaCloudConnected: boolean;
    setElizaCloudConnected: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    elizaCloudHasPersistedKey: boolean;
    setElizaCloudHasPersistedKey: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    elizaCloudCredits: number | null;
    setElizaCloudCredits: import("react").Dispatch<import("react").SetStateAction<number | null>>;
    elizaCloudCreditsLow: boolean;
    setElizaCloudCreditsLow: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    elizaCloudCreditsCritical: boolean;
    setElizaCloudCreditsCritical: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    elizaCloudAuthRejected: boolean;
    setElizaCloudAuthRejected: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    elizaCloudCreditsError: string | null;
    setElizaCloudCreditsError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
    elizaCloudTopUpUrl: string;
    setElizaCloudTopUpUrl: import("react").Dispatch<import("react").SetStateAction<string>>;
    elizaCloudUserId: string | null;
    setElizaCloudUserId: import("react").Dispatch<import("react").SetStateAction<string | null>>;
    elizaCloudStatusReason: string | null;
    setElizaCloudStatusReason: import("react").Dispatch<import("react").SetStateAction<string | null>>;
    cloudDashboardView: "overview" | "billing";
    setCloudDashboardView: import("react").Dispatch<import("react").SetStateAction<"overview" | "billing">>;
    elizaCloudLoginBusy: boolean;
    setElizaCloudLoginBusy: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    elizaCloudLoginError: string | null;
    setElizaCloudLoginError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
    elizaCloudDisconnecting: boolean;
    setElizaCloudDisconnecting: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    elizaCloudPollInterval: import("react").RefObject<number | null>;
    elizaCloudDisconnectInFlightRef: import("react").RefObject<boolean>;
    elizaCloudPreferDisconnectedUntilLoginRef: import("react").RefObject<boolean>;
    lastElizaCloudPollConnectedRef: import("react").RefObject<boolean>;
    elizaCloudLoginPollTimer: import("react").RefObject<number | null>;
    elizaCloudLoginBusyRef: import("react").RefObject<boolean>;
    handleCloudLoginRef: import("react").RefObject<() => Promise<void>>;
    pollCloudCredits: () => Promise<boolean>;
    handleCloudLogin: (prePoppedWindow?: Window | null) => Promise<void>;
    handleCloudDisconnect: (opts?: {
        skipConfirmation?: boolean;
    }) => Promise<void>;
};
export {};
//# sourceMappingURL=useCloudState.d.ts.map