/**
 * useConnectorAccounts — UI-facing connector account inventory hook.
 *
 * The backend route family is `/api/connectors/:provider/accounts`.
 * `connectorId` remains a UI grouping key for legacy connector config cards.
 */
import type { ConnectorAccountActionResult, ConnectorAccountCreateInput, ConnectorAccountOAuthStartInput, ConnectorAccountRecord, ConnectorAccountsListResponse, ConnectorAccountUpdateInput } from "../api/client-agent";
export declare const DEFAULT_CONNECTOR_ACCOUNT_ID = "default";
type ActionTone = "info" | "success" | "error";
type ActionNoticeFn = (text: string, tone?: ActionTone, ttlMs?: number, once?: boolean, busy?: boolean) => void;
export interface UseConnectorAccountsOptions {
    setActionNotice?: ActionNoticeFn;
    pollMs?: number;
    enabled?: boolean;
    initialSelectedAccountId?: string | null;
}
export interface UseConnectorAccountsResult {
    data: ConnectorAccountsListResponse | null;
    accounts: ConnectorAccountRecord[];
    loading: boolean;
    error: string | null;
    saving: Set<string>;
    defaultAccountId: string | null;
    selectedAccountId: string | null;
    selectedAccount: ConnectorAccountRecord | null;
    effectiveAccountId: string | null;
    setSelectedAccountId: (accountId: string | null) => void;
    refresh: () => Promise<void>;
    add: (body?: ConnectorAccountCreateInput) => Promise<ConnectorAccountActionResult>;
    startOAuth: (body?: ConnectorAccountOAuthStartInput) => Promise<ConnectorAccountActionResult>;
    update: (accountId: string, body: ConnectorAccountUpdateInput) => Promise<ConnectorAccountRecord>;
    test: (accountId: string) => Promise<ConnectorAccountActionResult>;
    refreshAccount: (accountId: string) => Promise<ConnectorAccountActionResult>;
    remove: (accountId: string) => Promise<ConnectorAccountActionResult>;
    makeDefault: (accountId: string) => Promise<ConnectorAccountActionResult>;
}
export declare function useConnectorAccounts(provider: string, connectorId?: string, options?: UseConnectorAccountsOptions): UseConnectorAccountsResult;
export {};
//# sourceMappingURL=useConnectorAccounts.d.ts.map