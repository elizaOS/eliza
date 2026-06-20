/**
 * Presentational coding-accounts + per-room roster view for the orchestrator
 * sidebar widget. Props-driven and free of any data-layer (`client`) import, so
 * it bundles for the browser and renders in Storybook / the screenshot harness
 * across every state. The fetching container lives in `agent-orchestrator.tsx`.
 */
import { Workflow, Zap } from "lucide-react";
import { useMemo } from "react";
import type {
  AccountsListResponse,
  AccountWithCredentialFlag,
} from "../../../api/client-agent";
import type {
  OrchestratorAccountOverview,
  OrchestratorRoomRosterOverview,
} from "../../../api/client-types-cloud";
import type { TranslateFn } from "../../../types";
import { Button } from "../../ui/button";
import { EmptyWidgetState, WidgetSection } from "./shared";

export const fallbackTranslate: TranslateFn = (key, vars) => {
  const template =
    typeof vars?.defaultValue === "string" ? vars.defaultValue : key;
  // Interpolate {{var}} placeholders from the provided vars — without this the
  // no-i18n fallback renders raw "{{count}} agents" when no real `t` is wired.
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const v = (vars as Record<string, unknown> | undefined)?.[name];
    return v === undefined ? whole : String(v);
  });
};

function usageTone(pct: number | undefined): string {
  if (pct === undefined) return "bg-muted/40";
  if (pct >= 85) return "bg-destructive";
  if (pct >= 60) return "bg-warn";
  return "bg-ok";
}

function UsageBar({ label, pct }: { label: string; pct?: number }) {
  if (pct === undefined) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-9 shrink-0 text-3xs uppercase tracking-wide text-muted/70">
        {label}
      </span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted/20">
        <div
          className={`h-full rounded-full ${usageTone(pct)}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="w-7 shrink-0 text-right text-3xs tabular-nums text-muted">
        {clamped}%
      </span>
    </div>
  );
}

const HEALTH_TONE: Record<string, string> = {
  ok: "bg-ok",
  "rate-limited": "bg-warn",
  "needs-reauth": "bg-destructive",
  invalid: "bg-destructive",
  unknown: "bg-muted/50",
};

export interface OrchestratorAccountsViewProps {
  accounts: AccountsListResponse | null;
  overview: OrchestratorAccountOverview | null;
  rooms: OrchestratorRoomRosterOverview | null;
  t?: TranslateFn;
  onConnect?: () => void;
}

export function OrchestratorAccountsView({
  accounts,
  overview,
  rooms,
  t = fallbackTranslate,
  onConnect,
}: OrchestratorAccountsViewProps) {
  const flatAccounts = useMemo<AccountWithCredentialFlag[]>(
    () =>
      (accounts?.providers ?? []).flatMap((provider) =>
        provider.accounts.map((account) => ({ ...account })),
      ),
    [accounts],
  );
  const activeAssignments = useMemo(
    () => (overview?.assignments ?? []).filter((a) => a.active),
    [overview],
  );
  const assignmentCountByAccount = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of activeAssignments) {
      map.set(a.accountId, (map.get(a.accountId) ?? 0) + 1);
    }
    return map;
  }, [activeAssignments]);
  // Rooms with at least one live sub-agent — the per-room participant roster.
  const activeRooms = useMemo(
    () => (rooms?.rooms ?? []).filter((r) => r.activeAgentCount > 0),
    [rooms],
  );

  const connectAction = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-2xs"
      onClick={onConnect}
    >
      {t("agentorchestrator.connectAccounts", { defaultValue: "Connect" })}
    </Button>
  );

  if (flatAccounts.length === 0) {
    return (
      <WidgetSection
        title={t("agentorchestrator.accounts", {
          defaultValue: "Coding accounts",
        })}
        icon={<Zap className="h-4 w-4" />}
        action={connectAction}
        testId="chat-widget-accounts"
      >
        <EmptyWidgetState
          icon={<Zap className="h-5 w-5" />}
          title={t("agentorchestrator.noAccounts", {
            defaultValue: "No coding subscriptions connected.",
          })}
          description={t("agentorchestrator.noAccountsHint", {
            defaultValue:
              "Add Claude / Codex / z.ai accounts in Settings to round-robin sub-agents.",
          })}
        />
      </WidgetSection>
    );
  }

  return (
    <WidgetSection
      title={t("agentorchestrator.accounts", {
        defaultValue: "Coding accounts",
      })}
      icon={<Zap className="h-4 w-4" />}
      action={connectAction}
      testId="chat-widget-accounts"
    >
      <div className="space-y-2.5">
        <div className="flex items-center justify-between text-3xs text-muted/70">
          <span>
            {t("agentorchestrator.strategy", { defaultValue: "Strategy" })}
          </span>
          <span className="rounded-full bg-muted/15 px-1.5 py-0.5 font-medium text-muted">
            {overview?.strategy ?? "least-used"}
          </span>
        </div>
        {Object.keys(overview?.availability ?? {}).length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {Object.entries(overview?.availability ?? {}).map(
              ([agentType, providers]) => {
                const healthy = providers.reduce((n, p) => n + p.healthy, 0);
                const enabled = providers.reduce((n, p) => n + p.enabled, 0);
                if (enabled === 0) return null;
                return (
                  <span
                    key={agentType}
                    className="rounded-full bg-muted/10 px-1.5 py-0.5 text-3xs text-muted"
                    title={t("agentorchestrator.availabilityHint", {
                      defaultValue:
                        "{{healthy}} healthy of {{enabled}} enabled",
                      healthy,
                      enabled,
                    })}
                  >
                    {agentType} · {healthy}/{enabled}
                  </span>
                );
              },
            )}
          </div>
        ) : null}
        {flatAccounts.map((account) => {
          const inUse = assignmentCountByAccount.get(account.id) ?? 0;
          return (
            <div
              key={`${account.providerId}:${account.id}`}
              className="space-y-1"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${HEALTH_TONE[account.health] ?? HEALTH_TONE.unknown}`}
                />
                <span className="truncate font-medium text-txt">
                  {account.label}
                </span>
                <span className="truncate text-3xs text-muted/60">
                  {account.providerId}
                </span>
                {inUse > 0 ? (
                  <span className="ml-auto shrink-0 rounded-full bg-ok/15 px-1.5 py-0.5 text-3xs text-ok">
                    {t("agentorchestrator.inUse", {
                      defaultValue: "{{count}} active",
                      count: inUse,
                    })}
                  </span>
                ) : null}
              </div>
              <UsageBar
                label={t("agentorchestrator.session", { defaultValue: "5h" })}
                pct={account.usage?.sessionPct}
              />
              <UsageBar
                label={t("agentorchestrator.weekly", { defaultValue: "7d" })}
                pct={account.usage?.weeklyPct}
              />
            </div>
          );
        })}
        {activeRooms.length > 0 ? (
          <div
            className="space-y-1.5 border-t border-border/40 pt-1.5"
            data-testid="orchestrator-room-roster"
          >
            <div className="text-3xs font-medium uppercase tracking-wide text-muted/60">
              {t("agentorchestrator.taskRooms", { defaultValue: "Task rooms" })}
            </div>
            {activeRooms.map((room) => (
              <div key={room.taskId} className="space-y-0.5">
                <div className="flex items-center gap-1 text-3xs text-muted">
                  <span className="truncate font-medium text-txt">
                    {room.taskTitle}
                  </span>
                  {room.multiParty ? (
                    <span className="ml-auto shrink-0 rounded-full bg-muted/15 px-1.5 py-0.5 text-3xs text-muted">
                      {t("agentorchestrator.multiParty", {
                        defaultValue: "{{count}} agents",
                        count: room.activeAgentCount,
                      })}
                    </span>
                  ) : null}
                </div>
                {room.participants.map((p) => (
                  <div
                    key={`${room.taskId}:${p.kind}:${p.id}`}
                    className="flex items-center gap-1 pl-1 text-3xs text-muted"
                  >
                    <Workflow className="h-3 w-3 shrink-0 text-muted/60" />
                    <span className="truncate font-medium text-txt">
                      {p.label}
                    </span>
                    {p.accountLabel ? (
                      <>
                        <span className="shrink-0 text-muted/50">→</span>
                        <span className="truncate">{p.accountLabel}</span>
                      </>
                    ) : null}
                    {typeof p.totalTokens === "number" && p.totalTokens > 0 ? (
                      <span className="ml-auto shrink-0 tabular-nums text-muted/60">
                        {Math.round(p.totalTokens / 1000)}k
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : activeAssignments.length > 0 ? (
          <div className="space-y-0.5 border-t border-border/40 pt-1.5">
            {activeAssignments.map((a) => (
              <div
                key={a.sessionId}
                className="flex items-center gap-1 text-3xs text-muted"
              >
                <Workflow className="h-3 w-3 shrink-0 text-muted/60" />
                <span className="truncate font-medium text-txt">{a.label}</span>
                <span className="shrink-0 text-muted/50">→</span>
                <span className="truncate">{a.accountLabel}</span>
                <span className="ml-auto shrink-0 tabular-nums text-muted/60">
                  {Math.round(a.totalTokens / 1000)}k
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </WidgetSection>
  );
}
