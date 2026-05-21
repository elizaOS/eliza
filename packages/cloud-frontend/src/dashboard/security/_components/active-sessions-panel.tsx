import { BrandButton, BrandCard, CornerBrackets } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api, apiFetch } from "@/lib/api-client";
import { emitAuditEvent } from "@/lib/security/audit-client";

interface SessionRow {
  id: string;
  device?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  last_seen?: string | null;
  current?: boolean;
}

interface SessionsResponse {
  sessions: SessionRow[];
}

export function ActiveSessionsPanel() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "missing" }
    | { kind: "ready"; sessions: SessionRow[] }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const data = await api<SessionsResponse>("/api/v1/sessions");
      setState({ kind: "ready", sessions: data.sessions ?? [] });
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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    setRevoking(id);
    try {
      await apiFetch(`/api/v1/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      await emitAuditEvent({
        action: "auth.session.revoke",
        result: "allow",
        resource: { type: "session", id },
      });
      toast.success("Session revoked");
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to revoke session: ${message}`);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-4">
        <div>
          <h3 className="text-lg font-bold text-white">Active sessions</h3>
          <p className="text-sm text-white/60">
            Devices and browsers currently signed in to your account.
          </p>
        </div>
        {state.kind === "loading" ? (
          <p className="text-sm text-white/50">Loading sessions…</p>
        ) : state.kind === "missing" ? (
          <p className="text-sm text-white/50">
            Session listing isn't available yet on this server.
          </p>
        ) : state.kind === "error" ? (
          <p className="text-sm text-red-300">{state.message}</p>
        ) : state.sessions.length === 0 ? (
          <p className="text-sm text-white/50">
            No other active sessions found.
          </p>
        ) : (
          <ul className="divide-y divide-white/10">
            {state.sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <div className="space-y-0.5">
                  <p className="font-medium text-white">
                    {s.device ?? "Unknown device"}
                    {s.current ? (
                      <span className="ml-2 rounded-sm border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-green-300">
                        current
                      </span>
                    ) : null}
                  </p>
                  <p className="font-mono text-[11px] text-white/50">
                    {s.ip ?? "—"} · last seen{" "}
                    {s.last_seen ? new Date(s.last_seen).toLocaleString() : "—"}
                  </p>
                </div>
                <BrandButton
                  size="sm"
                  variant="outline"
                  disabled={revoking === s.id || s.current}
                  onClick={() => void revoke(s.id)}
                >
                  {revoking === s.id ? "Revoking…" : "Revoke"}
                </BrandButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </BrandCard>
  );
}
