import { BrandCard, CornerBrackets } from "@elizaos/ui";
import { useEffect, useState } from "react";
import { AuditEventList, type AuditEventRow } from "@/components/security";
import { ApiError, api } from "@/lib/api-client";

interface AuditEventsResponse {
  events: AuditEventRow[];
}

export function RecentAuditEvents() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "missing" }
    | { kind: "ready"; events: AuditEventRow[] }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<AuditEventsResponse>(
          "/api/v1/me/audit-events?limit=50",
        );
        if (cancelled) return;
        setState({ kind: "ready", events: data.events ?? [] });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setState({ kind: "missing" });
          return;
        }
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-3">
        <div>
          <h3 className="text-lg font-bold text-white">
            Recent security events
          </h3>
          <p className="text-sm text-white/60">
            Last 50 audit events recorded against your account.
          </p>
        </div>
        {state.kind === "loading" ? (
          <p className="text-sm text-white/50">Loading…</p>
        ) : state.kind === "missing" ? (
          <p className="text-sm text-white/50">
            Audit log isn't exposed yet on this server.
          </p>
        ) : state.kind === "error" ? (
          <p className="text-sm text-red-300">{state.message}</p>
        ) : (
          <AuditEventList events={state.events} />
        )}
      </div>
    </BrandCard>
  );
}
