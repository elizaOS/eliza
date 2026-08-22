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
import { ApiError, api, apiFetch } from "../../../../cloud/lib/api-client";
import { useCloudConnectorConnections } from "../../../../hooks/useCloudConnectorConnections";
import { useAppSelector } from "../../../../state";
import { openExternalUrl } from "../../../../utils/openExternalUrl";
import {
  buildMcpCreatePayload,
  CLOUD_CONNECTORS,
  type ConnectorConfig,
  connectorFieldValidationError,
  connectorMutationSucceeded,
} from "../cloud-connector-contracts";
import { hasCloudManagementCredential } from "../cloud-management-auth";
import {
  DestructiveSecondaryButton,
  NuphyFormField,
  NuphyModal,
  NuphyRow,
  NuphyTextInput,
  SettingsGroup,
  SettingsStack,
} from "../nuphy-settings-primitives";

// ── Types ───────────────────────────────────────────────────────────────

interface McpEntry {
  id: string;
  name: string;
  configured: boolean;
  statusText: string;
}

interface CloudAgentSummary {
  id?: unknown;
  name?: unknown;
}

interface CloudAgentChoice {
  id: string;
  name: string;
}

function cloudAgentChoices(
  agents: CloudAgentSummary[] | undefined,
): CloudAgentChoice[] {
  const choices: CloudAgentChoice[] = [];
  for (const agent of agents ?? []) {
    if (typeof agent.id === "string" && agent.id.length > 0) {
      choices.push({
        id: agent.id,
        name:
          typeof agent.name === "string" && agent.name.length > 0
            ? agent.name
            : agent.id,
      });
    }
  }
  return choices;
}

/** A single disconnectable identity (OAuth account or Discord bot). */
interface ConnectionChoice {
  id: string;
  label: string;
  active: boolean;
}

// ── Connector registry ──────────────────────────────────────────────────

const MESSAGING = CLOUD_CONNECTORS.filter(
  (connector) => connector.group === "messaging",
);
const PRODUCTIVITY = CLOUD_CONNECTORS.filter(
  (connector) => connector.group === "productivity",
);

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const body = error.body as { error?: unknown; message?: unknown } | undefined;
  if (typeof body?.error === "string" && body.error) return body.error;
  if (typeof body?.message === "string" && body.message) return body.message;
  return error.message || fallback;
}

// ── Connector row ───────────────────────────────────────────────────────

function ConnectorRow({
  connector,
  refreshVersion,
  onConnect,
  onDisconnect,
}: {
  connector: ConnectorConfig;
  refreshVersion: number;
  onConnect: (connector: ConnectorConfig) => void;
  onDisconnect: (connector: ConnectorConfig) => void;
}) {
  const { state } = useCloudConnectorConnections({
    kind:
      connector.authMode === "oauth"
        ? "oauth"
        : connector.id === "discord"
          ? "discord"
          : "credential",
    statusPath: connector.statusPath,
    refreshVersion,
  });

  return (
    <NuphyRow
      label={connector.name}
      description={
        state.loading ? "Checking status…" : (state.error ?? state.statusText)
      }
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
        ) : state.error ? (
          <NuphyButton variant="secondary" size="sm" disabled>
            Unavailable
          </NuphyButton>
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
  const [agentChoices, setAgentChoices] = useState<CloudAgentChoice[] | null>(
    null,
  );
  const [selectedAgentId, setSelectedAgentId] = useState("");

  // Reset form when a new connector opens. Discord binds a bot to a specific
  // agent, so load the agent list up front and make the target explicit
  // instead of silently picking the first unordered agent.
  useEffect(() => {
    setFieldValues({});
    setError(null);
    setBusy(false);
    setAgentChoices(null);
    setSelectedAgentId("");
    if (connector?.id !== "discord") return;
    let cancelled = false;
    void api<{ agents?: CloudAgentSummary[] }>("/api/v1/dashboard")
      .then((dashboard) => {
        if (cancelled) return;
        const choices = cloudAgentChoices(dashboard.agents);
        setAgentChoices(choices);
        if (choices.length === 1) setSelectedAgentId(choices[0].id);
      })
      .catch((cause: unknown) => {
        // error-policy:J4 agent-list failure blocks connect with a visible error.
        if (cancelled) return;
        setAgentChoices([]);
        setError(apiErrorMessage(cause, "Failed to load your agents."));
      });
    return () => {
      cancelled = true;
    };
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
          if (await openExternalUrl(data.authUrl)) return;
          setError("The authorization page could not be opened safely.");
        } else {
          setError(data.error ?? "Failed to start OAuth flow.");
        }
      } catch (err) {
        setError(apiErrorMessage(err, "Failed to start OAuth flow."));
      } finally {
        setBusy(false);
      }
      return;
    }

    // Token-credential: validate required fields.
    const validationError = connector.fields
      ?.map((field) =>
        connectorFieldValidationError(field, fieldValues[field.key] ?? ""),
      )
      .find((message) => message !== null);
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      let payload: Record<string, unknown> = Object.fromEntries(
        Object.entries(fieldValues).map(([key, value]) => [key, value.trim()]),
      );
      if (connector.id === "discord") {
        if (agentChoices !== null && agentChoices.length === 0) {
          setError("Create an agent before connecting Discord.");
          return;
        }
        if (!selectedAgentId) {
          setError("Choose which agent this Discord bot should use.");
          return;
        }
        payload = {
          ...payload,
          characterId: selectedAgentId,
          metadata: { responseMode: "mention" },
        };
      }
      const data = await api<{ success?: boolean; error?: string }>(
        connector.connectPath,
        { method: "POST", json: payload },
      );
      if (connectorMutationSucceeded(data)) {
        onSuccess();
      } else {
        setError(data.error ?? "Connection failed.");
      }
    } catch (err) {
      setError(
        apiErrorMessage(err, "Connection failed. Check your credentials."),
      );
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
          {connector.id === "discord" && (
            <NuphyFormField
              label="Agent"
              description="The agent this Discord bot responds as."
              htmlFor="connect-agent"
            >
              <select
                id="connect-agent"
                className="w-full rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-3 py-2 text-[14px] text-[var(--foreground)]"
                value={selectedAgentId}
                onChange={(event) => setSelectedAgentId(event.target.value)}
                disabled={busy || agentChoices === null}
              >
                <option value="" disabled>
                  {agentChoices === null
                    ? "Loading agents…"
                    : agentChoices.length === 0
                      ? "No agents available"
                      : "Choose an agent"}
                </option>
                {(agentChoices ?? []).map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </NuphyFormField>
          )}
        </div>
      ) : (
        <p className="text-[14px] leading-5 text-muted-foreground">
          Click <strong>Authorize</strong> to open {connector.name}'s login
          page. After authorizing, you'll return here automatically.
        </p>
      )}
    </NuphyModal>
  );
}

// ── Disconnect confirm ──────────────────────────────────────────────────

/**
 * Whether disconnecting this connector must target one connection record by
 * id. OAuth providers and Discord support several linked accounts/bots, so a
 * revoke must never fall back to "the first record".
 */
function connectorRequiresConnectionChoice(
  connector: ConnectorConfig,
): boolean {
  return connector.authMode === "oauth" || connector.id === "discord";
}

interface RawConnectionRecord {
  id?: unknown;
  status?: unknown;
  displayName?: unknown;
  externalAccountId?: unknown;
  botUserId?: unknown;
  applicationId?: unknown;
  isActive?: unknown;
}

function toConnectionChoices(
  records: RawConnectionRecord[] | undefined,
): ConnectionChoice[] {
  const choices: ConnectionChoice[] = [];
  for (const record of records ?? []) {
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    const label =
      [record.displayName, record.externalAccountId, record.botUserId]
        .map((value) => (typeof value === "string" ? value : ""))
        .find((value) => value.length > 0) ?? record.id;
    choices.push({
      id: record.id,
      label,
      active: record.status === "active" || record.isActive === true,
    });
  }
  return choices;
}

function DisconnectDialog({
  connector,
  onClose,
  onConfirm,
}: {
  connector: ConnectorConfig | null;
  onClose: () => void;
  onConfirm: (connectionId: string | null) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<ConnectionChoice[] | null>(null);
  const [selectedId, setSelectedId] = useState("");

  const needsChoice =
    connector !== null && connectorRequiresConnectionChoice(connector);

  // Load the concrete connection records so the confirm binds an explicit
  // identity instead of revoking an arbitrary account.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connector identity intentionally resets the dialog.
  useEffect(() => {
    setError(null);
    setBusy(false);
    setChoices(null);
    setSelectedId("");
    if (!connector || !connectorRequiresConnectionChoice(connector)) return;
    let cancelled = false;
    void api<{ connections?: RawConnectionRecord[] }>(connector.statusPath)
      .then((data) => {
        if (cancelled) return;
        const loaded = toConnectionChoices(data.connections);
        setChoices(loaded);
        if (loaded.length === 1) setSelectedId(loaded[0].id);
      })
      .catch((cause: unknown) => {
        // error-policy:J4 listing failure blocks the destructive action visibly.
        if (cancelled) return;
        setChoices([]);
        setError(apiErrorMessage(cause, "Failed to load connections."));
      });
    return () => {
      cancelled = true;
    };
  }, [connector?.id]);

  if (!connector) return null;
  return (
    <NuphyModal
      open={connector !== null}
      title={`Disconnect ${connector.name}?`}
      onClose={onClose}
      maxWidth="max-w-sm"
      footer={
        <div className="flex items-center justify-between gap-3">
          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <NuphyButton
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </NuphyButton>
            <NuphyButton
              variant="destructive"
              size="sm"
              disabled={
                busy ||
                (needsChoice && (choices === null || selectedId.length === 0))
              }
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const message = await onConfirm(
                      needsChoice ? selectedId : null,
                    );
                    if (message) setError(message);
                    else onClose();
                  } catch (cause) {
                    // error-policy:J4 unexpected boundary failure remains visible in the open dialog.
                    setError(
                      apiErrorMessage(cause, "Failed to disconnect connector."),
                    );
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              {" "}
              {busy ? "Disconnecting…" : "Disconnect"}{" "}
            </NuphyButton>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-[14px] leading-5 text-muted-foreground">
          This will remove the {connector.name} connection from your agent. You
          can reconnect later.
        </p>
        {needsChoice && (
          <NuphyFormField
            label="Connection"
            description="Exactly this connection will be disconnected."
            htmlFor="disconnect-connection"
          >
            <select
              id="disconnect-connection"
              className="w-full rounded-md border border-[var(--hairline)] bg-[var(--surface)] px-3 py-2 text-[14px] text-[var(--foreground)]"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              disabled={busy || choices === null}
            >
              <option value="" disabled>
                {choices === null
                  ? "Loading connections…"
                  : choices.length === 0
                    ? "No connections found"
                    : "Choose a connection"}
              </option>
              {(choices ?? []).map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                  {choice.active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </NuphyFormField>
        )}
      </div>
    </NuphyModal>
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
    if (!description.trim()) {
      setError("Description is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/v1/mcps", {
        method: "POST",
        json: buildMcpCreatePayload({ name, slug, endpointUrl, description }),
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
        <NuphyFormField
          label="Description"
          description="Required. Shown wherever this MCP server is listed."
          htmlFor="mcp-desc"
        >
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
  onConfirm: () => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!mcp) return null;
  return (
    <NuphyModal
      open={mcp !== null}
      title={`Remove ${mcp.name}?`}
      onClose={onClose}
      maxWidth="max-w-sm"
      footer={
        <div className="flex items-center justify-between gap-3">
          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <NuphyButton
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </NuphyButton>
            <NuphyButton
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const message = await onConfirm();
                    if (message) setError(message);
                    else onClose();
                  } catch (cause) {
                    // error-policy:J4 unexpected boundary failure remains visible in the open dialog.
                    setError(
                      apiErrorMessage(cause, "Failed to remove MCP server."),
                    );
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              {" "}
              {busy ? "Removing…" : "Remove"}{" "}
            </NuphyButton>
          </div>
        </div>
      }
    >
      <p className="text-[14px] leading-5 text-muted-foreground">
        This will remove the MCP server from your agent. You can add it again
        later.
      </p>
    </NuphyModal>
  );
}

// ── MCP list hook ───────────────────────────────────────────────────────

function useMcpServers() {
  const [servers, setServers] = useState<McpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMcps = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{
        mcps?: Array<{ id: string; name: string; status?: string }>;
      }>("/api/v1/mcps");
      setServers(
        (data.mcps ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          configured: true,
          statusText: m.status ?? "Active",
        })),
      );
      setError(null);
    } catch (cause) {
      // error-policy:J4 preserve the last authoritative list and expose refresh failure.
      setError(apiErrorMessage(cause, "Failed to load MCP servers."));
      throw cause;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMcps().catch(() => {
      // error-policy:J5 the same rejection is represented by the hook's visible error state.
    });
  }, [fetchMcps]);

  return { servers, loading, error, refetch: fetchMcps };
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
  refreshVersion,
  onConnect,
  onDisconnect,
}: {
  title: string;
  connectors: ConnectorConfig[];
  footer: string;
  refreshVersion: number;
  onConnect: (c: ConnectorConfig) => void;
  onDisconnect: (c: ConnectorConfig) => void;
}) {
  return (
    <SettingsGroup title={title} footer={footer}>
      {connectors.map((connector) => (
        <ConnectorRow
          key={connector.id}
          connector={connector}
          refreshVersion={refreshVersion}
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
  const [connectTarget, setConnectTarget] = useState<ConnectorConfig | null>(
    null,
  );
  const [disconnectTarget, setDisconnectTarget] =
    useState<ConnectorConfig | null>(null);
  const [connectorRefreshVersion, setConnectorRefreshVersion] = useState(0);
  const [mcpAddOpen, setMcpAddOpen] = useState(false);
  const [mcpRemoveTarget, setMcpRemoveTarget] = useState<McpEntry | null>(null);
  const {
    servers: mcpServers,
    loading: mcpLoading,
    error: mcpError,
    refetch: refetchMcps,
  } = useMcpServers();

  // Disconnect handler — calls the connector's DELETE endpoint. Connectors
  // with multiple linked identities (OAuth accounts, Discord bots) receive the
  // explicit connection id chosen in the dialog; a missing id aborts rather
  // than revoking an arbitrary record.
  const handleDisconnectConfirm = useCallback(
    async (connectionId: string | null): Promise<string | null> => {
      if (!disconnectTarget) return "No connector was selected.";
      try {
        if (connectorRequiresConnectionChoice(disconnectTarget)) {
          if (!connectionId) {
            return `Choose which ${disconnectTarget.name} connection to disconnect.`;
          }
          await apiFetch(`${disconnectTarget.disconnectPath}/${connectionId}`, {
            method: "DELETE",
          });
        } else {
          await api(disconnectTarget.disconnectPath, { method: "DELETE" });
        }
        setConnectorRefreshVersion((version) => version + 1);
        return null;
      } catch (error) {
        // error-policy:J4 mutation failure stays visible while an authoritative refetch reconciles the row.
        setConnectorRefreshVersion((version) => version + 1);
        return apiErrorMessage(
          error,
          `Failed to disconnect ${disconnectTarget.name}.`,
        );
      }
    },
    [disconnectTarget],
  );

  // MCP remove handler.
  const handleMcpRemoveConfirm = useCallback(async (): Promise<
    string | null
  > => {
    if (!mcpRemoveTarget) return "No MCP server was selected.";
    try {
      await apiFetch(`/api/v1/mcps/${mcpRemoveTarget.id}`, {
        method: "DELETE",
      });
    } catch (error) {
      // error-policy:J4 mutation failure stays visible while an authoritative refetch reconciles the list.
      try {
        await refetchMcps();
      } catch {
        // error-policy:J4 reconciliation failure does not replace the actionable mutation error.
      }
      return apiErrorMessage(
        error,
        `Failed to remove ${mcpRemoveTarget.name}.`,
      );
    }
    try {
      await refetchMcps();
      return null;
    } catch {
      // error-policy:J4 deletion completed, but the list remains visibly unavailable until retry.
      return `${mcpRemoveTarget.name} was removed, but the MCP list could not be refreshed.`;
    }
  }, [mcpRemoveTarget, refetchMcps]);

  if (!cloudConnected && !hasCloudManagementCredential()) {
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
        refreshVersion={connectorRefreshVersion}
        footer="Link Eliza to messaging channels for two-way conversation."
        onConnect={setConnectTarget}
        onDisconnect={setDisconnectTarget}
      />
      <ConnectorGroup
        title="Productivity"
        connectors={PRODUCTIVITY}
        refreshVersion={connectorRefreshVersion}
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
        {mcpError ? (
          <NuphyRow
            label="MCP servers unavailable"
            description={mcpError}
            control={
              <NuphyButton
                variant="secondary"
                size="sm"
                onClick={() => {
                  void refetchMcps().catch(() => {
                    // error-policy:J5 the hook exposes the same rejection in mcpError.
                  });
                }}
              >
                Retry
              </NuphyButton>
            }
          />
        ) : mcpLoading ? (
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
          setConnectorRefreshVersion((version) => version + 1);
        }}
      />
      <DisconnectDialog
        key={disconnectTarget?.id ?? "closed"}
        connector={disconnectTarget}
        onClose={() => setDisconnectTarget(null)}
        onConfirm={handleDisconnectConfirm}
      />
      <McpAddModal
        open={mcpAddOpen}
        onClose={() => setMcpAddOpen(false)}
        onSuccess={() => {
          setMcpAddOpen(false);
          void refetchMcps().catch(() => {
            // error-policy:J5 the same rejection is represented by the hook's visible error state.
          });
        }}
      />
      <McpRemoveDialog
        key={mcpRemoveTarget?.id ?? "closed"}
        mcp={mcpRemoveTarget}
        onClose={() => setMcpRemoveTarget(null)}
        onConfirm={handleMcpRemoveConfirm}
      />
    </SettingsStack>
  );
}
