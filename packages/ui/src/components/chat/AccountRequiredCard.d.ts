import type { ConnectorAccountRecord } from "../../api/client-agent";
export interface AccountRequiredCardProps {
  accounts: ConnectorAccountRecord[];
  className?: string;
  connectBusy?: boolean;
  confirmBusy?: boolean;
  confirmLabel?: string;
  description?: string;
  loading?: boolean;
  selectedAccount: ConnectorAccountRecord | null;
  sourceLabel?: string;
  title?: string;
  onConfirm?: () => void;
  onConnectAccount?: () => void;
  onReconnectAccount?: (accountId: string) => void;
  onSelectAccount?: (accountId: string) => void;
}
export declare function AccountRequiredCard({
  accounts,
  className,
  connectBusy,
  confirmBusy,
  confirmLabel,
  description,
  loading,
  selectedAccount,
  sourceLabel,
  title,
  onConfirm,
  onConnectAccount,
  onReconnectAccount,
  onSelectAccount,
}: AccountRequiredCardProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=AccountRequiredCard.d.ts.map
