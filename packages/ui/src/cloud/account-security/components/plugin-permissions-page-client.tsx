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
import {
  BrandButton,
  BrandCard,
  CornerBrackets,
  DashboardPageContainer,
  useSetPageHeader,
} from "../../../cloud-ui";
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
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div className="relative z-10 space-y-4">
          <div className="flex items-center gap-2">
            <Puzzle className="h-5 w-5 text-[var(--brand-orange)]" />
            <h3 className="text-lg font-bold text-txt-strong">Active grants</h3>
          </div>
          {state.kind === "loading" ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : state.kind === "missing" ? (
            <p className="text-sm text-muted">
              Plugin grant tracking isn't exposed yet on this server. Grants
              made from the desktop app will appear here once the backend is
              wired.
            </p>
          ) : state.kind === "error" ? (
            <p className="text-sm text-red-300">{state.message}</p>
          ) : state.grants.length === 0 ? (
            <p className="text-sm text-muted">
              No plugin has any permission granted on your account.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {state.grants.map((g) => (
                <li
                  key={g.grant_id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <div className="space-y-0.5">
                    <p className="font-medium text-txt-strong">
                      {g.plugin_name ?? g.plugin_id}{" "}
                      <span className="ml-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-txt">
                        {g.permission}
                      </span>
                    </p>
                    <p className="font-mono text-[11px] text-muted">
                      {g.scope ? `scope: ${g.scope} · ` : ""}granted{" "}
                      {new Date(g.granted_at).toLocaleString()}
                      {g.last_used
                        ? ` · last used ${new Date(g.last_used).toLocaleString()}`
                        : ""}
                    </p>
                  </div>
                  <BrandButton
                    size="sm"
                    variant="outline"
                    disabled={revoking === g.grant_id}
                    onClick={() => void revoke(g)}
                    data-testid={`revoke-${g.grant_id}`}
                  >
                    {revoking === g.grant_id ? "Revoking…" : "Revoke"}
                  </BrandButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </BrandCard>
    </DashboardPageContainer>
  );
}
