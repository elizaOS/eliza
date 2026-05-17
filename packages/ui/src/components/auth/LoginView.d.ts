import { type AuthLoginResult } from "../../api/auth-client";
export interface LoginViewProps {
    /**
     * Called after a successful login so the shell can redirect to the
     * main dashboard.
     */
    onLoginSuccess: () => void;
    /** Injected login function (tests). */
    loginFn?: (params: {
        displayName: string;
        password: string;
        rememberDevice?: boolean;
    }) => Promise<AuthLoginResult>;
    reason?: "remote_auth_required" | "remote_password_not_configured";
}
export declare function LoginView({ onLoginSuccess, loginFn, reason }: LoginViewProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=LoginView.d.ts.map