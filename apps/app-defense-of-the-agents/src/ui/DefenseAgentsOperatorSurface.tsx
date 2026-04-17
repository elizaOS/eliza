

import { useCallback, useMemo, useState } from "react";
import { client } from "@elizaos/app-core/api";
import { useApp } from "@elizaos/app-core/state";
import type { AppOperatorSurfaceProps } from "@elizaos/app-core/components/apps/surfaces/types";
import { Button, Input } from "@elizaos/ui";

function DetailCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/35 bg-bg/55 px-4 py-3">
      <div className="text-xs-tight font-medium uppercase tracking-[0.16em] text-muted">
        {label}
      </div>
      <div className="mt-1 text-xs leading-5 text-txt">{value}</div>
    </div>
  );
}

function formatTimestamp(value: string | number | null | undefined): string {
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Not yet verified"
      : date.toLocaleString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Not yet verified"
      : date.toLocaleString();
  }
  return "Not yet verified";
}

function statusTone(status: string): string {
  if (status === "running" || status === "connected") {
    return "border-ok/30 bg-ok/10 text-ok";
  }
  if (status === "disconnected" || status === "offline") {
    return "border-danger/30 bg-danger/10 text-danger";
  }
  return "border-warn/30 bg-warn/10 text-warn";
}

export function DefenseAgentsOperatorSurface({
  appName,
  variant = "detail",
  focus = "all",
}: AppOperatorSurfaceProps) {
  const { appRuns } = useApp();
  const availableRuns = Array.isArray(appRuns) ? appRuns : [];
  const run = useMemo(
    () =>
      [...availableRuns]
        .filter((candidate) => candidate.appName === appName)
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )[0] ?? null,
    [appName, availableRuns],
  );
  const [operatorMessage, setOperatorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const telemetry =
    run?.session?.telemetry && typeof run.session.telemetry === "object"
      ? (run.session.telemetry as Record<string, unknown>)
      : null;
  const recentActivity = Array.isArray(telemetry?.recentActivity)
    ? (telemetry.recentActivity as Array<Record<string, unknown>>)
        .slice(-4)
        .reverse()
    : [];
  const heroClass =
    typeof telemetry?.heroClass === "string" ? telemetry.heroClass : "Unknown";
  const heroLane =
    typeof telemetry?.heroLane === "string" ? telemetry.heroLane : "unknown";
  const heroLevel =
    typeof telemetry?.heroLevel === "number"
      ? `Lv${telemetry.heroLevel}`
      : "Level unknown";
  const heroHp =
    typeof telemetry?.heroHp === "number" &&
    typeof telemetry?.heroMaxHp === "number"
      ? `${telemetry.heroHp}/${telemetry.heroMaxHp} HP`
      : "HP unknown";
  const autoPlayLabel =
    telemetry?.autoPlay === true ? "Enabled" : "Operator-led";
  const strategyLabel =
    typeof telemetry?.strategyVersion === "number"
      ? `Version ${telemetry.strategyVersion}`
      : "Ready after launch";
  const surfaceTitle =
    variant === "live"
      ? "Defense Live Dashboard"
      : variant === "running"
        ? "Defense Run Surface"
        : "Live Operator Surface";
  const showDashboard = focus !== "chat";
  const showChat = focus !== "dashboard";

  const handleSendMessage = useCallback(async () => {
    const content = operatorMessage.trim();
    if (!run || content.length === 0 || sending) return;

    setSending(true);
    setStatusMessage(null);
    try {
      const response = await client.sendAppRunMessage(run.runId, content);
      setOperatorMessage("");
      setStatusMessage(response.message ?? "Operator message sent.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to send the Defense operator message.",
      );
    } finally {
      setSending(false);
    }
  }, [operatorMessage, run, sending]);

  const handlePrompt = useCallback(
    async (prompt: string) => {
      if (!run || sending) return;

      setSending(true);
      setStatusMessage(null);
      try {
        const response = await client.sendAppRunMessage(run.runId, prompt);
        setStatusMessage(response.message ?? "Suggested prompt sent.");
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : "Failed to send the Defense prompt.",
        );
      } finally {
        setSending(false);
      }
    },
    [run, sending],
  );

  if (!run) {
    return (
      <section className="space-y-3">
        <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
          Operator Surface
        </div>
        <div className="rounded-[1.4rem] border border-border/35 bg-card/74 p-4 shadow-sm">
          <p className="text-xs leading-6 text-muted-strong">
            Defense of the Agents uses a hosted spectator shell. Launch it to
            monitor the agent, keep the autoplay script running, and steer the
            hero with live chat guidance.
          </p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <DetailCard
              label="Autoplay Loop"
              value="Deploys, levels, recalls, and reinforces lanes."
            />
            <DetailCard
              label="Strategy Review"
              value="Scores current tactics and promotes better versions over time."
            />
            <DetailCard
              label="Operator Chat"
              value="Suggestions flow into the live session while the bot keeps playing."
            />
            <DetailCard
              label="Viewer Shell"
              value="The app opens a stable local shell instead of the broken remote overlay stack."
            />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`space-y-3 ${variant === "live" ? "p-3" : ""}`}
      data-testid={
        variant === "live"
          ? "defense-live-operator-surface"
          : variant === "running"
            ? "defense-running-operator-surface"
            : "defense-detail-operator-surface"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
          {surfaceTitle}
        </div>
        <span
          className={`inline-flex min-h-6 items-center rounded-full border px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.14em] ${statusTone(run.status)}`}
        >
          {run.status}
        </span>
        <span className="inline-flex min-h-6 items-center rounded-full border border-border/35 bg-bg-hover/70 px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.14em] text-muted-strong">
          {run.viewerAttachment}
        </span>
      </div>

      {showDashboard ? (
        <div className="grid gap-2 md:grid-cols-2">
          <DetailCard
            label="Agent Status"
            value={`${heroClass} ${heroLevel} in ${heroLane} lane`}
          />
          <DetailCard label="Hero Health" value={heroHp} />
          <DetailCard label="Autoplay Script" value={autoPlayLabel} />
          <DetailCard label="Strategy Script" value={strategyLabel} />
        </div>
      ) : null}

      {showDashboard ? (
        <div className="rounded-[1.4rem] border border-border/35 bg-card/74 p-4 shadow-sm">
          <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
            Session Summary
          </div>
          <p className="mt-2 text-xs leading-6 text-muted-strong">
            {run.summary || run.health.message || "Run active."}
          </p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <DetailCard
              label="Operator Channel"
              value={
                run.session?.canSendCommands
                  ? "Ready for live suggestions and steering."
                  : "Waiting for the live command channel."
              }
            />
            <DetailCard
              label="Last Verified"
              value={formatTimestamp(run.lastHeartbeatAt ?? run.updatedAt)}
            />
          </div>
        </div>
      ) : null}

      {showDashboard ? (
        <div className="rounded-[1.4rem] border border-border/35 bg-card/74 p-4 shadow-sm">
          <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
            Active Scripts
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <DetailCard
              label="Autoplay Loop"
              value={
                telemetry?.autoPlay === true
                  ? "Running lane-defense automation."
                  : "Standing by for operator-led play."
              }
            />
            <DetailCard
              label="Strategy Review"
              value={
                typeof telemetry?.bestStrategyVersion === "number"
                  ? `Tracking best version ${telemetry.bestStrategyVersion}.`
                  : "Scoring strategy performance in-session."
              }
            />
            <DetailCard
              label="Viewer Shell"
              value={
                run.viewer
                  ? "Local spectator shell is available for stable viewing."
                  : "Viewer shell unavailable."
              }
            />
            <DetailCard
              label="Operator Steering"
              value={
                run.session?.canSendCommands
                  ? "Chat guidance is live."
                  : "Command bridge is reconnecting."
              }
            />
          </div>
        </div>
      ) : null}

      {showChat ? (
        <div className="rounded-[1.4rem] border border-border/35 bg-card/74 p-4 shadow-sm">
          <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
            Steering
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              value={operatorMessage}
              onChange={(event) => setOperatorMessage(event.target.value)}
              placeholder="Tell the hero how to rotate, defend, or adapt the current strategy."
              className="min-h-11 rounded-xl"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSendMessage();
                }
              }}
              disabled={!run.session?.sessionId}
            />
            <Button
              type="button"
              className="min-h-11 rounded-xl px-4 shadow-sm"
              onClick={() => void handleSendMessage()}
              disabled={
                sending ||
                !run.session?.canSendCommands ||
                operatorMessage.trim().length === 0
              }
            >
              {sending ? "Sending" : "Send"}
            </Button>
          </div>
          {run.session?.suggestedPrompts?.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {run.session.suggestedPrompts.map((prompt) => (
                <Button
                  key={prompt}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-9 rounded-xl px-3 shadow-sm"
                  onClick={() => void handlePrompt(prompt)}
                  disabled={sending}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {showChat && recentActivity.length > 0 ? (
        <div className="rounded-[1.4rem] border border-border/35 bg-card/74 p-4 shadow-sm">
          <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
            Recent Behavior
          </div>
          <div className="mt-3 space-y-2">
            {recentActivity.map((entry) => {
              const action =
                typeof entry.action === "string" ? entry.action : "activity";
              const detail =
                typeof entry.detail === "string"
                  ? entry.detail
                  : "No detail captured.";
              const ts =
                typeof entry.ts === "number" || typeof entry.ts === "string"
                  ? formatTimestamp(entry.ts)
                  : "Unknown time";
              return (
                <div
                  key={`${action}-${detail}-${ts}`}
                  className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2"
                >
                  <div className="text-xs-tight font-medium text-txt">
                    {action}
                  </div>
                  <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
                    {detail}
                  </div>
                  <div className="mt-1 text-2xs text-muted">{ts}</div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {statusMessage ? (
        <div className="rounded-2xl border border-border/35 bg-card/70 px-4 py-3 text-xs-tight leading-5 text-muted-strong">
          {statusMessage}
        </div>
      ) : null}
    </section>
  );
}
