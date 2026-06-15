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

import { useConnectorAccounts } from "../../hooks/useConnectorAccounts";
import { cn } from "../../lib/utils";
import { ConnectorAccountList } from "./ConnectorAccountList";

export interface OwnerAgentConnectorSetupPanelProps {
  provider: string;
  connectorId?: string;
  className?: string;
  pollMs?: number;
  /** When false, the OWNER section is hidden (e.g. agent-only connector). */
  enableOwner?: boolean;
  /** When false, the AGENT section is hidden (e.g. owner-only connector). */
  enableAgent?: boolean;
  ownerTitle?: string;
  agentTitle?: string;
  /** Optional help text rendered above the two sections. */
  description?: string;
}

export function OwnerAgentConnectorSetupPanel({
  provider,
  connectorId,
  className,
  pollMs,
  enableOwner = true,
  enableAgent = true,
  ownerTitle,
  agentTitle,
  description,
}: OwnerAgentConnectorSetupPanelProps) {
  // Hoist the accounts hook to the panel so both the OWNER and AGENT lists
  // share a single polling instance + cache, instead of each calling the
  // hook independently and double-firing `GET /api/connectors/:provider/accounts`
  // every poll cycle.
  const accountsHook = useConnectorAccounts(provider, connectorId ?? provider, {
    pollMs,
  });

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
        />
      ) : null}
      {enableAgent ? (
        <ConnectorAccountList
          provider={provider}
          connectorId={connectorId}
          accountRole="AGENT"
          title={agentTitle}
          externalAccounts={accountsHook}
        />
      ) : null}
    </div>
  );
}
