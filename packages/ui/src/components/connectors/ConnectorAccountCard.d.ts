import type {
  ConnectorAccountRecord,
  ConnectorAccountUpdateInput,
} from "../../api/client-agent";
export interface ConnectorAccountCardProps {
  account: ConnectorAccountRecord;
  isDefault?: boolean;
  selected?: boolean;
  saving?: boolean;
  testBusy?: boolean;
  refreshBusy?: boolean;
  onSelect?: () => void;
  onUpdate: (body: ConnectorAccountUpdateInput) => Promise<void>;
  onTest: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onDelete: () => Promise<void>;
  onMakeDefault: () => Promise<void>;
}
export declare function ConnectorAccountCard({
  account,
  isDefault,
  selected,
  saving,
  testBusy,
  refreshBusy,
  onSelect,
  onUpdate,
  onTest,
  onRefresh,
  onDelete,
  onMakeDefault,
}: ConnectorAccountCardProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ConnectorAccountCard.d.ts.map
