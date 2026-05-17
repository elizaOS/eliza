/**
 * useAuthStatus — monitors the current auth state via GET /api/auth/me.
 *
 * Returns a discriminated union that lets the shell decide whether to render
 * the login gate or the main dashboard.
 *
 * Fail-closed: network errors are treated as server-unavailable so the app
 * never leaks the dashboard, but also does not imply bad credentials.
 *
 * Call `refetch()` after login / logout to force a fresh check.
 */
import { type AuthAccessInfo, type AuthIdentity, type AuthSessionInfo } from "../api/auth-client";
export type AuthStatusState = {
    phase: "loading";
} | {
    phase: "authenticated";
    identity: AuthIdentity;
    session: AuthSessionInfo;
    access: AuthAccessInfo;
} | {
    phase: "unauthenticated";
    reason?: "remote_auth_required" | "remote_password_not_configured";
    access?: AuthAccessInfo;
} | {
    phase: "server_unavailable";
};
interface UseAuthStatusOptions {
    /**
     * How often to re-check in the background (ms).
     * Defaults to 5 minutes. Set to 0 to disable background polling.
     */
    pollIntervalMs?: number;
    /**
     * When true the hook will NOT start its initial fetch.
     * Useful when the app knows auth is not yet relevant (e.g. during onboarding).
     */
    skip?: boolean;
    /**
     * Subscribe to the latest auth status without starting a fetch or poll loop.
     * Useful for read-only shell metadata that should reuse the app-level check.
     */
    observeOnly?: boolean;
}
export declare function useAuthStatus(options?: UseAuthStatusOptions): {
    state: AuthStatusState;
    refetch: () => void;
};
export {};
//# sourceMappingURL=useAuthStatus.d.ts.map