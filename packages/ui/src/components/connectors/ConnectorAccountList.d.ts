import type { ConnectorAccountCreateInput } from "../../api/client-agent";
export interface ConnectorAccountListProps {
    provider: string;
    connectorId?: string;
    title?: string;
    className?: string;
    pollMs?: number;
    selectedAccountId?: string | null;
    onSelectedAccountIdChange?: (accountId: string | null) => void;
    onAddAccount?: () => Promise<ConnectorAccountCreateInput | undefined> | ConnectorAccountCreateInput | undefined;
}
export declare function ConnectorAccountList({ provider, connectorId, title, className, pollMs, selectedAccountId, onSelectedAccountIdChange, onAddAccount, }: ConnectorAccountListProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ConnectorAccountList.d.ts.map