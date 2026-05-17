import type { ConnectorAccountRecord } from "../../api/client-agent";
export interface ConnectorAccountPickerProps {
    accounts: ConnectorAccountRecord[];
    className?: string;
    connectBusy?: boolean;
    disabled?: boolean;
    loading?: boolean;
    selectedAccount: ConnectorAccountRecord | null;
    sourceLabel?: string;
    show?: boolean;
    onConnectAccount?: () => void;
    onReconnectAccount?: (accountId: string) => void;
    onSelectAccount: (accountId: string) => void;
}
export declare function ConnectorAccountPicker({ accounts, className, connectBusy, disabled, loading, selectedAccount, sourceLabel, show, onConnectAccount, onReconnectAccount, onSelectAccount, }: ConnectorAccountPickerProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=ConnectorAccountPicker.d.ts.map