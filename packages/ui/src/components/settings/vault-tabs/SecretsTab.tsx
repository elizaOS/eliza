/**
 * Secrets tab — wraps `VaultInventoryPanel` with the Vault modal's
 * shared data state and cross-tab navigation contract.
 *
 * The parent modal owns the entries fetch; this tab only renders.
 */

import { useCallback } from "react";
import { VaultInventoryPanel } from "../VaultInventoryPanel";
import type {
  ConnectorSecretFinding,
  VaultEntryMeta,
  VaultTabNavigate,
} from "./types";

export interface SecretsTabProps {
  entries: VaultEntryMeta[];
  securityFindings: ConnectorSecretFinding[];
  onChanged: () => void;
  navigate: VaultTabNavigate;
  focusKey: string | null;
  focusProfileId: string | null;
  onFocusApplied: () => void;
}

export function SecretsTab({
  entries,
  securityFindings,
  onChanged,
  navigate,
  focusKey,
  focusProfileId,
  onFocusApplied,
}: SecretsTabProps) {
  const onJumpToRouting = useCallback(
    (key: string) => navigate({ tab: "routing", focusKey: key }),
    [navigate],
  );
  return (
    <VaultInventoryPanel
      entries={entries}
      securityFindings={securityFindings}
      onChanged={onChanged}
      onJumpToRouting={onJumpToRouting}
      focusKey={focusKey}
      focusProfileId={focusProfileId}
      onFocusApplied={onFocusApplied}
    />
  );
}
