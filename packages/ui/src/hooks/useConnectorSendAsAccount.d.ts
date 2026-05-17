import type { ConnectorAccountActionResult, ConnectorAccountRecord } from "../api/client-agent";
import { type ConnectorSendAsContext, normalizeConnectorSendAsContext } from "../components/chat/connector-send-as";
type ActionTone = "info" | "success" | "error";
type ActionNoticeFn = (text: string, tone?: ActionTone, ttlMs?: number, once?: boolean, busy?: boolean) => void;
export interface UseConnectorSendAsAccountOptions {
    pollMs?: number;
    setActionNotice?: ActionNoticeFn;
}
export interface UseConnectorSendAsAccountResult {
    context: ReturnType<typeof normalizeConnectorSendAsContext>;
    accounts: ConnectorAccountRecord[];
    loading: boolean;
    error: string | null;
    saving: Set<string>;
    selectedAccount: ConnectorAccountRecord | null;
    selectedAccountId: string | null;
    sendAsMetadata: Record<string, unknown> | undefined;
    showPicker: boolean;
    accountRequired: boolean;
    accountRequiredReason: string | null;
    selectAccount: (accountId: string | null) => void;
    connectAccount: () => Promise<ConnectorAccountActionResult>;
    reconnectAccount: (accountId: string) => Promise<ConnectorAccountActionResult>;
    refresh: () => Promise<void>;
}
export declare function useConnectorSendAsAccount(rawContext: ConnectorSendAsContext | null | undefined, options?: UseConnectorSendAsAccountOptions): UseConnectorSendAsAccountResult;
export {};
//# sourceMappingURL=useConnectorSendAsAccount.d.ts.map