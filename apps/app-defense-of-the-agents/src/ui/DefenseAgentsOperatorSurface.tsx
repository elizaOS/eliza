import { useCallback, useMemo, useState } from "react";
import { client } from "@elizaos/app-core/api";
import type { AppOperatorSurfaceProps } from "@elizaos/app-core/components/apps/surfaces/types";
import { useApp } from "@elizaos/app-core/state";
import { Button, Input } from "@elizaos/ui";

const LANES = ["top", "mid", "bot"] as const;

function readString(
  source: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(
  source: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatHeroClass(value: string | null): string {
  if (!value) return "Not deployed";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatHeroLine(telemetry: Record<string, unknown> | null): string {
  const heroClass = formatHeroClass(readString(telemetry, "heroClass"));
  const lane = readString(telemetry, "heroLane");
  const level = readNumber(telemetry, "heroLevel");
  const hp = readNumber(telemetry, "heroHp");
  const maxHp = readNumber(telemetry, "heroMaxHp");
  const hpLabel = hp !== null && maxHp !== null ? `, ${hp}/${maxHp} HP` : "";
  const laneLabel = lane ? ` ${lane}` : "";
  const levelLabel = level !== null ? ` Lv${level}` : "";
  return `${heroClass}${levelLabel}${laneLabel}${hpLabel}`;
}

function isLearnPrompt(prompt: string): boolean {
  return /^learn\s+/i.test(prompt);
}

function isRelevantPrompt(prompt: string): boolean {
  return (
    isLearnPrompt(prompt) ||
    /^reinforce\s+/i.test(prompt) ||
    /^move\s+to\s+/i.test(prompt) ||
    /^recall/i.test(prompt) ||
    /^review strategy$/i.test(prompt)
  );
}

function statusTone(status: string): string {
  if (status === "running" || status === "ready") {
    return "border-ok/30 bg-ok/10 text-ok";
  }
  if (status === "degraded" || status === "failed") {
    return "border-danger/30 bg-danger/10 text-danger";
  }
  return "border-border/45 bg-bg-hover/70 text-muted-strong";
}

export function DefenseAgentsOperatorSurface({
  appName,
  variant = "detail",
  focus = "all",
}: AppOperatorSurfaceProps) {
  const { appRuns } = useApp();
  const run = useMemo(
    () =>
      [...(Array.isArray(appRuns) ? appRuns : [])]
        .filter((candidate) => candidate.appName === appName)
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )[0] ?? null,
    [appName, appRuns],
  );
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sendingCommand, setSendingCommand] = useState<string | null>(null);

  const telemetry =
    run?.session?.telemetry && typeof run.session.telemetry === "object"
      ? (run.session.telemetry as Record<string, unknown>)
      : null;
  const heroLane = readString(telemetry, "heroLane");
  const heroClass = readString(telemetry, "heroClass") ?? "mage";
  const autoPlay = telemetry?.autoPlay === true;
  const canSend = Boolean(run?.runId && run.session?.canSendCommands);
  const suggestedPrompts = (run?.session?.suggestedPrompts ?? []).filter(
    isRelevantPrompt,
  );
  const tacticalPrompts = suggestedPrompts.filter(
    (prompt) => !/^auto[- ]?play/i.test(prompt),
  );
  const showDashboard = focus !== "chat";
  const showChat = focus !== "dashboard";

  const sendCommand = useCallback(
    async (content: string, clearDraftOnSuccess = false) => {
      const trimmed = content.trim();
      if (!run?.runId || !trimmed || sendingCommand) return;

      setSendingCommand(trimmed);
      setNotice(null);
      try {
        const response = await client.sendAppRunMessage(run.runId, trimmed);
        if (clearDraftOnSuccess) {
          setDraft((current) => (current.trim() === trimmed ? "" : current));
        }
        setNotice(response.message ?? "Command sent.");
      } catch (error) {
        setNotice(
          error instanceof Error ? error.message : "Defense command failed.",
        );
      } finally {
        setSendingCommand(null);
      }
    },
    [run?.runId, sendingCommand],
  );

  if (!run) {
    return (
      <section
        className={variant === "live" ? "p-3" : ""}
        data-testid="defense-operator-empty"
      >
        <div className="rounded-2xl border border-border/35 bg-card/74 p-4 text-xs text-muted-strong">
          Launch Defense of the Agents to open live controls.
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
          : "defense-detail-operator-surface"
      }
    >
      {showDashboard ? (
        <div className="rounded-2xl border border-border/35 bg-card/74 p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex min-h-6 items-center rounded-full border px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.14em] ${statusTone(run.status)}`}
            >
              {run.status}
            </span>
            <span className="text-xs font-semibold text-txt">
              {formatHeroLine(telemetry)}
            </span>
          </div>
          {run.session?.summary ? (
            <div className="mt-2 text-xs leading-5 text-muted-strong">
              {run.session.summary}
            </div>
          ) : null}
        </div>
      ) : null}

      {showDashboard ? (
        <div className="grid grid-cols-2 gap-2" data-testid="defense-actions">
          <Button
            type="button"
            variant={autoPlay ? "default" : "outline"}
            size="sm"
            className="min-h-9 rounded-xl shadow-sm"
            data-testid="defense-command-autoplay"
            disabled={!canSend || Boolean(sendingCommand)}
            onClick={() =>
              void sendCommand(autoPlay ? "Auto-play OFF" : "Auto-play ON")
            }
          >
            {autoPlay ? "Autoplay On" : "Autoplay Off"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-9 rounded-xl shadow-sm"
            data-testid="defense-command-recall"
            disabled={!canSend || Boolean(sendingCommand)}
            onClick={() => void sendCommand("Recall to base")}
          >
            Recall
          </Button>
          {LANES.map((lane) => {
            const label = heroLane ? `Move ${lane}` : `Deploy ${lane}`;
            const command = heroLane
              ? `Move to ${lane} lane`
              : `Deploy as ${heroClass} in ${lane} lane`;
            return (
              <Button
                key={lane}
                type="button"
                variant={heroLane === lane ? "default" : "outline"}
                size="sm"
                className="min-h-9 rounded-xl shadow-sm"
                data-testid={`defense-command-lane-${lane}`}
                disabled={!canSend || Boolean(sendingCommand)}
                onClick={() => void sendCommand(command)}
              >
                {label}
              </Button>
            );
          })}
        </div>
      ) : null}

      {showChat ? (
        <div className="rounded-2xl border border-border/35 bg-card/74 p-3 shadow-sm">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Command the hero..."
              className="min-h-10 rounded-xl"
              data-testid="defense-chat-input"
              disabled={!canSend}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendCommand(draft, true);
                }
              }}
            />
            <Button
              type="button"
              className="min-h-10 rounded-xl px-4 shadow-sm"
              data-testid="defense-chat-send"
              disabled={!canSend || Boolean(sendingCommand) || !draft.trim()}
              onClick={() => void sendCommand(draft, true)}
            >
              {sendingCommand === draft.trim() ? "Sending" : "Send"}
            </Button>
          </div>
          {tacticalPrompts.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {tacticalPrompts.map((prompt) => (
                <Button
                  key={prompt}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-8 rounded-xl px-3 shadow-sm"
                  data-testid="defense-suggested-command"
                  disabled={!canSend || Boolean(sendingCommand)}
                  onClick={() => void sendCommand(prompt)}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <div
          className="rounded-2xl border border-border/35 bg-card/70 px-4 py-3 text-xs leading-5 text-muted-strong"
          data-testid="defense-command-notice"
        >
          {notice}
        </div>
      ) : null}
    </section>
  );
}
