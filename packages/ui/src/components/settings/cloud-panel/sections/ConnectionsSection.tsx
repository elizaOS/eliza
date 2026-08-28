/**
 * Connections section for the cloud-only settings panel.
 *
 * Consolidated view of the cloud-hosted connectors (grouped by category) plus
 * configured MCP servers. Each connector's Connect/Disconnect flow is handled
 * inline through the shared settings modals — token-credential connectors show a form,
 * OAuth-redirect connectors initiate the redirect, and destructive actions
 * confirm before executing. MCP servers are created/removed through a modal
 * form that posts to the real `/api/v1/mcps` CRUD routes.
 *
 * Authority: the backend is authoritative for connector state. The renderer
 * caches status, updates optimistically on connect/disconnect, and refetches
 * to reconcile.
 */

import { Loader2, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, apiFetch } from "../../../../cloud/lib/api-client";
import { useCloudConnectorConnections } from "../../../../hooks/useCloudConnectorConnections";
import { useAppSelector } from "../../../../state";
import { openExternalUrl } from "../../../../utils/openExternalUrl";
import { Button } from "../../../ui/button";
import { FormSelect, FormSelectItem } from "../../../ui/form-select";
import { Input } from "../../../ui/input";
import {
  buildMcpCreatePayload,
  CLOUD_CONNECTORS,
  type ConnectorConfig,
  connectorFieldValidationError,
  connectorMutationSucceeded,
} from "../cloud-connector-contracts";
import { hasCloudManagementCredential } from "../cloud-management-auth";
import {
  CloudFormField,
  CloudModal,
  CloudRow,
  DestructiveSecondaryButton,
  SettingsGroup,
  SettingsStack,
} from "../cloud-settings-primitives";

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
    <CloudRow
      label={connector.name}
      description={
        state.loading ? "Checking status…" : (state.error ?? state.statusText)
      }
      control={
        state.loading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : state.connected ? (
          <DestructiveSecondaryButton
            size="sm"
            onClick={() => onDisconnect(connector)}
          >
            Disconnect
          </DestructiveSecondaryButton>
        ) : state.error ? (
          <Button variant="outline" size="sm" disabled>
            Unavailable
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onConnect(connector)}
          >
            Connect
          </Button>
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
    <CloudModal
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
            <p className="text-sm-tight text-destructive">{error}</p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={busy}
              onClick={() => void handleConnect()}
            >
              {busy ? (
                <>
                  <Loader2 className="mr-1.5  size-3.5 animate-spin" />
                  Connecting…
                </>
              ) : connector.authMode === "oauth" ? (
                `Authorize with ${connector.name}`
              ) : (
                "Connect"
              )}
            </Button>
          </div>
        </div>
      }
    >
      {connector.authMode === "token" && connector.fields ? (
        <div className="space-y-4">
          {connector.fields.map((field) => (
            <CloudFormField
              key={field.key}
              label={field.label}
              description={field.description}
              htmlFor={`field-${field.key}`}
            >
              <Input
                id={`field-${field.key}`}
                type={field.type ?? "text"}
                value={fieldValues[field.key] ?? ""}
                onChange={(event) =>
                  setFieldValues((prev) => ({
                    ...prev,
                    [field.key]: event.target.value,
                  }))
                }
                placeholder={field.placeholder}
                disabled={busy}
                autoComplete="off"
                variant="form"
              />
            </CloudFormField>
          ))}
          {connector.id === "discord" && (
            <CloudFormField
              label="Agent"
              description="The agent this Discord bot responds as."
              htmlFor="connect-agent"
            >
              <FormSelect
                aria-label="Agent"
                placeholder={
                  agentChoices === null
                    ? "Loading agents…"
                    : agentChoices.length === 0
                      ? "No agents available"
                      : "Choose an agent"
                }
                value={selectedAgentId}
                onValueChange={setSelectedAgentId}
                disabled={busy || agentChoices === null}
                triggerClassName="h-9 rounded-sm px-3 text-sm"
              >
                {(agentChoices ?? []).map((choice) => (
                  <FormSelectItem key={choice.id} value={choice.id}>
                    {choice.name}
                  </FormSelectItem>
                ))}
              </FormSelect>
            </CloudFormField>
          )}
        </div>
      ) : (
        <p className="text-sm leading-5 text-muted-foreground">
          Click <strong>Authorize</strong> to open {connector.name}'s login
          page. After authorizing, you'll return here automatically.
        </p>
      )}
    </CloudModal>
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
    <CloudModal
      open={connector !== null}
      title={`Disconnect ${connector.name}?`}
      onClose={onClose}
      maxWidth="max-w-sm"
      footer={
        <div className="flex items-center justify-between gap-3">
          {error ? (
            <p role="alert" className="text-sm-tight text-destructive">
              {error}
            </p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
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
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm leading-5 text-muted-foreground">
          This will remove the {connector.name} connection from your agent. You
          can reconnect later.
        </p>
        {needsChoice && (
          <CloudFormField
            label="Connection"
            description="Exactly this connection will be disconnected."
            htmlFor="disconnect-connection"
          >
            <FormSelect
              aria-label="Connection"
              placeholder={
                choices === null
                  ? "Loading connections…"
                  : choices.length === 0
                    ? "No connections found"
                    : "Choose a connection"
              }
              value={selectedId}
              onValueChange={setSelectedId}
              disabled={busy || choices === null}
              triggerClassName="h-9 rounded-sm px-3 text-sm"
            >
              {(choices ?? []).map((choice) => (
                <FormSelectItem key={choice.id} value={choice.id}>
                  {choice.active ? choice.label : `${choice.label} (inactive)`}
                </FormSelectItem>
              ))}
            </FormSelect>
          </CloudFormField>
        )}
      </div>
    </CloudModal>
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
    <CloudModal
      open={open}
      title="Add MCP Server"
      description="Configure a new Model Context Protocol server for this agent."
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between">
          {error ? (
            <p className="text-sm-tight text-destructive">{error}</p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={busy}
              onClick={() => void handleAdd()}
            >
              {busy ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Adding…
                </>
              ) : (
                "Add server"
              )}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <CloudFormField label="Name" htmlFor="mcp-name">
          <Input
            id="mcp-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My MCP Server"
            disabled={busy}
            variant="form"
          />
        </CloudFormField>
        <CloudFormField
          label="Slug"
          description="URL-safe identifier. Auto-generated from name if left blank."
          htmlFor="mcp-slug"
        >
          <Input
            id="mcp-slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="my-mcp-server"
            disabled={busy}
            variant="form"
          />
        </CloudFormField>
        <CloudFormField
          label="Endpoint URL"
          description="The MCP server's HTTP/SSE endpoint."
          htmlFor="mcp-url"
        >
          <Input
            id="mcp-url"
            value={endpointUrl}
            onChange={(event) => setEndpointUrl(event.target.value)}
            placeholder="https://my-mcp-server.example.com/sse"
            disabled={busy}
            variant="form"
          />
        </CloudFormField>
        <CloudFormField
          label="Description"
          description="Required. Shown wherever this MCP server is listed."
          htmlFor="mcp-desc"
        >
          <Input
            id="mcp-desc"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What does this MCP server provide?"
            disabled={busy}
            variant="form"
          />
        </CloudFormField>
      </div>
    </CloudModal>
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
    <CloudModal
      open={mcp !== null}
      title={`Remove ${mcp.name}?`}
      onClose={onClose}
      maxWidth="max-w-sm"
      footer={
        <div className="flex items-center justify-between gap-3">
          {error ? (
            <p role="alert" className="text-sm-tight text-destructive">
              {error}
            </p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
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
            </Button>
          </div>
        </div>
      }
    >
      <p className="text-sm leading-5 text-muted-foreground">
        This will remove the MCP server from your agent. You can add it again
        later.
      </p>
    </CloudModal>
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
    <CloudRow
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
      <CloudRow label="No cloud connection" />
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
        <CloudRow
          label="Add MCP Server"
          description="Configure a new MCP server for this agent."
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMcpAddOpen(true)}
            >
              <Plus aria-hidden />
              Add
            </Button>
          }
        />
        {mcpError ? (
          <CloudRow
            label="MCP servers unavailable"
            description={mcpError}
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void refetchMcps().catch(() => {
                    // error-policy:J5 the hook exposes the same rejection in mcpError.
                  });
                }}
              >
                Retry
              </Button>
            }
          />
        ) : mcpLoading ? (
          <CloudRow label="Loading MCP servers…" />
        ) : mcpServers.length === 0 ? (
          <CloudRow
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
