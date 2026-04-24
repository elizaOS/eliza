import { useCallback, useMemo, useState } from "react";
import { client } from "@elizaos/app-core/api";
import type { AppOperatorSurfaceProps } from "@elizaos/app-core/components/apps/surfaces/types";
import { useApp } from "@elizaos/app-core/state";
import { Button, Input } from "@elizaos/ui";

const PRIMARY_COMMANDS = [
  {
    id: "move-krusty",
    label: "Move Krusty Krab",
    command: "Move to Krusty Krab",
  },
  {
    id: "move-chum",
    label: "Move Chum Bucket",
    command: "Move to Chum Bucket",
  },
  {
    id: "visit-nearest",
    label: "Visit Nearest",
    command: "Visit the nearest building",
  },
  {
    id: "ask-npc",
    label: "Ask NPC",
    command: "Ask the nearest NPC what to learn next",
  },
] as const;

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

function shortenWallet(value: string | null): string {
  if (!value) return "No wallet";
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
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

export function ClawvilleOperatorSurface({
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
  const nearestBuilding =
    readString(telemetry, "nearestBuildingLabel") ??
    readString(telemetry, "nearestBuildingId") ??
    "reef";
  const walletLabel = shortenWallet(readString(telemetry, "walletAddress"));
  const knowledgeCount = readNumber(telemetry, "knowledgeCount");
  const canSend = Boolean(run?.runId && run.session?.canSendCommands);
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
          error instanceof Error ? error.message : "ClawVille command failed.",
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
        data-testid="clawville-operator-empty"
      >
        <div className="rounded-2xl border border-border/35 bg-card/74 p-4 text-xs text-muted-strong">
          Launch ClawVille to open live controls.
        </div>
      </section>
    );
  }

  return (
    <section
      className={`space-y-3 ${variant === "live" ? "p-3" : ""}`}
      data-testid={
        variant === "live"
          ? "clawville-live-operator-surface"
          : "clawville-detail-operator-surface"
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
              Near {nearestBuilding}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-strong">
            <span>{walletLabel}</span>
            {knowledgeCount !== null ? (
              <span>{knowledgeCount} skills learned</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {showDashboard ? (
        <div className="grid grid-cols-2 gap-2" data-testid="clawville-actions">
          {PRIMARY_COMMANDS.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant="outline"
              size="sm"
              className="min-h-9 rounded-xl shadow-sm"
              data-testid={`clawville-command-${item.id}`}
              disabled={!canSend || Boolean(sendingCommand)}
              onClick={() => void sendCommand(item.command)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      ) : null}

      {showChat ? (
        <div className="rounded-2xl border border-border/35 bg-card/74 p-3 shadow-sm">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Tell ClawVille what to do..."
              className="min-h-10 rounded-xl"
              data-testid="clawville-chat-input"
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
              data-testid="clawville-chat-send"
              disabled={!canSend || Boolean(sendingCommand) || !draft.trim()}
              onClick={() => void sendCommand(draft, true)}
            >
              {sendingCommand === draft.trim() ? "Sending" : "Send"}
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
                  className="min-h-8 rounded-xl px-3 shadow-sm"
                  data-testid="clawville-suggested-command"
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
          data-testid="clawville-command-notice"
        >
          {notice}
        </div>
      ) : null}
    </section>
  );
}
