/**
 * Connections section for the cloud-only settings panel.
 *
 * Consolidated view of the cloud-hosted connectors (grouped by category) plus
 * configured MCP servers. This is a read-and-launch surface: each connector's
 * OAuth/token flow and the MCP CRUD live in the existing cloud connectors and
 * cloud/mcps modules — the buttons here hand off to those flows rather than
 * reimplementing them.
 *
 * Uses the same NuphyRow pattern as other sections:
 *   Title  →  Description  →  Action button (Connect/Disconnect)
 */

import { Button as NuphyButton } from "@extrastu/nuphy-ui";
import { Plus } from "lucide-react";
import { useAppSelector } from "../../../../state";
import {
  DestructiveSecondaryButton,
  NuphyRow,
  SettingsGroup,
  SettingsStack,
} from "../nuphy-settings-primitives";

/** A cloud connector shown in a category group. */
interface ConnectorEntry {
  id: string;
  name: string;
  /** Whether the connector is currently linked to this agent. */
  connected: boolean;
  /** Status copy under the name (e.g. "Connected — gateway agent"). */
  statusText: string;
}

/** A configured (or not-yet-configured) MCP server row. */
interface McpEntry {
  id: string;
  name: string;
  configured: boolean;
  statusText: string;
}

// ---------------------------------------------------------------------------
// Static connector / MCP rosters.
//
// Live connection state is owned by the existing cloud connector components
// (`cloud/connectors/*-connection`) and the cloud/mcps queries. This section
// is a consolidated launcher; wire `connected`/`configured` to those sources
// when mounting against real state. The ids match the connector-mode registry
// (`components/connectors/connector-mode-registry.ts`) and the MCP section ids.
// ---------------------------------------------------------------------------

const MESSAGING_CONNECTORS: ConnectorEntry[] = [
  {
    id: "discord",
    name: "Discord",
    connected: true,
    statusText: "Connected — gateway agent",
  },
  {
    id: "telegram",
    name: "Telegram",
    connected: false,
    statusText: "Not connected",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    connected: false,
    statusText: "Not connected",
  },
  {
    id: "twilio",
    name: "Twilio",
    connected: false,
    statusText: "Not connected",
  },
  { id: "slack", name: "Slack", connected: false, statusText: "Not connected" },
];

const SOCIAL_CONNECTORS: ConnectorEntry[] = [
  {
    id: "x",
    name: "X / Twitter",
    connected: false,
    statusText: "Not connected",
  },
  {
    id: "bluebubbles",
    name: "BlueBubbles",
    connected: false,
    statusText: "Not connected",
  },
];

const PRODUCTIVITY_CONNECTORS: ConnectorEntry[] = [
  {
    id: "google",
    name: "Google",
    connected: false,
    statusText: "Not connected",
  },
  {
    id: "microsoft",
    name: "Microsoft",
    connected: false,
    statusText: "Not connected",
  },
  {
    id: "blooio",
    name: "Blooio",
    connected: false,
    statusText: "Not connected",
  },
];

const MCP_SERVERS: McpEntry[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    configured: true,
    statusText: "Active",
  },
  {
    id: "github",
    name: "GitHub",
    configured: false,
    statusText: "Not configured",
  },
];

/* ── Connector row ──────────────────────────────────────────────── */

function ConnectorRow({ connector }: { connector: ConnectorEntry }) {
  const { name, connected, statusText } = connector;

  // Placeholder handlers — the real OAuth-redirect / token-credential flows
  // live in the existing cloud connector components (`cloud/connectors/*`).
  const handleConnect = () => {
    // TODO: route to the connector's setup panel (e.g. DiscordGatewayConnection).
  };
  const handleDisconnect = () => {
    // TODO: call the connector's disconnect endpoint (e.g. DELETE /api/v1/discord/connections/:id).
  };

  return (
    <NuphyRow
      label={name}
      description={statusText}
      control={
        connected ? (
          <DestructiveSecondaryButton
            size="sm"
            onClick={handleDisconnect}
          >
            Disconnect
          </DestructiveSecondaryButton>
        ) : (
          <NuphyButton variant="secondary" size="sm" onClick={handleConnect}>
            Connect
          </NuphyButton>
        )
      }
    />
  );
}

/* ── MCP server row ─────────────────────────────────────────────── */

function McpRow({ mcp }: { mcp: McpEntry }) {
  const { name, configured, statusText } = mcp;

  // Placeholder handlers — the real MCP CRUD lives in cloud/mcps.
  const handleAdd = () => {
    // TODO: open the MCP editor dialog (cloud/mcps/McpEditorDialog).
  };
  const handleRemove = () => {
    // TODO: call useDeleteMcp for this server id.
  };

  return (
    <NuphyRow
      label={name}
      description={statusText}
      control={
        configured ? (
          <DestructiveSecondaryButton size="sm" onClick={handleRemove}>
            Remove
          </DestructiveSecondaryButton>
        ) : (
          <NuphyButton variant="secondary" size="sm" onClick={handleAdd}>
            Add
          </NuphyButton>
        )
      }
    />
  );
}

/* ── Groups ─────────────────────────────────────────────────────── */

function ConnectorGroup({
  title,
  connectors,
}: {
  title: string;
  connectors: ConnectorEntry[];
}) {
  return (
    <SettingsGroup title={title}>
      {connectors.map((connector) => (
        <ConnectorRow key={connector.id} connector={connector} />
      ))}
    </SettingsGroup>
  );
}

/** Empty state shown when Eliza Cloud is not connected. */
function CloudDisconnectedEmpty() {
  return (
    <SettingsGroup
      title="Connections"
      footer="Connect to Eliza Cloud to manage channels."
    >
      <NuphyRow label="No cloud connection" />
    </SettingsGroup>
  );
}

export function ConnectionsSection() {
  const cloudConnected = useAppSelector((s) => s.elizaCloudConnected);

  if (!cloudConnected) {
    return (
      <SettingsStack>
        <CloudDisconnectedEmpty />
      </SettingsStack>
    );
  }

  // Placeholder handlers for the MCP group actions — real CRUD is in cloud/mcps.
  const handleAddMcpServer = () => {
    // TODO: open the MCP editor dialog (cloud/mcps/McpEditorDialog).
  };
  const handleBrowseCatalog = () => {
    // TODO: open the built-in MCP catalog browser (cloud/mcps/McpsView).
  };

  return (
    <SettingsStack>
      <ConnectorGroup title="Messaging" connectors={MESSAGING_CONNECTORS} />
      <ConnectorGroup title="Social" connectors={SOCIAL_CONNECTORS} />
      <ConnectorGroup
        title="Productivity"
        connectors={PRODUCTIVITY_CONNECTORS}
      />

      <SettingsGroup
        title="MCP Servers"
        footer="Model Context Protocol servers extend the agent with tools and data sources."
      >
        <NuphyRow
          label="Add MCP Server"
          description="Configure a new MCP server for this agent."
          control={
            <NuphyButton
              variant="secondary"
              size="sm"
              onClick={handleAddMcpServer}
            >
              <Plus aria-hidden />
              Add
            </NuphyButton>
          }
        />
        {MCP_SERVERS.map((mcp) => (
          <McpRow key={mcp.id} mcp={mcp} />
        ))}
        <NuphyRow
          label="Browse catalog"
          description="Explore the built-in MCP server catalog."
          control={
            <NuphyButton
              variant="ghost"
              size="sm"
              onClick={handleBrowseCatalog}
            >
              Browse
            </NuphyButton>
          }
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
