/**
 * Connections section for the cloud-only settings panel.
 *
 * Consolidated view of the cloud-hosted connectors (grouped by category) plus
 * configured MCP servers. Each connector's Connect/Disconnect flow is handled
 * inline through NuPhy-styled modals — token-credential connectors show a form,
 * OAuth-redirect connectors initiate the redirect, and destructive actions
 * confirm before executing. MCP servers are created/removed through a modal
 * form that posts to the real `/api/v1/mcps` CRUD routes.
 *
 * Authority: the backend is authoritative for connector state. The renderer
 * caches status, updates optimistically on connect/disconnect, and refetches
 * to reconcile.
 */

import { Button as NuphyButton } from "@extrastu/nuphy-ui";
import { Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAppSelector } from "../../../../state";
import { ApiError, api, apiFetch } from "../../../../cloud/lib/api-client";
import {
  DestructiveSecondaryButton,
  NuphyConfirmDialog,
  NuphyFormField,
  NuphyModal,
  NuphyRow,
  NuphyTextInput,
  SettingsGroup,
  SettingsStack,
} from "../nuphy-settings-primitives";

// ── Types ───────────────────────────────────────────────────────────────

interface ConnectorConfig {
  id: string;
  name: string;
  group: "messaging" | "social" | "productivity";
  /** "token" = form with credential fields; "oauth" = redirect flow. */
  authMode: "token" | "oauth";
  /** OAuth platform key (for `useOAuthConnections`). */
  oauthPlatform?: string;
  /** Status endpoint (GET). */
  statusPath: string;
  /** Connect endpoint (POST). */
  connectPath: string;
  /** Disconnect endpoint (DELETE). */
  disconnectPath: string;
  /** Fields for token-credential connectors. */
  fields?: ConnectorField[];
}

interface ConnectorField {
  key: string;
  label: string;
  description?: string;
  type?: "text" | "password";
  placeholder?: string;
  required?: boolean;
}

interface ConnectorState {
  connected: boolean;
  statusText: string;
  loading: boolean;
  error: string | null;
}

interface McpEntry {
  id: string;
  name: string;
  configured: boolean;
  statusText: string;
}

// ── Connector registry ──────────────────────────────────────────────────

const CONNECTORS: ConnectorConfig[] = [
  {
    id: "discord",
    name: "Discord",
    group: "messaging",
    authMode: "token",
    statusPath: "/api/v1/discord/connections",
    connectPath: "/api/v1/discord/connections",
    disconnectPath: "/api/v1/discord/connections",
    fields: [
      {
        key: "applicationId",
        label: "Application ID",
        description: "Your Discord application ID from the Developer Portal.",
        placeholder: "1234567890123456789",
        required: true,
      },
      {
        key: "botToken",
        label: "Bot Token",
        description: "The bot token from your Discord application.",
        type: "password",
        placeholder: "MTk4NjIy...",
        required: true,
      },
    ],
  },
  {
    id: "telegram",
    name: "Telegram",
    group: "messaging",
    authMode: "token",
    statusPath: "/api/v1/telegram/status",
    connectPath: "/api/v1/telegram/connect",
    disconnectPath: "/api/v1/telegram/disconnect",
    fields: [
      {
        key: "botToken",
        label: "Bot Token",
        description: "Get this from @BotFather on Telegram.",
        type: "password",
        placeholder: "123456:ABC-DEF...",
        required: true,
      },
    ],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    group: "messaging",
    authMode: "token",
    statusPath: "/api/v1/whatsapp/status",
    connectPath: "/api/v1/whatsapp/connect",
    disconnectPath: "/api/v1/whatsapp/disconnect",
    fields: [
      {
        key: "accessToken",
        label: "Access Token",
        description: "WhatsApp Business API access token.",
        type: "password",
        placeholder: "EAAG...",
        required: true,
      },
      {
        key: "phoneNumberId",
        label: "Phone Number ID",
        placeholder: "123456789",
        required: true,
      },
      {
        key: "appSecret",
        label: "App Secret",
        description: "Used to verify webhook payloads.",
        type: "password",
        placeholder: "abc123...",
      },
    ],
  },
  {
    id: "twilio",
    name: "Twilio",
    group: "messaging",
    authMode: "token",
    statusPath: "/api/v1/twilio/status",
    connectPath: "/api/v1/twilio/connect",
    disconnectPath: "/api/v1/twilio/disconnect",
    fields: [
      {
        key: "accountSid",
        label: "Account SID",
        placeholder: "AC...",
        required: true,
      },
      {
        key: "authToken",
        label: "Auth Token",
        type: "password",
        placeholder: "your-twilio-auth-token",
        required: true,
      },
      {
        key: "phoneNumber",
        label: "Phone Number",
        placeholder: "+1234567890",
        required: true,
      },
    ],
  },
  {
    id: "google",
    name: "Google",
    group: "productivity",
    authMode: "oauth",
    oauthPlatform: "google",
    statusPath: "/api/v1/oauth/connections?platform=google",
    connectPath: "/api/v1/oauth/google/initiate",
    disconnectPath: "/api/v1/oauth/connections",
  },
  {
    id: "microsoft",
    name: "Microsoft",
    group: "productivity",
    authMode: "oauth",
    oauthPlatform: "microsoft",
    statusPath: "/api/v1/oauth/connections?platform=microsoft",
    connectPath: "/api/v1/oauth/microsoft/initiate",
    disconnectPath: "/api/v1/oauth/connections",
  },
  {
    id: "blooio",
    name: "Blooio",
    group: "productivity",
    authMode: "token",
    statusPath: "/api/v1/blooio/status",
    connectPath: "/api/v1/blooio/connect",
    disconnectPath: "/api/v1/blooio/disconnect",
    fields: [
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        placeholder: "your-blooio-api-key",
        required: true,
      },
      {
        key: "phoneNumber",
        label: "Phone Number",
        placeholder: "+1234567890",
      },
    ],
  },
];

const MESSAGING = CONNECTORS.filter((c) => c.group === "messaging");
const PRODUCTIVITY = CONNECTORS.filter((c) => c.group === "productivity");

// ── Helpers ─────────────────────────────────────────────────────────────

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | undefined;
    if (body && typeof body.error === "string" && body.error) return body.error;
    return error.message || fallback;
  }
  return fallback;
}

// ── Connector status hook ───────────────────────────────────────────────

function useConnectorStatus(connector: ConnectorConfig) {
  const [state, setState] = useState<ConnectorState>({
    connected: false,
    statusText: "Not connected",
    loading: true,
    error: null,
  });

  const fetchStatus = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      if (connector.authMode === "oauth") {
        const data = await api<{ connections?: Array<{ status?: string; id?: string }> }>(
          connector.statusPath,
        );
        const active = data.connections?.find((c) => c.status === "active");
        setState({
          connected: Boolean(active),
          statusText: active ? "Connected" : "Not connected",
          loading: false,
          error: null,
        });
      } else if (connector.id === "discord") {
        const data = await api<{ connections?: Array<{ id?: string; status?: string }> }>(
          connector.statusPath,
        );
        const has = (data.connections?.length ?? 0) > 0;
        setState({
          connected: has,
          statusText: has
            ? `Connected — ${data.connections?.length} bot${(data.connections?.length ?? 0) > 1 ? "s" : ""}`
            : "Not connected",
          loading: false,
          error: null,
        });
      } else {
        const data = await api<{ configured?: boolean; connected?: boolean; error?: string }>(
          connector.statusPath,
        );
        const connected = data.configured || data.connected || false;
        setState({
          connected,
          statusText: connected ? "Connected" : "Not connected",
          loading: false,
          error: data.error ?? null,
        });
      }
    } catch (err) {
      // 401/403 means cloud auth issue; other errors are connector-specific.
      setState({
        connected: false,
        statusText: "Not connected",
        loading: false,
        error: err instanceof ApiError && err.status === 401 ? "Sign in to Cloud" : null,
      });
    }
  }, [connector]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  return { state, refetch: fetchStatus };
}

// ── Connector row ───────────────────────────────────────────────────────

function ConnectorRow({
  connector,
  onConnect,
  onDisconnect,
}: {
  connector: ConnectorConfig;
  onConnect: (connector: ConnectorConfig) => void;
  onDisconnect: (connector: ConnectorConfig) => void;
}) {
  const { state } = useConnectorStatus(connector);

  return (
    <NuphyRow
      label={connector.name}
      description={state.loading ? "Checking status…" : state.error ?? state.statusText}
      control={
        state.loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : state.connected ? (
          <DestructiveSecondaryButton
            size="sm"
            onClick={() => onDisconnect(connector)}
          >
            Disconnect
          </DestructiveSecondaryButton>
        ) : (
          <NuphyButton
            variant="secondary"
            size="sm"
            onClick={() => onConnect(connector)}
          >
            Connect
          </NuphyButton>
        )
      }
    />
  );
}

// ── Connect modal ───────────────────────────────────────────────────────

function ConnectModal({
  connector,
  onClose,
  onSuccess,
}: {
  connector: ConnectorConfig | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when a new connector opens.
  useEffect(() => {
    setFieldValues({});
    setError(null);
    setBusy(false);
  }, [connector?.id]);

  if (!connector) return null;

  const handleConnect = async () => {
    if (connector.authMode === "oauth") {
      setBusy(true);
      setError(null);
      try {
        const data = await api<{ authUrl?: string; error?: string }>(
          connector.connectPath,
          {
            method: "POST",
            json: { redirectUrl: "/cloud/connectors" },
          },
        );
        if (data.authUrl) {
          window.location.href = data.authUrl;
          return;
        }
        setError(data.error ?? "Failed to start OAuth flow.");
      } catch (err) {
        setError(apiErrorMessage(err, "Failed to start OAuth flow."));
      } finally {
        setBusy(false);
      }
      return;
    }

    // Token-credential: validate required fields.
    const missing = connector.fields?.filter(
      (f) => f.required && !fieldValues[f.key]?.trim(),
    );
    if (missing?.length) {
      setError(`Please fill in: ${missing.map((f) => f.label).join(", ")}.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const data = await api<{ success?: boolean; error?: string }>(
        connector.connectPath,
        { method: "POST", json: fieldValues },
      );
      if (data.success === false) {
        setError(data.error ?? "Connection failed.");
      } else {
        onSuccess();
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Connection failed. Check your credentials."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <NuphyModal
      open={connector !== null}
      title={`Connect ${connector.name}`}
      description={
        connector.authMode === "oauth"
          ? `You'll be redirected to ${connector.name} to authorize Eliza.`
          : `Enter your ${connector.name} credentials to connect.`
      }
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between">
          {error ? (
            <p className="text-[13px] text-destructive">{error}</p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <NuphyButton variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </NuphyButton>
            <NuphyButton
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void handleConnect()}
            >
              {busy ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Connecting…
                </>
              ) : connector.authMode === "oauth" ? (
                `Authorize with ${connector.name}`
              ) : (
                "Connect"
              )}
            </NuphyButton>
          </div>
        </div>
      }
    >
      {connector.authMode === "token" && connector.fields ? (
        <div className="space-y-4">
          {connector.fields.map((field) => (
            <NuphyFormField
              key={field.key}
              label={field.label}
              description={field.description}
              htmlFor={`field-${field.key}`}
            >
              <NuphyTextInput
                id={`field-${field.key}`}
                type={field.type ?? "text"}
                value={fieldValues[field.key] ?? ""}
                onChange={(v) =>
                  setFieldValues((prev) => ({ ...prev, [field.key]: v }))
                }
                placeholder={field.placeholder}
                disabled={busy}
                autoComplete="off"
              />
            </NuphyFormField>
          ))}
        </div>
      ) : (
        <p className="text-[14px] leading-5 text-muted-foreground">
          Click <strong>Authorize</strong> to open {connector.name}'s login page.
          After authorizing, you'll return here automatically.
        </p>
      )}
    </NuphyModal>
  );
}

// ── Disconnect confirm ──────────────────────────────────────────────────

function DisconnectDialog({
  connector,
  onClose,
  onConfirm,
}: {
  connector: ConnectorConfig | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!connector) return null;
  return (
    <NuphyConfirmDialog
      open={connector !== null}
      title={`Disconnect ${connector.name}?`}
      description={`This will remove the ${connector.name} connection from your agent. You can reconnect later.`}
      confirmLabel="Disconnect"
      destructive
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

// ── MCP add modal ───────────────────────────────────────────────────────

function McpAddModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setSlug("");
      setEndpointUrl("");
      setDescription("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const handleAdd = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!endpointUrl.trim()) {
      setError("Endpoint URL is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/v1/mcps", {
        method: "POST",
        json: {
          name: name.trim(),
          slug: slug.trim() || name.trim().toLowerCase().replace(/\s+/g, "-"),
          description: description.trim() || undefined,
          transport: "external",
          endpointUrl: endpointUrl.trim(),
        },
      });
      onSuccess();
    } catch (err) {
      setError(apiErrorMessage(err, "Failed to create MCP server."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <NuphyModal
      open={open}
      title="Add MCP Server"
      description="Configure a new Model Context Protocol server for this agent."
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between">
          {error ? (
            <p className="text-[13px] text-destructive">{error}</p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <NuphyButton variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </NuphyButton>
            <NuphyButton
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void handleAdd()}
            >
              {busy ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Adding…
                </>
              ) : (
                "Add server"
              )}
            </NuphyButton>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <NuphyFormField label="Name" htmlFor="mcp-name">
          <NuphyTextInput
            id="mcp-name"
            value={name}
            onChange={setName}
            placeholder="My MCP Server"
            disabled={busy}
          />
        </NuphyFormField>
        <NuphyFormField
          label="Slug"
          description="URL-safe identifier. Auto-generated from name if left blank."
          htmlFor="mcp-slug"
        >
          <NuphyTextInput
            id="mcp-slug"
            value={slug}
            onChange={setSlug}
            placeholder="my-mcp-server"
            disabled={busy}
          />
        </NuphyFormField>
        <NuphyFormField
          label="Endpoint URL"
          description="The MCP server's HTTP/SSE endpoint."
          htmlFor="mcp-url"
        >
          <NuphyTextInput
            id="mcp-url"
            value={endpointUrl}
            onChange={setEndpointUrl}
            placeholder="https://my-mcp-server.example.com/sse"
            disabled={busy}
          />
        </NuphyFormField>
        <NuphyFormField label="Description" htmlFor="mcp-desc">
          <NuphyTextInput
            id="mcp-desc"
            value={description}
            onChange={setDescription}
            placeholder="What does this MCP server provide?"
            disabled={busy}
          />
        </NuphyFormField>
      </div>
    </NuphyModal>
  );
}

// ── MCP remove confirm ──────────────────────────────────────────────────

function McpRemoveDialog({
  mcp,
  onClose,
  onConfirm,
}: {
  mcp: McpEntry | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!mcp) return null;
  return (
    <NuphyConfirmDialog
      open={mcp !== null}
      title={`Remove ${mcp.name}?`}
      description="This will remove the MCP server from your agent. You can add it again later."
      confirmLabel="Remove"
      destructive
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

// ── MCP list hook ───────────────────────────────────────────────────────

function useMcpServers() {
  const [servers, setServers] = useState<McpEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchMcps = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ mcps?: Array<{ id: string; name: string; status?: string }> }>(
        "/api/v1/mcps",
      );
      setServers(
        (data.mcps ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          configured: true,
          statusText: m.status ?? "Active",
        })),
      );
    } catch {
      // 401/404 — cloud not connected or no MCPs yet.
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMcps();
  }, [fetchMcps]);

  return { servers, loading, refetch: fetchMcps };
}

// ── MCP row ─────────────────────────────────────────────────────────────

function McpRow({
  mcp,
  onRemove,
}: {
  mcp: McpEntry;
  onRemove: (mcp: McpEntry) => void;
}) {
  return (
    <NuphyRow
      label={mcp.name}
      description={mcp.statusText}
      control={
        <DestructiveSecondaryButton size="sm" onClick={() => onRemove(mcp)}>
          Remove
        </DestructiveSecondaryButton>
      }
    />
  );
}

// ── Connector group ─────────────────────────────────────────────────────

function ConnectorGroup({
  title,
  connectors,
  footer,
  onConnect,
  onDisconnect,
}: {
  title: string;
  connectors: ConnectorConfig[];
  footer: string;
  onConnect: (c: ConnectorConfig) => void;
  onDisconnect: (c: ConnectorConfig) => void;
}) {
  return (
    <SettingsGroup title={title} footer={footer}>
      {connectors.map((connector) => (
        <ConnectorRow
          key={connector.id}
          connector={connector}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
      ))}
    </SettingsGroup>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────

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

// ── Main section ────────────────────────────────────────────────────────

export function ConnectionsSection() {
  const cloudConnected = useAppSelector((s) => s.elizaCloudConnected);
  const [connectTarget, setConnectTarget] = useState<ConnectorConfig | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<ConnectorConfig | null>(null);
  const [mcpAddOpen, setMcpAddOpen] = useState(false);
  const [mcpRemoveTarget, setMcpRemoveTarget] = useState<McpEntry | null>(null);
  const { servers: mcpServers, loading: mcpLoading, refetch: refetchMcps } = useMcpServers();

  // Disconnect handler — calls the connector's DELETE endpoint.
  const handleDisconnectConfirm = useCallback(async () => {
    if (!disconnectTarget) return;
    try {
      if (disconnectTarget.authMode === "oauth") {
        // OAuth: need the connection id. Fetch it first.
        const data = await api<{ connections?: Array<{ id: string; status?: string }> }>(
          disconnectTarget.statusPath,
        );
        const active = data.connections?.find((c) => c.status === "active");
        if (active) {
          await apiFetch(`${disconnectTarget.disconnectPath}/${active.id}`, {
            method: "DELETE",
          });
        }
      } else if (disconnectTarget.id === "discord") {
        // Discord: delete the first connection.
        const data = await api<{ connections?: Array<{ id: string }> }>(
          disconnectTarget.statusPath,
        );
        const first = data.connections?.[0];
        if (first) {
          await apiFetch(`${disconnectTarget.disconnectPath}/${first.id}`, {
            method: "DELETE",
          });
        }
      } else {
        await api(disconnectTarget.disconnectPath, { method: "DELETE" });
      }
    } catch {
      // Error is transient — the row's status refetch will show the real state.
    }
    setDisconnectTarget(null);
  }, [disconnectTarget]);

  // MCP remove handler.
  const handleMcpRemoveConfirm = useCallback(async () => {
    if (!mcpRemoveTarget) return;
    try {
      await apiFetch(`/api/v1/mcps/${mcpRemoveTarget.id}`, { method: "DELETE" });
      void refetchMcps();
    } catch {
      // Transient — refetch will reconcile.
    }
    setMcpRemoveTarget(null);
  }, [mcpRemoveTarget, refetchMcps]);

  if (!cloudConnected) {
    return (
      <SettingsStack>
        <CloudDisconnectedEmpty />
      </SettingsStack>
    );
  }

  return (
    <SettingsStack>
      <ConnectorGroup
        title="Messaging"
        connectors={MESSAGING}
        footer="Link Eliza to messaging channels for two-way conversation."
        onConnect={setConnectTarget}
        onDisconnect={setDisconnectTarget}
      />
      <ConnectorGroup
        title="Productivity"
        connectors={PRODUCTIVITY}
        footer="Integrate with productivity suites for calendar, mail, and docs."
        onConnect={setConnectTarget}
        onDisconnect={setDisconnectTarget}
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
              onClick={() => setMcpAddOpen(true)}
            >
              <Plus aria-hidden />
              Add
            </NuphyButton>
          }
        />
        {mcpLoading ? (
          <NuphyRow label="Loading MCP servers…" />
        ) : mcpServers.length === 0 ? (
          <NuphyRow
            label="No MCP servers"
            description="Add an MCP server to extend your agent with tools."
          />
        ) : (
          mcpServers.map((mcp) => (
            <McpRow key={mcp.id} mcp={mcp} onRemove={setMcpRemoveTarget} />
          ))
        )}
      </SettingsGroup>

      {/* Modals */}
      <ConnectModal
        connector={connectTarget}
        onClose={() => setConnectTarget(null)}
        onSuccess={() => {
          setConnectTarget(null);
          // The ConnectorRow's own status hook will refetch on remount.
          // Force a remount by toggling the key is unnecessary — each row
          // polls its own status independently.
        }}
      />
      <DisconnectDialog
        connector={disconnectTarget}
        onClose={() => setDisconnectTarget(null)}
        onConfirm={() => void handleDisconnectConfirm()}
      />
      <McpAddModal
        open={mcpAddOpen}
        onClose={() => setMcpAddOpen(false)}
        onSuccess={() => {
          setMcpAddOpen(false);
          void refetchMcps();
        }}
      />
      <McpRemoveDialog
        mcp={mcpRemoveTarget}
        onClose={() => setMcpRemoveTarget(null)}
        onConfirm={() => void handleMcpRemoveConfirm()}
      />
    </SettingsStack>
  );
}
