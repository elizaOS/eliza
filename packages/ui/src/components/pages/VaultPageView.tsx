/**
 * First-class owner-only Vault page. The actual manager lives in the Settings
 * module so the global shortcut modal, Settings entry point, and `/vault` route
 * share one controller, one set of API calls, and one mutation surface.
 */

import {
  FramedPage,
  FramedPageBody,
  FramedPageHeader,
} from "../../layouts/framed-page";
import { OwnerOnlyNotice, RoleGate } from "../RoleGate";
import { VaultWorkspace } from "../settings/SecretsManagerSection";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

export function VaultPageView(): React.JSX.Element {
  return (
    <ShellViewAgentSurface viewId="vault">
      <FramedPage
        gutterOwner="framed-page"
        data-testid="vault-page"
        data-chat-clearance-aware="true"
      >
        <FramedPageHeader
          title="Vault"
          description="Encrypted credentials and references available to this agent. Organization credential pools remain managed in Eliza Cloud."
        />
        <FramedPageBody scroll="view">
          <RoleGate
            minRole="OWNER"
            fallback={
              <OwnerOnlyNotice message="The Vault is available to the workspace owner only." />
            }
          >
            <VaultWorkspace
              open
              onOpenChange={() => {}}
              initialTab={null}
              initialFocusKey={null}
              initialFocusProfileId={null}
              presentation="framed-page"
            />
          </RoleGate>
        </FramedPageBody>
      </FramedPage>
    </ShellViewAgentSurface>
  );
}
