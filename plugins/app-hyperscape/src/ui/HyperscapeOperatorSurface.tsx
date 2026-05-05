import {
  type AppOperatorSurfaceProps,
  type AppRunSummary,
  type AppSessionJsonValue,
  client,
  formatDetailTimestamp,
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
  useApp,
} from "@elizaos/app-core";
import { Button, Input } from "@elizaos/ui";
import { useCallback, useMemo, useState } from "react";

interface HyperscapeActivityEntry {
  id: string;
  label: string;
  detail: string;
  timestamp: string | number | null;
}

function asTelemetryRecord(
  value: Record<string, AppSessionJsonValue> | null | undefined,
): Record<string, AppSessionJsonValue> | null {
  return value && typeof value === "object" ? value : null;
}

function extractRecentActivity(run: AppRunSummary): HyperscapeActivityEntry[] {
  const entries: HyperscapeActivityEntry[] = [];

  for (const event of run.recentEvents ?? []) {
    entries.push({
      id: event.eventId,
      label: event.kind,
      detail: event.message,
      timestamp: event.createdAt,
    });
  }

  for (const item of run.session?.activity ?? []) {
    entries.push({
      id: item.id,
      label: item.type,
      detail: item.message,
      timestamp: item.timestamp ?? null,
    });
  }

  const telemetry = asTelemetryRecord(run.session?.telemetry);
  const telemetryActivity = telemetry?.recentActivity;
  if (Array.isArray(telemetryActivity)) {
    for (const item of telemetryActivity) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, AppSessionJsonValue>;
      entries.push({
        id: `${record.action ?? "activity"}-${record.ts ?? entries.length}`,
        label: typeof record.action === "string" ? record.action : "activity",
        detail:
          typeof record.detail === "string"
            ? record.detail
            : "No detail captured.",
        timestamp:
          typeof record.ts === "string" || typeof record.ts === "number"
            ? record.ts
            : null,
      });
    }
  }

  return entries
    .slice()
    .sort((left, right) => {
      const rightTime = new Date(right.timestamp ?? 0).getTime();
      const leftTime = new Date(left.timestamp ?? 0).getTime();
      return (
        (Number.isFinite(rightTime) ? rightTime : 0) -
        (Number.isFinite(leftTime) ? leftTime : 0)
      );
    })
    .slice(0, 5);
}

function formatViewerAuthLabel(run: AppRunSummary): string {
  if (run.viewer?.authMessage?.type) {
    return `Auto-login ${run.viewer.authMessage.type}`;
  }
  if (run.viewer?.postMessageAuth) {
    return "Auth bootstrap pending";
  }
  return "Viewer does not need app auth";
}

function surfaceTestId(variant: AppOperatorSurfaceProps["variant"]): string {
  if (variant === "live") return "hyperscape-live-operator-surface";
  if (variant === "running") return "hyperscape-running-operator-surface";
  return "hyperscape-detail-operator-surface";
}

export function HyperscapeOperatorSurface({
  appName,
  variant = "detail",
  focus = "all",
}: AppOperatorSurfaceProps) {
  const { appRuns } = useApp();
  const { run, matchingRuns } = useMemo(
    () => selectLatestRunForApp(appName, appRuns),
    [appName, appRuns],
  );
  const [operatorMessage, setOperatorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [controlAction, setControlAction] = useState<"pause" | "resume" | null>(
    null,
  );

  const session = run?.session ?? null;
  const recentActivity = useMemo(
    () => (run ? extractRecentActivity(run) : []),
    [run],
  );
  const showDashboard = focus !== "chat";
  const showChat = focus !== "dashboard";
  const surfaceTitle =
    variant === "live"
      ? "Hyperscape Host Surface"
      : variant === "running"
        ? "Hyperscape Run Surface"
        : "Hyperscape Host Surface";

  const sendOperatorMessage = useCallback(
    async (content: string) => {
      if (!run || content.length === 0 || sending) return false;

      setSending(true);
      setStatusMessage(null);
      try {
        const response = await client.sendAppRunMessage(run.runId, content);
        setStatusMessage(response.message ?? "Operator message sent.");
        return response.success;
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : "Failed to relay the Hyperscape operator message.",
        );
        return false;
      } finally {
        setSending(false);
      }
    },
    [run, sending],
  );

  const handleSendMessage = useCallback(async () => {
    const content = operatorMessage.trim();
    if (content.length === 0) return;
    const sent = await sendOperatorMessage(content);
    if (sent) {
      setOperatorMessage("");
    }
  }, [operatorMessage, sendOperatorMessage]);

  const handleSuggestedPrompt = useCallback(
    async (prompt: string) => {
      await sendOperatorMessage(prompt.trim());
    },
    [sendOperatorMessage],
  );

  const handleControl = useCallback(
    async (action: "pause" | "resume") => {
      if (!run) return;
      setControlAction(action);
      setStatusMessage(null);
      try {
        const response = await client.controlAppRun(run.runId, action);
        setStatusMessage(
          response.message ??
            (action === "pause"
              ? "Hyperscape autonomy paused."
              : "Hyperscape autonomy resumed."),
        );
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : `Failed to ${action} Hyperscape.`,
        );
      } finally {
        setControlAction(null);
      }
    },
    [run],
  );

  if (!run) {
    return (
      <SurfaceEmptyState
        title="Hyperscape host surface"
        body="Launch Hyperscape to verify auth, follow-target attachment, and host-side recovery controls around the native embedded agent screen."
      />
    );
  }

  return (
    <section
      className={`space-y-3 ${variant === "live" ? "p-3" : ""}`}
      data-testid={surfaceTestId(variant)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
          {surfaceTitle}
        </div>
        <SurfaceBadge tone={toneForStatusText(run.status)}>
          {run.status}
        </SurfaceBadge>
        <SurfaceBadge tone={toneForViewerAttachment(run.viewerAttachment)}>
          {run.viewerAttachment}
        </SurfaceBadge>
        <SurfaceBadge tone={toneForHealthState(run.health.state)}>
          {run.health.state}
        </SurfaceBadge>
        <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
          {matchingRuns.length} active run{matchingRuns.length === 1 ? "" : "s"}
        </span>
      </div>

      {showDashboard ? (
        <>
          <SurfaceSection title="Viewer Host">
            <SurfaceGrid>
              <SurfaceCard
                label="Auth"
                value={formatViewerAuthLabel(run)}
                subtitle={
                  run.viewer?.url
                    ? `Viewer ${run.viewer.url}`
                    : "Viewer URL is not available."
                }
              />
              <SurfaceCard
                label="Follow Target"
                value={
                  session?.followEntity ??
                  run.viewer?.authMessage?.followEntity ??
                  "Awaiting live follow target"
                }
                subtitle={
                  session?.characterId
                    ? `Character ${session.characterId}`
                    : "The followed entity will appear after the viewer attaches."
                }
              />
              <SurfaceCard
                label="Runtime"
                value={
                  run.supportsBackground
                    ? "Background run stays alive"
                    : "Foreground viewer keeps the run alive"
                }
                subtitle={session?.summary ?? run.summary ?? "Run active."}
              />
              <SurfaceCard
                label="Viewer Attachment"
                value={run.viewerAttachment}
                subtitle={
                  run.awaySummary?.message ??
                  `Last heartbeat ${formatDetailTimestamp(run.lastHeartbeatAt ?? run.updatedAt)}`
                }
              />
            </SurfaceGrid>
          </SurfaceSection>

          <SurfaceSection title="Runtime State">
            <SurfaceGrid>
              <SurfaceCard
                label="Goal"
                value={session?.goalLabel ?? "No goal published yet."}
                subtitle={run.summary ?? run.health.message ?? undefined}
              />
              <SurfaceCard
                label="Health"
                value={run.health.state}
                tone={toneForHealthState(run.health.state)}
                subtitle={
                  run.health.message ??
                  run.healthDetails?.message ??
                  "Health checks have not reported a message yet."
                }
              />
              <SurfaceCard
                label="Operator Relay"
                value={
                  session?.canSendCommands
                    ? "Ready for live steering"
                    : "Waiting for command relay"
                }
                subtitle={session?.sessionId ?? "No session ID yet."}
              />
              <SurfaceCard
                label="Last Verified"
                value={formatDetailTimestamp(
                  run.lastHeartbeatAt ?? run.updatedAt,
                )}
                subtitle={`Started ${formatDetailTimestamp(run.startedAt)}`}
              />
            </SurfaceGrid>
            {recentActivity.length > 0 ? (
              <div className="space-y-2">
                {recentActivity.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 text-xs-tight font-medium text-txt">
                      <span>{entry.label}</span>
                      <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
                        {formatDetailTimestamp(entry.timestamp)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
                      {entry.detail}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2 text-xs-tight italic text-muted">
                No host-side activity has been captured yet.
              </div>
            )}
          </SurfaceSection>
        </>
      ) : null}

      {showChat ? (
        <SurfaceSection title="Operator Relay">
          {session?.suggestedPrompts?.length ? (
            <div className="flex flex-wrap gap-2">
              {session.suggestedPrompts.map((prompt) => (
                <Button
                  key={prompt}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-10 rounded-xl px-3 shadow-sm"
                  onClick={() => void handleSuggestedPrompt(prompt)}
                  disabled={sending}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {session?.controls?.includes("pause") ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-10 rounded-xl px-3 shadow-sm"
                onClick={() => void handleControl("pause")}
                disabled={controlAction === "pause"}
              >
                {controlAction === "pause" ? "Pausing..." : "Pause autonomy"}
              </Button>
            ) : null}
            {session?.controls?.includes("resume") ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-10 rounded-xl px-3 shadow-sm"
                onClick={() => void handleControl("resume")}
                disabled={controlAction === "resume"}
              >
                {controlAction === "resume" ? "Resuming..." : "Resume autonomy"}
              </Button>
            ) : null}
          </div>
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              value={operatorMessage}
              onChange={(event) => setOperatorMessage(event.target.value)}
              placeholder="Tell Hyperscape what to prioritize, avoid, or explain."
              className="min-h-11 rounded-xl"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSendMessage();
                }
              }}
              disabled={!session?.canSendCommands}
            />
            <Button
              type="button"
              className="min-h-11 rounded-xl px-4 shadow-sm"
              onClick={() => void handleSendMessage()}
              disabled={
                sending ||
                !session?.canSendCommands ||
                operatorMessage.trim().length === 0
              }
            >
              {sending ? "Sending" : "Send"}
            </Button>
          </div>
        </SurfaceSection>
      ) : null}

      {statusMessage ? (
        <div className="rounded-2xl border border-border/35 bg-card/70 px-4 py-3 text-xs-tight leading-5 text-muted-strong">
          {statusMessage}
        </div>
      ) : null}
    </section>
  );
}
