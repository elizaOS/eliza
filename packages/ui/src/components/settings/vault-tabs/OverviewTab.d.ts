/**
 * Overview tab — backends list, install / sign-in / sign-out, ordering,
 * and the "Save preferences" action.
 *
 * Extracted from the original `SecretsManagerModal` body. The parent
 * Vault modal owns data fetching and the save flow; this component
 * only renders the rows + the editable preference state.
 */
import type {
  BackendStatus,
  InstallableBackendId,
  InstallMethod,
  ManagerPreferences,
} from "./types";
export interface OverviewTabProps {
  backends: BackendStatus[];
  preferences: ManagerPreferences;
  installMethods: Record<InstallableBackendId, InstallMethod[]>;
  saving: boolean;
  savedAt: number | null;
  onPreferencesChange: (next: ManagerPreferences) => void;
  onSave: () => void;
  onReload: () => void;
  onInstallComplete: () => void;
  onSigninComplete: () => void;
  onSignout: (backendId: InstallableBackendId) => void;
}
export declare function OverviewTab(
  props: OverviewTabProps,
): import("react/jsx-runtime").JSX.Element;
interface BackendRowProps {
  backend: BackendStatus;
  enabled: boolean;
  isPrimary: boolean;
  position: number;
  totalEnabled: number;
  methods: readonly InstallMethod[];
  installSheetOpen: boolean;
  signinSheetOpen: boolean;
  onToggle: (on: boolean) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onOpenInstallSheet: () => void;
  onOpenSigninSheet: () => void;
  onCloseSheets: () => void;
  onInstallComplete: () => void;
  onSigninComplete: () => void;
  onSignout: () => void;
}
export declare function BackendRow(
  props: BackendRowProps,
): import("react/jsx-runtime").JSX.Element;
interface InstallSheetProps {
  backendId: InstallableBackendId;
  backendLabel: string;
  methods: readonly InstallMethod[];
  onCancel: () => void;
  onComplete: () => void;
}
export declare function InstallSheet({
  backendId,
  backendLabel,
  methods,
  onCancel,
  onComplete,
}: InstallSheetProps): import("react/jsx-runtime").JSX.Element;
interface SigninSheetProps {
  backendId: InstallableBackendId;
  backendLabel: string;
  onCancel: () => void;
  onComplete: () => void;
}
export declare function SigninSheet({
  backendId,
  backendLabel,
  onCancel,
  onComplete,
}: SigninSheetProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=OverviewTab.d.ts.map
