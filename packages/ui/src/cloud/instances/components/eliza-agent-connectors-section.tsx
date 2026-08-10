/**
 * Agent-scoped personal Google connector access. It binds an existing vaulted
 * OAuth connection without re-authentication, can start OAuth with an atomic
 * binding request, and revokes only this agent's binding.
 */

"use client";

import type { GoogleWorkspaceMcpProduct } from "@elizaos/shared/contracts";
import { ExternalLink, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { GoogleMcpProductSelector } from "../../../components/connectors/GoogleMcpProductSelector";
import {
  DEFAULT_PERSONAL_GOOGLE_MCP_PRODUCTS,
  oauthScopesForPersonalGoogleProducts,
} from "../../../components/connectors/google-mcp-products";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ConfirmDialog } from "../../../components/ui/confirm-dialog";
import { Spinner } from "../../../components/ui/spinner";
import {
  type AgentConnectorBinding,
  createAgentConnectorBinding,
  listAgentConnectorBindings,
  revokeAgentConnectorBinding,
} from "../../connectors/agent-connector-bindings";
import {
  type OAuthConnection,
  useOAuthConnections,
} from "../../connectors/oauth-connection";
import { ApiError } from "../../lib/api-client";
import { useT } from "../lib/i18n";

function errorMessage(error: unknown, fallback: string): string {
  if (
    error instanceof ApiError &&
    error.body &&
    typeof error.body === "object"
  ) {
    const body = error.body as { error?: unknown; message?: unknown };
    if (typeof body.message === "string" && body.message) return body.message;
    if (typeof body.error === "string" && body.error) return body.error;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function connectionLabel(connection: OAuthConnection): string {
  return (
    connection.email ??
    connection.displayName ??
    connection.username ??
    connection.platformUserId
  );
}

export function ElizaAgentConnectorsSection({ agentId }: { agentId: string }) {
  const t = useT();
  const [bindings, setBindings] = useState<AgentConnectorBinding[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(true);
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<
    GoogleWorkspaceMcpProduct[]
  >([...DEFAULT_PERSONAL_GOOGLE_MCP_PRODUCTS]);
  const [savingConnectionId, setSavingConnectionId] = useState<string | null>(
    null,
  );
  const [revokeTarget, setRevokeTarget] =
    useState<AgentConnectorBinding | null>(null);
  const {
    activeConnections,
    isLoading: connectionsLoading,
    isConnecting,
    connect,
  } = useOAuthConnections({ platform: "google", label: "Google" });

  const refreshBindings = useCallback(
    async (signal?: AbortSignal) => {
      setBindingsLoading(true);
      try {
        const response = await listAgentConnectorBindings(agentId, signal);
        if (signal?.aborted) return;
        setBindings(
          response.filter((binding) => binding.provider === "google"),
        );
        setBindingsError(null);
      } catch (error) {
        if (signal?.aborted) return;
        setBindingsError(
          errorMessage(error, "Failed to load connector access."),
        );
      } finally {
        if (!signal?.aborted) setBindingsLoading(false);
      }
    },
    [agentId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshBindings(controller.signal);
    return () => controller.abort();
  }, [refreshBindings]);

  const bindingByExternalIdentity = useMemo(
    () =>
      new Map(
        bindings.flatMap((binding) => {
          const identityId = binding.externalIdentity?.id;
          return identityId ? [[identityId, binding] as const] : [];
        }),
      ),
    [bindings],
  );
  const unmatchedBindings = useMemo(() => {
    const connectedIdentityIds = new Set(
      activeConnections.map((connection) => connection.platformUserId),
    );
    return bindings.filter((binding) => {
      const identityId = binding.externalIdentity?.id;
      return !identityId || !connectedIdentityIds.has(identityId);
    });
  }, [activeConnections, bindings]);

  const bindExisting = async (
    connection: OAuthConnection,
    existingBinding?: AgentConnectorBinding,
  ) => {
    if (selectedProducts.length === 0 || savingConnectionId) return;
    setSavingConnectionId(connection.id);
    try {
      await createAgentConnectorBinding(agentId, {
        platformCredentialId: connection.id,
        provider: "google",
        role: "OWNER",
        purposes: ["automation"],
        selectedProducts,
        isDefault: existingBinding?.isDefault ?? bindings.length === 0,
      });
      toast.success(
        `Google access granted to this agent for ${connectionLabel(connection)}`,
      );
      await refreshBindings();
    } catch (error) {
      toast.error(errorMessage(error, "Failed to grant Google access."));
    } finally {
      setSavingConnectionId(null);
    }
  };

  const connectAndBind = async () => {
    if (selectedProducts.length === 0 || isConnecting) return;
    await connect({
      redirectUrl: `/dashboard/agents/${encodeURIComponent(agentId)}?tab=connectors`,
      scopes: oauthScopesForPersonalGoogleProducts(selectedProducts),
      agentBinding: {
        agentId,
        role: "OWNER",
        selectedProducts: [...selectedProducts],
        isDefault: bindings.length === 0,
      },
    });
  };

  const revoke = async () => {
    const target = revokeTarget;
    if (!target || savingConnectionId) return;
    setSavingConnectionId(target.id);
    try {
      await revokeAgentConnectorBinding(agentId, target.id);
      setRevokeTarget(null);
      toast.success("Google access removed from this agent");
      await refreshBindings();
    } catch (error) {
      toast.error(errorMessage(error, "Failed to remove Google access."));
    } finally {
      setSavingConnectionId(null);
    }
  };

  const loading = bindingsLoading || connectionsLoading;

  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="inline-block size-2 bg-accent" />
          <h2 className="font-mono text-xs-tight uppercase tracking-[0.32em] text-muted-strong">
            {t("cloud.containers.agentConnectors.googleTitle", {
              defaultValue: "Personal Google",
            })}
          </h2>
        </div>
        <p className="text-sm text-muted">
          Choose which official Google Workspace MCP products this agent may
          use. OAuth tokens stay in the vault. Gmail access is draft-only and
          never sends email.
        </p>
      </div>

      <GoogleMcpProductSelector
        selectedProducts={selectedProducts}
        onChange={setSelectedProducts}
        disabled={isConnecting || savingConnectionId !== null}
        idPrefix={`agent-${agentId}-google-mcp-product`}
      />

      {bindingsError ? (
        <div
          role="alert"
          className="border border-destructive/30 bg-destructive-subtle p-3 text-sm text-destructive"
        >
          {bindingsError}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-2"
            onClick={() => void refreshBindings()}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 border border-border bg-card p-4 text-sm text-muted">
          <Spinner className="h-4 w-4" />
          Loading Google connections and agent access...
        </div>
      ) : (
        <div className="space-y-3">
          {activeConnections.map((connection) => {
            const binding = bindingByExternalIdentity.get(
              connection.platformUserId,
            );
            const busy =
              savingConnectionId === binding?.id ||
              savingConnectionId === connection.id;
            return (
              <div
                key={connection.id}
                className="flex flex-col gap-3 border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-txt-strong">
                      {connectionLabel(connection)}
                    </p>
                    <Badge variant="outline" className="text-[10px]">
                      {binding
                        ? "Available to this agent"
                        : "Grant or rebind required"}
                    </Badge>
                  </div>
                  {binding ? (
                    <ul
                      className="flex flex-wrap gap-1.5"
                      aria-label="Allowed Google products"
                    >
                      {binding.selectedProducts.map((product) => (
                        <li key={product}>
                          <Badge
                            variant="secondary"
                            className="text-[10px] capitalize"
                          >
                            {product === "universalSearch"
                              ? "Workspace search"
                              : product}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted">
                      Existing Google connection found. Grant or rebind it to
                      this agent without signing in to Google again.
                    </p>
                  )}
                </div>
                {binding ? (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || selectedProducts.length === 0}
                      onClick={() => void bindExisting(connection, binding)}
                    >
                      {busy ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <ShieldCheck className="mr-2 h-4 w-4" />
                      )}
                      Apply selected products
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setRevokeTarget(binding)}
                      className="text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Remove agent access
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || selectedProducts.length === 0}
                    onClick={() => void bindExisting(connection)}
                    className="shrink-0"
                  >
                    {busy ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-2 h-4 w-4" />
                    )}
                    Grant or rebind selected access
                  </Button>
                )}
              </div>
            );
          })}

          {unmatchedBindings.map((binding) => (
            <div
              key={binding.id}
              className="flex flex-col gap-3 border border-warn/30 bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-medium text-txt-strong">
                  {binding.externalIdentity?.displayHandle ??
                    "Unavailable Google account"}
                </p>
                <p className="text-xs text-muted">
                  The underlying connection is unavailable. Remove this stale
                  agent access binding.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={savingConnectionId === binding.id}
                onClick={() => setRevokeTarget(binding)}
                className="shrink-0 text-destructive"
              >
                {savingConnectionId === binding.id ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 h-4 w-4" />
                )}
                Remove stale access
              </Button>
            </div>
          ))}

          <Button
            type="button"
            onClick={() => void connectAndBind()}
            disabled={isConnecting || selectedProducts.length === 0}
            className="w-full"
          >
            {isConnecting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ExternalLink className="mr-2 h-4 w-4" />
            )}
            {activeConnections.length > 0
              ? "Connect another Google account and grant access"
              : "Connect Google account and grant access"}
          </Button>
        </div>
      )}

      <p className="text-xs text-muted">
        Removing agent access does not disconnect the Google account or affect
        other agents.
      </p>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Remove Google access from this agent?"
        message="This agent will immediately lose its Google MCP actions. The Google account stays connected and other agents are unaffected."
        confirmLabel="Remove access"
        variant="danger"
        onCancel={() => {
          if (!savingConnectionId) setRevokeTarget(null);
        }}
        onConfirm={() => void revoke()}
      />
    </section>
  );
}
