/**
 * Account-health panel for the orchestrator workbench (#9960).
 *
 * The multi-account pool's per-account health (ok / rate-limited / needs-reauth
 * / invalid), live sub-agent → account assignments, and per-room roster already
 * render in the presentational `OrchestratorAccountsView` — but it was surfaced
 * only in the chat sidebar, never in the orchestrator view itself. This panel
 * wires that view into the workbench and adds the pool-readiness verdict
 * (`GET /api/orchestrator/accounts/readiness`) on top, so a degraded pool is
 * visible where the operator manages tasks instead of silently degrading to a
 * single account. A connect-accounts entry point routes to Settings.
 *
 * Data-fetch only; all derived values come from server DTOs (readiness verdict,
 * availability, assignments) — the panel displays, it does not compute.
 */

import { client } from "@elizaos/ui";
import { OrchestratorAccountsView } from "@elizaos/ui/components";
import { CircleAlert, CircleCheck } from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useState } from "react";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

// Derive the data-shape types from the consuming component + the client methods
// so this panel never depends on whether a given DTO is re-exported from the
// `@elizaos/ui` barrel (AccountsListResponse, e.g., is not).
type AccountsViewProps = ComponentProps<typeof OrchestratorAccountsView>;
type AccountsListResponse = AccountsViewProps["accounts"];
type OrchestratorAccountOverview = AccountsViewProps["overview"];
type OrchestratorRoomRosterOverview = AccountsViewProps["rooms"];
type OrchestratorAccountReadiness = Awaited<
  ReturnType<typeof client.getOrchestratorAccountReadiness>
>;

export interface OrchestratorAccountHealthPanelProps {
  t?: Translate;
  /** Invoked by the connect-accounts entry point (route to Settings). */
  onConnect?: () => void;
}

const fallbackTranslate: Translate = (key, vars) =>
  typeof vars?.defaultValue === "string" ? vars.defaultValue : key;

/** Server-owned readiness verdict, rendered verbatim (no client computation). */
function ReadinessBanner({
  readiness,
  t,
}: {
  readiness: OrchestratorAccountReadiness;
  t: Translate;
}) {
  const ready = readiness.ready;
  return (
    <div
      className={`flex items-start gap-2 rounded-md px-3 py-2 text-2xs ${
        ready ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"
      }`}
      data-testid="orchestrator-account-readiness"
      data-ready={ready ? "true" : "false"}
    >
      {ready ? (
        <CircleCheck className="mt-px h-3.5 w-3.5 shrink-0" />
      ) : (
        <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
      )}
      <div className="space-y-0.5">
        <div className="font-medium">
          {ready
            ? t("orchestrator.accountsReady", {
                defaultValue: `Pool ready — ${readiness.required}+ healthy per provider`,
                required: readiness.required,
              })
            : t("orchestrator.accountsNotReady", {
                defaultValue: "Account pool degraded",
              })}
        </div>
        {!ready &&
          readiness.problems.map((p) => (
            <div key={p} className="text-warn/90">
              {p}
            </div>
          ))}
      </div>
    </div>
  );
}

export function OrchestratorAccountHealthPanel({
  t = fallbackTranslate,
  onConnect,
}: OrchestratorAccountHealthPanelProps) {
  const [accounts, setAccounts] = useState<AccountsListResponse | null>(null);
  const [overview, setOverview] = useState<OrchestratorAccountOverview | null>(
    null,
  );
  const [rooms, setRooms] = useState<OrchestratorRoomRosterOverview | null>(
    null,
  );
  const [readiness, setReadiness] =
    useState<OrchestratorAccountReadiness | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [acctRes, ovRes, roomsRes, readyRes] = await Promise.allSettled([
      client.listAccounts(),
      client.getOrchestratorAccounts(),
      client.getOrchestratorRooms(),
      client.getOrchestratorAccountReadiness(),
    ]);
    if (acctRes.status === "fulfilled") setAccounts(acctRes.value);
    if (ovRes.status === "fulfilled") setOverview(ovRes.value);
    if (roomsRes.status === "fulfilled") setRooms(roomsRes.value);
    if (readyRes.status === "fulfilled") setReadiness(readyRes.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (loading) return null;

  return (
    <div className="space-y-2" data-testid="orchestrator-account-health-panel">
      {readiness ? <ReadinessBanner readiness={readiness} t={t} /> : null}
      <OrchestratorAccountsView
        accounts={accounts}
        overview={overview}
        rooms={rooms}
        t={t}
        onConnect={onConnect}
      />
    </div>
  );
}
