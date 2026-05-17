import { type SubscriptionProviderSelectionId } from "../../providers";
export interface SubscriptionStatusProps {
    resolvedSelectedId: string | null;
    subscriptionStatus: Array<{
        provider: string;
        accountId: string;
        label: string;
        configured: boolean;
        valid: boolean;
        expiresAt: number | null;
        source?: "app" | "claude-code-cli" | "setup-token" | "codex-cli" | "gemini-cli" | "coding-plan-key" | "unavailable" | null;
        available?: boolean;
        availabilityReason?: string;
        allowedClient?: string;
        loginHint?: string;
        billingMode?: "subscription-coding-plan" | "subscription-coding-cli";
    }>;
    anthropicConnected: boolean;
    setAnthropicConnected: (v: boolean) => void;
    /**
     * True when Claude Code CLI credentials exist on this machine but the user
     * has NOT linked their subscription via the in-app OAuth flow. In this
     * state the panel shows a read-only notice and hides the Disconnect
     * button — the app can't clear CLI-owned credentials.
     */
    anthropicCliDetected: boolean;
    openaiConnected: boolean;
    setOpenaiConnected: (v: boolean) => void;
    handleSelectSubscription: (providerId: SubscriptionProviderSelectionId, activate?: boolean) => Promise<void>;
    loadSubscriptionStatus: () => Promise<void>;
}
export declare function SubscriptionStatus({ resolvedSelectedId, subscriptionStatus, anthropicConnected, setAnthropicConnected, anthropicCliDetected, openaiConnected, setOpenaiConnected, handleSelectSubscription, loadSubscriptionStatus, }: SubscriptionStatusProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=SubscriptionStatus.d.ts.map