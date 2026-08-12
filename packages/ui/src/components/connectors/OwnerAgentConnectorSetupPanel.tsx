/**
 * OwnerAgentConnectorSetupPanel — dual-section setup UI for connectors that
 * support both OWNER and AGENT accounts.
 *
 * Renders two `ConnectorAccountList`s stacked: one filtered to the user's
 * own account(s) on the platform (OWNER), one to the agent's separate
 * identity account(s) (AGENT). Each section has its own "Add account"
 * button that threads the appropriate `requestedRole` through the OAuth
 * start request.
 *
 * Plugins opt into this layout by registering it for their connector ID
 * via `registerConnectorSetupPanel("plugin-x", () => <OwnerAgentConnectorSetupPanel ... />)`
 * inside the plugin's UI registration entry point.
 *
 * Falls back to a single-section list when a side is explicitly disabled
 * (`enableOwner: false` or `enableAgent: false`), so a plugin can also use
 * this component for an AGENT-only flow while keeping the dual-role shape.
 */

import type {
  ConnectorAccountCreateInput,
  ConnectorAccountOAuthStartInput,
  ConnectorAccountRole,
} from "../../api/client-agent";
import { useConnectorAccounts } from "../../hooks/useConnectorAccounts";
import { cn } from "../../lib/utils";
import {
  CONNECTOR_UNKNOWN_ROLE_BUCKET,
  ConnectorAccountList,
} from "./ConnectorAccountList";

export interface OwnerAgentConnectorSetupPanelProps {
  provider: string;
  connectorId?: string;
  className?: string;
  pollMs?: number;
  /** When false, the OWNER section is hidden (e.g. agent-only connector). */
  enableOwner?: boolean;
  /** When false, the AGENT section is hidden (e.g. owner-only connector). */
  enableAgent?: boolean;
  /** TEAM accounts are identity-neutral and may appear in either lens. */
  enableTeam?: boolean;
  /** Optional non-OAuth account factory; OAuth lists use their normal flow. */
  onAddAccount?: (
    role: ConnectorAccountRole,
  ) =>
    | Promise<ConnectorAccountCreateInput | undefined>
    | ConnectorAccountCreateInput
    | undefined;
  ownerTitle?: string;
  agentTitle?: string;
  /** Optional help text rendered above the two sections. */
  description?: string;
  /** When false, OAuth add-account buttons stay disabled (e.g. missing scopes). */
  canStartOAuth?: boolean;
  /** Optional OAuth body factory merged into the start request (scopes/metadata). */
  resolveOAuthStartInput?: () => ConnectorAccountOAuthStartInput;
}

export function OwnerAgentConnectorSetupPanel({
  provider,
  connectorId,
  className,
  pollMs,
  enableOwner = true,
  enableAgent = true,
  enableTeam = false,
  onAddAccount,
  ownerTitle,
  agentTitle,
  description,
  canStartOAuth = true,
  resolveOAuthStartInput,
}: OwnerAgentConnectorSetupPanelProps) {
  // Hoist the accounts hook to the panel so both the OWNER and AGENT lists
  // share a single polling instance + cache, instead of each calling the
  // hook independently and double-firing `GET /api/connectors/:provider/accounts`
  // every poll cycle.
  const accountsHook = useConnectorAccounts(provider, connectorId ?? provider, {
    pollMs,
  });

  // #12087 Item 32: accounts whose server role is unrecognized/missing are no
  // longer mislabelled OWNER. Surface any such accounts in a distinct read-only
  // section — outside the Owner/Agent sections — so they are neither dropped nor
  // shown as the owner's own. Rendered only when at least one exists.
  const hasUnknownRoleAccounts = accountsHook.accounts.some(
    (account) => !account.role,
  );

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {description ? <p className="text-xs text-muted">{description}</p> : null}
      {enableOwner ? (
        <ConnectorAccountList
          provider={provider}
          connectorId={connectorId}
          accountRole="OWNER"
          title={ownerTitle}
          externalAccounts={accountsHook}
          onAddAccount={onAddAccount ? () => onAddAccount("OWNER") : undefined}
          canStartOAuth={canStartOAuth}
          resolveOAuthStartInput={resolveOAuthStartInput}
        />
      ) : null}
      {enableAgent ? (
        <ConnectorAccountList
          provider={provider}
          connectorId={connectorId}
          accountRole="AGENT"
          title={agentTitle}
          externalAccounts={accountsHook}
          onAddAccount={onAddAccount ? () => onAddAccount("AGENT") : undefined}
          canStartOAuth={canStartOAuth}
          resolveOAuthStartInput={resolveOAuthStartInput}
        />
      ) : null}
      {enableTeam ? (
        <ConnectorAccountList
          provider={provider}
          connectorId={connectorId}
          accountRole="TEAM"
          externalAccounts={accountsHook}
          onAddAccount={onAddAccount ? () => onAddAccount("TEAM") : undefined}
          canStartOAuth={canStartOAuth}
          resolveOAuthStartInput={resolveOAuthStartInput}
        />
      ) : null}
      {hasUnknownRoleAccounts ? (
        <ConnectorAccountList
          provider={provider}
          connectorId={connectorId}
          accountRole={CONNECTOR_UNKNOWN_ROLE_BUCKET}
          externalAccounts={accountsHook}
        />
      ) : null}
    </div>
  );
}
