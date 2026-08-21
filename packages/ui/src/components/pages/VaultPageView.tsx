/**
 * First-class owner-only Vault page. The actual manager lives in the Settings
 * module so the global shortcut modal, Settings entry point, and `/vault` route
 * share one controller, one set of API calls, and one mutation surface.
 */

import { OwnerOnlyNotice, RoleGate } from "../RoleGate";
import { VaultWorkspace } from "../settings/SecretsManagerSection";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

export function VaultPageView(): React.JSX.Element {
  return (
    <ShellViewAgentSurface viewId="vault">
      <RoleGate
        minRole="OWNER"
        fallback={
          <div className="mx-auto h-[calc(100%-var(--eliza-chat-clearance,5.25rem))] w-full max-w-5xl overflow-hidden p-4 sm:p-6">
            <OwnerOnlyNotice message="The Vault is available to the workspace owner only." />
          </div>
        }
      >
        <div
          data-testid="vault-page"
          data-chat-clearance-aware="true"
          className="mx-auto flex h-[calc(100%-var(--eliza-chat-clearance,5.25rem))] min-h-0 w-full max-w-5xl flex-col overflow-hidden p-4 sm:p-6"
        >
          <VaultWorkspace
            open
            onOpenChange={() => {}}
            initialTab={null}
            initialFocusKey={null}
            initialFocusProfileId={null}
            presentation="page"
          />
        </div>
      </RoleGate>
    </ShellViewAgentSurface>
  );
}
