/**
 * Plugin permissions: every permission granted to a plugin, with revoke control.
 *   GET    /api/v1/me/plugin-grants
 *   DELETE /api/v1/me/plugin-grants/:grantId
 *
 * Keeps the 404-graceful "not exposed yet on this server" pattern.
 */

import { Puzzle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DashboardPageContainer, useSetPageHeader } from "../../../cloud-ui";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ApiError, api, apiFetch } from "../../lib/api-client";
import { emitAuditEvent } from "../data/audit-client";

interface PluginGrant {
  grant_id: string;
  plugin_id: string;
  plugin_name?: string | null;
  permission: string;
  scope?: string | null;
  granted_at: string;
  last_used?: string | null;
}

interface PluginGrantsResponse {
  grants: PluginGrant[];
}

type GrantsState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; grants: PluginGrant[] }
  | { kind: "error"; message: string };

export function PluginPermissionsPageClient() {
  useSetPageHeader({
    title: "Plugin permissions",
    description: "Every permission granted to a plugin, with revoke control.",
  });

  const [state, setState] = useState<GrantsState>({ kind: "loading" });
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = async () => {
    setState({ kind: "loading" });
    try {
      const data = await api<PluginGrantsResponse>("/api/v1/me/plugin-grants");
      setState({ kind: "ready", grants: data.grants ?? [] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setState({ kind: "missing" });
        return;
      }
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: load is stable scope function; running on mount only is intentional
  useEffect(() => {
    void load();
  }, []);

  const revoke = async (g: PluginGrant) => {
    setRevoking(g.grant_id);
    try {
      await apiFetch(
        `/api/v1/me/plugin-grants/${encodeURIComponent(g.grant_id)}`,
        { method: "DELETE" },
      );
      await emitAuditEvent({
        action: "plugin.revoke",
        result: "allow",
        resource: { type: "plugin", id: g.plugin_id },
        metadata: {
          grant_id: g.grant_id,
          permission: g.permission,
          reason: "user.revoke",
        },
      });
      toast.success(
        `Revoked ${g.permission} for ${g.plugin_name ?? g.plugin_id}`,
      );
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Revoke failed: ${message}`);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <DashboardPageContainer>
      <SettingsStack data-testid="cloud-plugin-grants">
        <SettingsGroup title="Active grants">
          {state.kind === "loading" ? (
            <SettingsRow label="Loading…" />
          ) : state.kind === "missing" ? (
            <SettingsRow label="Plugin grant tracking isn't exposed yet on this server. Grants made from the desktop app will appear here once the backend is wired." />
          ) : state.kind === "error" ? (
            <SettingsRow tone="danger" label={state.message} />
          ) : state.grants.length === 0 ? (
            <SettingsRow label="No plugin has any permission granted on your account." />
          ) : (
            state.grants.map((g) => (
              <SettingsRow
                key={g.grant_id}
                icon={Puzzle}
                label={
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span>{g.plugin_name ?? g.plugin_id}</span>
                    <Badge asChild variant="permissionCode">
                      <span>{g.permission}</span>
                    </Badge>
                  </span>
                }
                description={`${g.scope ? `scope: ${g.scope} · ` : ""}granted ${new Date(g.granted_at).toLocaleString()}${
                  g.last_used
                    ? ` · last used ${new Date(g.last_used).toLocaleString()}`
                    : ""
                }`}
                control={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={revoking === g.grant_id}
                    onClick={() => void revoke(g)}
                    data-testid={`revoke-${g.grant_id}`}
                  >
                    {revoking === g.grant_id ? "Revoking…" : "Revoke"}
                  </Button>
                }
              />
            ))
          )}
        </SettingsGroup>
      </SettingsStack>
    </DashboardPageContainer>
  );
}
