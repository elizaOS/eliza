/**
 * Recent security events. The Worker currently exposes POST-only audit
 * ingestion, not a user-readable audit-event list, so render the explicit
 * unavailable state without issuing a dead account-audit request.
 */

import { useState } from "react";
import { BrandCard, CornerBrackets } from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { AuditEventList, type AuditEventRow } from "./AuditEventList";

type AuditState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; events: AuditEventRow[] }
  | { kind: "error"; message: string };

export function RecentAuditEvents() {
  const t = useCloudT();
  const [state] = useState<AuditState>({ kind: "missing" });

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-3">
        <div>
          <h3 className="text-lg font-bold text-white">
            {t("cloud.recentAuditEvents.title", {
              defaultValue: "Recent security events",
            })}
          </h3>
          <p className="text-sm text-white/60">
            {t("cloud.recentAuditEvents.subtitle", {
              defaultValue:
                "Last 50 audit events recorded against your account.",
            })}
          </p>
        </div>
        {state.kind === "loading" ? (
          <p className="text-sm text-white/50">
            {t("cloud.recentAuditEvents.loading", { defaultValue: "Loading…" })}
          </p>
        ) : state.kind === "missing" ? (
          <p className="text-sm text-white/50">
            {t("cloud.recentAuditEvents.notExposed", {
              defaultValue: "Audit log isn't exposed yet on this server.",
            })}
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
