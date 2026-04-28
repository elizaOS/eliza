import type {
  StewardApprovalQueueProps,
  StewardLogoProps,
  StewardTransactionHistoryProps,
} from "../../config/boot-config";
import { useBootConfig } from "../../config/boot-config-react";

export function StewardLogo(props: StewardLogoProps) {
  const { stewardLogo: StewardLogoComponent } = useBootConfig();
  return StewardLogoComponent ? <StewardLogoComponent {...props} /> : null;
}

export function ApprovalQueue(props: StewardApprovalQueueProps) {
  const { stewardApprovalQueue: ApprovalQueueComponent } = useBootConfig();
  return ApprovalQueueComponent ? <ApprovalQueueComponent {...props} /> : null;
}

export function TransactionHistory(props: StewardTransactionHistoryProps) {
  const { stewardTransactionHistory: TransactionHistoryComponent } =
    useBootConfig();
  return TransactionHistoryComponent ? (
    <TransactionHistoryComponent {...props} />
  ) : null;
}
