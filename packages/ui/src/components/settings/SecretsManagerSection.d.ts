import { type VaultTab } from "../../hooks/useSecretsManagerModal";
export declare function SecretsManagerSection(): import("react/jsx-runtime").JSX.Element;
export declare function SecretsManagerModalRoot(): import("react/jsx-runtime").JSX.Element;
export interface VaultModalProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /**
   * Optional tab to land on when opening. Owner is responsible for
   * resetting via `onConsumeInitial` after the modal opens so the
   * next open uses the user's most recent tab again.
   */
  initialTab?: VaultTab | null;
  initialFocusKey?: string | null;
  initialFocusProfileId?: string | null;
  onConsumeInitial?: () => void;
}
export declare function VaultModal({
  open,
  onOpenChange,
  initialTab,
  initialFocusKey,
  initialFocusProfileId,
  onConsumeInitial,
}: VaultModalProps): import("react/jsx-runtime").JSX.Element;
export { LoginsTab as SavedLoginsPanel } from "./vault-tabs/LoginsTab";
export {
  BackendRow,
  InstallSheet,
  SigninSheet,
} from "./vault-tabs/OverviewTab";
export { VaultModal as SecretsManagerModal };
//# sourceMappingURL=SecretsManagerSection.d.ts.map
