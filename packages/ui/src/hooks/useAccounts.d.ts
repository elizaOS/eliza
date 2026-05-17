/**
 * useAccounts — fetches and mutates the multi-account credential pool
 * surfaced by `/api/accounts/*`.
 *
 * Polls `client.listAccounts()` on a configurable interval (default 30s)
 * to keep usage / health rows fresh. Each mutation routes through the
 * matching client method, applies an optimistic local update where safe,
 * and reconciles after the server response. Failures bubble through
 * `setActionNotice` so the parent settings panel can surface them.
 */
import type { LinkedAccountProviderId } from "@elizaos/shared";
import type { AccountStrategy, AccountsListResponse, AccountTestResult } from "../api/client-agent";
type ActionTone = "info" | "success" | "error";
type ActionNoticeFn = (text: string, tone?: ActionTone, ttlMs?: number, once?: boolean, busy?: boolean) => void;
export interface UseAccountsOptions {
    setActionNotice?: ActionNoticeFn;
    /** How often to refetch the full list. Defaults to 30s. */
    pollMs?: number;
}
export interface UseAccountsResult {
    data: AccountsListResponse | null;
    loading: boolean;
    saving: Set<string>;
    refresh: () => Promise<void>;
    createApiKey: (providerId: LinkedAccountProviderId, body: {
        label: string;
        apiKey: string;
    }) => Promise<void>;
    patch: (providerId: LinkedAccountProviderId, accountId: string, body: Partial<{
        label: string;
        enabled: boolean;
        priority: number;
    }>) => Promise<void>;
    remove: (providerId: LinkedAccountProviderId, accountId: string) => Promise<void>;
    test: (providerId: LinkedAccountProviderId, accountId: string) => Promise<AccountTestResult>;
    refreshUsage: (providerId: LinkedAccountProviderId, accountId: string) => Promise<void>;
    setStrategy: (providerId: LinkedAccountProviderId, strategy: AccountStrategy) => Promise<void>;
}
export declare function useAccounts(opts?: UseAccountsOptions): UseAccountsResult;
export {};
//# sourceMappingURL=useAccounts.d.ts.map