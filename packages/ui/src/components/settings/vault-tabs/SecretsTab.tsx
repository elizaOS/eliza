/**
 * Secrets tab — wraps `VaultInventoryPanel` with the Vault modal's
 * shared data state and cross-tab navigation contract.
 *
 * The parent modal owns the entries fetch; this tab only renders.
 */

import { VaultInventoryPanel } from "../VaultInventoryPanel";
import type { VaultEntryMeta, VaultTabNavigate } from "./types";

export interface SecretsTabProps {
  entries: VaultEntryMeta[];
  onChanged: () => void;
  navigate: VaultTabNavigate;
  focusKey: string | null;
  focusProfileId: string | null;
  onFocusApplied: () => void;
}

export function SecretsTab({
  entries,
  onChanged,
  navigate,
  focusKey,
  focusProfileId,
  onFocusApplied,
}: SecretsTabProps) {
  return (
    <VaultInventoryPanel
      entries={entries}
      onChanged={onChanged}
      onJumpToRouting={(key) => navigate({ tab: "routing", focusKey: key })}
      focusKey={focusKey}
      focusProfileId={focusProfileId}
      onFocusApplied={onFocusApplied}
    />
  );
}
