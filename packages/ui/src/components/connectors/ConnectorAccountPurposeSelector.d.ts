import type { ConnectorAccountRole } from "../../api/client-agent";
export interface ConnectorAccountPurposeSelectorProps {
  value?: ConnectorAccountRole;
  onChange: (
    value: ConnectorAccountRole,
    confirmation?: {
      role?: string;
    },
  ) => Promise<void> | void;
  disabled?: boolean;
  id?: string;
  accountLabel?: string;
}
export declare function ConnectorAccountPurposeSelector({
  value,
  onChange,
  disabled,
  id,
  accountLabel,
}: ConnectorAccountPurposeSelectorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ConnectorAccountPurposeSelector.d.ts.map
