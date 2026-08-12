/**
 * Google Workspace connector setup: explicit capability selection before OAuth
 * and owner/agent account lists that pass the selected capability ids as scopes.
 */

import { useCallback, useMemo, useState } from "react";
import type { ConnectorAccountOAuthStartInput } from "../../api/client-agent";
import { useConnectorChannelMode } from "./connector-channel-mode";
import { GoogleWorkspaceCapabilityPicker } from "./GoogleWorkspaceCapabilityPicker";
import {
  type GoogleWorkspaceCapabilityId,
  normalizeGoogleWorkspaceCapabilitySelection,
} from "./google-workspace-capabilities";
import { OwnerAgentConnectorSetupPanel } from "./OwnerAgentConnectorSetupPanel";

export interface GoogleConnectorSetupPanelProps {
  provider?: string;
  connectorId?: string;
  className?: string;
}

export function GoogleConnectorSetupPanel({
  provider = "google",
  connectorId = provider,
  className,
}: GoogleConnectorSetupPanelProps) {
  const channelMode = useConnectorChannelMode();
  const [selectedCapabilities, setSelectedCapabilities] = useState<
    GoogleWorkspaceCapabilityId[]
  >([]);

  const oauthScopes = useMemo(
    () => normalizeGoogleWorkspaceCapabilitySelection(selectedCapabilities),
    [selectedCapabilities],
  );

  const resolveOAuthStartInput = useCallback(
    (): ConnectorAccountOAuthStartInput => ({
      scopes: [...oauthScopes],
      metadata: {
        requestedCapabilities: [...oauthScopes],
      },
    }),
    [oauthScopes],
  );

  return (
    <div className={className}>
      <GoogleWorkspaceCapabilityPicker
        selected={oauthScopes}
        onChange={setSelectedCapabilities}
        className="mb-3"
      />
      <OwnerAgentConnectorSetupPanel
        provider={provider}
        connectorId={connectorId}
        enableOwner={channelMode === "delegate"}
        enableAgent={channelMode === "bot"}
        enableTeam
        description="Connect a Google account with only the capabilities selected above."
        canStartOAuth={oauthScopes.length > 0}
        resolveOAuthStartInput={resolveOAuthStartInput}
      />
    </div>
  );
}
