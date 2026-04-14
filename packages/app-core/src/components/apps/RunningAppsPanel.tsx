import { Button } from "@elizaos/ui/components/ui/button";
import { useMemo } from "react";
import type { AppRunSummary, RegistryAppInfo } from "../../api";
import { useApp } from "../../state";
import { AppIdentityTile } from "./app-identity";
import { getAppOperatorSurface } from "./surfaces/registry";

const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const DOWN_STATUS_PATTERNS = [
  "disconnected",
  "failed",
  "error",
  "stale",
  "stopping",
  "stopped",
  "paused",
  "blocked",
  "offline",
  "lost",
  "missing",
  "unavailable",
];
const SESSION_READY_STATUSES = new Set([
  "running",
  "active",
  "connected",
  "ready",
  "playing",
  "live",
  "monitoring",
  "steering",
  "attached",
  "idle",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDownSessionStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return DOWN_STATUS_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isReadySessionStatus(status: string): boolean {
  return SESSION_READY_STATUSES.has(status.trim().toLowerCase());
}

export function getRunAttentionReasons(
  run: AppRunSummary,
  now: number = Date.now(),
): string[] {
  const reasons: string[] = [];
  const heartbeatAt = run.lastHeartbeatAt
    ? new Date(run.lastHeartbeatAt).getTime()
    : null;

  if (run.health.state === "offline") {
    reasons.push("Run is offline");
  } else if (run.health.state === "degraded") {
    reasons.push(run.health.message ?? "Run health is degraded");
  }

  if (run.viewerAttachment === "detached") {
    reasons.push("Viewer is detached");
  } else if (run.viewerAttachment === "unavailable") {
    reasons.push("No viewer surface is available");
  }

  if (!run.viewer?.url && run.viewerAttachment !== "unavailable") {
    reasons.push("Viewer URL is missing");
  }

  if (run.session?.canSendCommands === false) {
    reasons.push("Command bridge is unavailable");
  }

  if (
    isNonEmptyString(run.session?.status) &&
    isDownSessionStatus(run.session.status) &&
    !isReadySessionStatus(run.session.status)
  ) {
    reasons.push(`Session status is ${run.session.status}`);
  }

  if (heartbeatAt === null) {
    reasons.push("No heartbeat recorded");
  } else if (
    Number.isFinite(heartbeatAt) &&
    now - heartbeatAt > HEARTBEAT_STALE_MS
  ) {
    reasons.push("Heartbeat is stale");
  }

  if (!run.supportsBackground && run.viewerAttachment !== "attached") {
    reasons.push("Run may pause when the viewer is detached");
  }

  return Array.from(new Set(reasons));
}

function getPrimaryRecoveryLabel(
  run: AppRunSummary,
  attentionReasons: string[],
): string {
  if (run.viewer?.url) {
    if (run.viewerAttachment === "attached") return "Inspect viewer";
    return "Reattach viewer";
  }

  if (run.launchUrl) return "Open launch URL";
  if (attentionReasons.length > 0) return "Inspect run";
  return "Inspect run";
}

interface RunningAppsPanelProps {
  runs: AppRunSummary[];
  catalogApps?: RegistryAppInfo[];
  selectedRunId: string | null;
  busyRunId: string | null;
  onSelectRun: (runId: string) => void;
  onOpenRun: (run: AppRunSummary) => void;
  onDetachRun: (run: AppRunSummary) => void;
  onStopRun: (run: AppRunSummary) => void;
}

function HealthBadge({ run }: { run: AppRunSummary }) {
  const toneClass =
    run.health.state === "healthy"
      ? "border-ok/30 bg-ok/10 text-ok"
      : run.health.state === "degraded"
        ? "border-warn/30 bg-warn/10 text-warn"
        : "border-danger/30 bg-danger/10 text-danger";

  return (
    <span
      className={`inline-flex min-h-6 items-center rounded-full border px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.14em] ${toneClass}`}
    >
      {run.health.state}
    </span>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatNullableValue(value: string | null | undefined): string {
  return isNonEmptyString(value) ? value : "Unavailable";
}

function formatControls(
  controls: readonly string[] | null | undefined,
): string {
  if (!Array.isArray(controls) || controls.length === 0) return "None";
  return controls.join(", ");
}

export function RunningAppsPanel({
  runs,
  catalogApps = [],
  selectedRunId,
  busyRunId,
  onSelectRun,
  onOpenRun,
  onDetachRun,
  onStopRun,
}: RunningAppsPanelProps) {
  const { t } = useApp();
  const catalogAppByName = useMemo(
    () => new Map(catalogApps.map((app) => [app.name, app] as const)),
    [catalogApps],
  );
  const selectedRun =
    runs.find((run) => run.runId === selectedRunId) ?? runs[0] ?? null;
  const SelectedOperatorSurface = selectedRun
    ? getAppOperatorSurface(selectedRun.appName)
    : null;
  const selectedRunAttentionReasons = selectedRun
    ? getRunAttentionReasons(selectedRun)
    : [];
  const runningAttentionCount = runs.filter(
    (run) => getRunAttentionReasons(run).length > 0,
  ).length;
  const selectedRecoveryLabel = selectedRun
    ? getPrimaryRecoveryLabel(selectedRun, selectedRunAttentionReasons)
    : "Inspect run";

  if (runs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/35 bg-card/72 px-6 py-16 text-center">
        <div className="text-xs font-medium text-muted-strong">
          {t("appsview.NoActiveApps", {
            defaultValue: "No active app runs are available right now.",
          })}
        </div>
        <div className="mt-2 text-xs-tight leading-5 text-muted">
          {t("appsview.NoActiveAppsHint", {
            defaultValue:
              "Launch an app from the catalog and it will appear here as a reattachable run.",
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <div className="space-y-3">
        {runs.map((run) => {
          const isSelected = run.runId === selectedRun?.runId;
          const attentionReasons = getRunAttentionReasons(run);
          return (
            <Button
              key={run.runId}
              variant="ghost"
              className={`flex h-auto w-full flex-col items-stretch rounded-2xl border px-4 py-4 text-left shadow-sm ${
                isSelected
                  ? "border-accent/35 bg-accent/10"
                  : "border-border/35 bg-card/72 hover:border-accent/20 hover:bg-bg-hover/70"
              }`}
              onClick={() => onSelectRun(run.runId)}
            >
              <div className="flex items-start gap-3">
                <AppIdentityTile
                  app={
                    catalogAppByName.get(run.appName) ?? {
                      name: run.appName,
                      displayName: run.displayName,
                      category: "utility",
                      icon: null,
                    }
                  }
                  active
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-txt">
                      {run.displayName}
                    </span>
                    <HealthBadge run={run} />
                  </div>
                  <div className="mt-1 text-xs-tight text-muted-strong">
                    {run.status}
                  </div>
                  <div className="mt-2 line-clamp-2 text-xs-tight leading-5 text-muted">
                    {run.summary || run.health.message || "Run active"}
                  </div>
                  {attentionReasons.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className="inline-flex items-center rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.12em] text-warn">
                        Needs attention
                      </span>
                      <span className="inline-flex max-w-full items-center rounded-full border border-border/30 bg-bg-hover/70 px-2 py-0.5 text-2xs text-muted-strong">
                        <span className="truncate">{attentionReasons[0]}</span>
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            </Button>
          );
        })}
      </div>

      {selectedRun ? (
        <section className="space-y-4 rounded-[1.75rem] border border-border/35 bg-card/78 p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-accent">
                {t("appsview.ActiveNow", { defaultValue: "Active now" })}
              </div>
              <div className="mt-2 text-xl font-semibold tracking-[0.01em] text-txt">
                {selectedRun.displayName}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <HealthBadge run={selectedRun} />
                <span className="inline-flex min-h-6 items-center rounded-full border border-border/35 bg-bg-hover/70 px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.14em] text-muted-strong">
                  {selectedRun.viewerAttachment}
                </span>
                <span className="inline-flex min-h-6 items-center rounded-full border border-border/35 bg-bg-hover/70 px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.14em] text-muted-strong">
                  {selectedRun.status}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="default"
                size="sm"
                className="min-h-10 rounded-xl px-4 shadow-sm"
                onClick={() => onOpenRun(selectedRun)}
              >
                {selectedRecoveryLabel}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-10 rounded-xl px-4 shadow-sm"
                onClick={() => onDetachRun(selectedRun)}
                disabled={
                  busyRunId === selectedRun.runId ||
                  selectedRun.viewerAttachment !== "attached" ||
                  selectedRun.supportsViewerDetach === false
                }
              >
                Detach viewer
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="min-h-10 rounded-xl px-4 shadow-sm"
                onClick={() => onStopRun(selectedRun)}
                disabled={busyRunId === selectedRun.runId}
              >
                {busyRunId === selectedRun.runId ? "Stopping..." : "Stop run"}
              </Button>
            </div>
          </div>

          {runningAttentionCount > 0 ? (
            <div className="rounded-2xl border border-warn/30 bg-warn/10 px-4 py-3">
              <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-warn">
                {t("appsview.RunAttention", {
                  defaultValue: "Attention needed",
                })}
              </div>
              <div className="mt-2 text-sm leading-6 text-muted-strong">
                {selectedRunAttentionReasons.length > 0
                  ? selectedRunAttentionReasons.join(". ")
                  : "One or more runs need manual recovery."}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedRunAttentionReasons.map((reason) => (
                  <span
                    key={reason}
                    className="inline-flex max-w-full items-center rounded-full border border-warn/30 bg-bg/75 px-2.5 py-1 text-2xs text-warn"
                  >
                    <span className="truncate">{reason}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
              <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
                Started
              </div>
              <div className="mt-1 text-xs leading-5 text-txt">
                {formatTimestamp(selectedRun.startedAt)}
              </div>
            </div>
            <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
              <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
                Last heartbeat
              </div>
              <div className="mt-1 text-xs leading-5 text-txt">
                {selectedRun.lastHeartbeatAt
                  ? formatTimestamp(selectedRun.lastHeartbeatAt)
                  : "No heartbeat recorded"}
              </div>
            </div>
            <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
              <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
                Session status
              </div>
              <div className="mt-1 text-xs leading-5 text-txt">
                {formatNullableValue(selectedRun.session?.status)}
              </div>
            </div>
            <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
              <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
                Command bridge
              </div>
              <div className="mt-1 text-xs leading-5 text-txt">
                {selectedRun.session?.canSendCommands
                  ? "Available"
                  : "Unavailable"}
              </div>
            </div>
            <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
              <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
                Controls
              </div>
              <div className="mt-1 text-xs leading-5 text-txt">
                {formatControls(selectedRun.session?.controls)}
              </div>
            </div>
            {selectedRun.session?.agentId ? (
              <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
                <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
                  Agent
                </div>
                <div className="mt-1 text-xs leading-5 text-txt">
                  {selectedRun.session.agentId}
                </div>
              </div>
            ) : null}
            {selectedRun.session?.characterId ? (
              <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
                <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
                  Character
                </div>
                <div className="mt-1 text-xs leading-5 text-txt">
                  {selectedRun.session.characterId}
                </div>
              </div>
            ) : null}
            {selectedRun.session?.followEntity ? (
              <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
                <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
                  Follow target
                </div>
                <div className="mt-1 text-xs leading-5 text-txt">
                  {selectedRun.session.followEntity}
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
            <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
              Summary
            </div>
            <div className="mt-1 text-sm leading-6 text-muted-strong">
              {selectedRun.summary ||
                selectedRun.health.message ||
                "This run is active and ready to reattach."}
            </div>
          </div>

          {selectedRun.session?.goalLabel ? (
            <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
              <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
                Current goal
              </div>
              <div className="mt-1 text-sm leading-6 text-muted-strong">
                {selectedRun.session.goalLabel}
              </div>
            </div>
          ) : null}

          {selectedRun.session?.suggestedPrompts?.length ? (
            <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
              <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
                Suggested prompts
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {selectedRun.session.suggestedPrompts.map((prompt) => (
                  <span
                    key={prompt}
                    className="inline-flex max-w-full items-center rounded-full border border-border/30 bg-bg/75 px-2 py-0.5 text-2xs text-muted-strong"
                  >
                    <span className="truncate">{prompt}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {SelectedOperatorSurface ? (
            <SelectedOperatorSurface
              appName={selectedRun.appName}
              variant="running"
            />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
