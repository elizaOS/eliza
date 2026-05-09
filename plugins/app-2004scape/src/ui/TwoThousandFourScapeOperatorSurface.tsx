import {
  type AppOperatorSurfaceProps,
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

interface RecentActivityEntry {
  id: string;
  action?: string;
  detail?: string;
  ts?: string | number;
}

interface GameplayNote {
  id: string;
  label: string;
  detail: string;
}

interface NearbyTarget {
  id: string;
  name: string;
  distance: number | null;
  action: string | null;
}

function firstNonEmptyString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function sanitizeViewerLocation(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function extractRecentActivity(
  telemetry: Record<string, AppSessionJsonValue> | null | undefined,
): RecentActivityEntry[] {
  const recentActivity = telemetry?.recentActivity;
  if (!Array.isArray(recentActivity)) return [];
  const entries: Array<RecentActivityEntry | null> = recentActivity.map(
    (entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return null;
      const record = entry as Record<string, AppSessionJsonValue>;
      const normalizedEntry: RecentActivityEntry = {
        id: [
          typeof record.action === "string" ? record.action : "activity",
          typeof record.ts === "string" || typeof record.ts === "number"
            ? String(record.ts)
            : "unknown",
          typeof record.detail === "string" ? record.detail : "detail",
        ].join("-"),
        action: typeof record.action === "string" ? record.action : undefined,
        detail: typeof record.detail === "string" ? record.detail : undefined,
        ts:
          typeof record.ts === "string" || typeof record.ts === "number"
            ? record.ts
            : undefined,
      };
      return normalizedEntry;
    },
  );
  return entries
    .filter((entry): entry is RecentActivityEntry => entry !== null)
    .slice(-4)
    .reverse();
}

function asRecord(
  value: AppSessionJsonValue | null | undefined,
): Record<string, AppSessionJsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, AppSessionJsonValue>)
    : null;
}

function asArray(
  value: AppSessionJsonValue | null | undefined,
): AppSessionJsonValue[] {
  return Array.isArray(value) ? value : [];
}

function readStringValue(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumberValue(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBooleanValue(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function formatDistance(distance: number | null): string {
  return distance === null ? "nearby" : `${distance.toFixed(1)} tiles`;
}

function formatPlayerState(
  player: Record<string, AppSessionJsonValue> | null,
): string {
  if (!player) return "Waiting for live player telemetry.";
  const worldX = readNumberValue(player, "worldX");
  const worldZ = readNumberValue(player, "worldZ");
  const hp = readNumberValue(player, "hp");
  const maxHp = readNumberValue(player, "maxHp");
  const coordText =
    worldX !== null && worldZ !== null
      ? `${worldX}, ${worldZ}`
      : "Coords pending";
  const hpText =
    hp !== null && maxHp !== null ? `${hp}/${maxHp} HP` : "HP pending";
  return `${coordText} · ${hpText}`;
}

function extractNearbyTargets(
  telemetry: Record<string, AppSessionJsonValue> | null,
): NearbyTarget[] {
  const npcTargets = asArray(telemetry?.nearbyNpcs)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry, index) => {
      const options = asArray(entry.optionsWithIndex)
        .map((option) => asRecord(option))
        .filter(
          (option): option is Record<string, AppSessionJsonValue> =>
            option !== null,
        );
      return {
        id: `npc-${index}-${readStringValue(entry, "name") ?? "target"}`,
        name: readStringValue(entry, "name") ?? "Unknown NPC",
        distance: readNumberValue(entry, "distance"),
        action:
          readStringValue(options[0], "text") ??
          (options.length > 0 ? "Interact" : null),
      } satisfies NearbyTarget;
    });

  const locTargets = asArray(telemetry?.nearbyLocs)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry, index) => {
      const options = asArray(entry.optionsWithIndex)
        .map((option) => asRecord(option))
        .filter(
          (option): option is Record<string, AppSessionJsonValue> =>
            option !== null,
        );
      return {
        id: `loc-${index}-${readStringValue(entry, "name") ?? "target"}`,
        name: readStringValue(entry, "name") ?? "Unknown object",
        distance: readNumberValue(entry, "distance"),
        action:
          readStringValue(options[0], "text") ??
          (options.length > 0 ? "Interact" : null),
      } satisfies NearbyTarget;
    });

  return [...npcTargets, ...locTargets]
    .sort((left, right) => (left.distance ?? 999) - (right.distance ?? 999))
    .slice(0, 4);
}

function extractGameplayNotes(
  telemetry: Record<string, AppSessionJsonValue> | null,
): GameplayNote[] {
  const gameMessages = asArray(telemetry?.gameMessages)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry, index) => ({
      id: `message-${index}`,
      label: readStringValue(entry, "sender") ?? "Game",
      detail: readStringValue(entry, "text") ?? "No message text.",
    }));
  const recentDialogs = asArray(telemetry?.recentDialogs)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry, index) => {
      const parts = asArray(entry.text).filter(
        (part): part is string =>
          typeof part === "string" && part.trim().length > 0,
      );
      return {
        id: `dialog-${index}`,
        label: "Dialog",
        detail: parts.join(" ").trim() || "Dialog prompt pending.",
      } satisfies GameplayNote;
    });

  return [...recentDialogs, ...gameMessages].slice(-4).reverse();
}

function summarizeInventoryAndSkills(
  telemetry: Record<string, AppSessionJsonValue> | null,
): string {
  const inventory = asArray(telemetry?.inventory)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry) => {
      const name = readStringValue(entry, "name") ?? "Item";
      const amount = readNumberValue(entry, "amount");
      return amount && amount > 1 ? `${name} x${amount}` : name;
    })
    .slice(0, 4);
  const skills = asArray(telemetry?.skills)
    .map((entry) => asRecord(entry))
    .filter(
      (entry): entry is Record<string, AppSessionJsonValue> => entry !== null,
    )
    .map((entry) => {
      const name = readStringValue(entry, "name") ?? "Skill";
      const level = readNumberValue(entry, "level");
      return level !== null ? `${name} ${level}` : name;
    })
    .slice(0, 4);
  const parts = [skills.join(" · "), inventory.join(" · ")].filter(
    (part) => part.length > 0,
  );
  return parts.length > 0
    ? parts.join(" | ")
    : "No inventory or skill data yet.";
}

export function TwoThousandFourScapeOperatorSurface({
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

  const session = run?.session ?? null;
  const telemetry =
    session?.telemetry && typeof session.telemetry === "object"
      ? session.telemetry
      : null;
  const suggestedPrompts: string[] = Array.isArray(session?.suggestedPrompts)
    ? session.suggestedPrompts.filter(
        (prompt: unknown): prompt is string =>
          typeof prompt === "string" && prompt.trim().length > 0,
      )
    : [];
  const recentActivity = extractRecentActivity(telemetry);
  const tutorial = asRecord(telemetry?.tutorial);
  const player = asRecord(telemetry?.player);
  const combatStyle = asRecord(telemetry?.combatStyle);
  const nearbyTargets = extractNearbyTargets(telemetry);
  const gameplayNotes = extractGameplayNotes(telemetry);
  const autoPlayEnabled =
    readBooleanValue(telemetry, "autoPlay") ??
    (!session || session.status !== "paused");
  const intentLabel =
    readStringValue(telemetry, "intent") ??
    (session?.status === "paused" ? "paused" : "tutorial");
  const tutorialActive = readBooleanValue(tutorial, "active") ?? false;
  const tutorialPrompt =
    readStringValue(tutorial, "prompt") ??
    (tutorialActive
      ? "Working through the starter flow."
      : "Tutorial is clear.");
  const surfaceTitle =
    variant === "live"
      ? "2004scape Live Dashboard"
      : variant === "running"
        ? "2004scape Run Surface"
        : "2004scape Operator Surface";
  const showDashboard = focus !== "chat";
  const showChat = focus !== "dashboard";
  const viewerLocation = sanitizeViewerLocation(run?.viewer?.url);
  const botUsername = firstNonEmptyString(
    readStringValue(telemetry, "botName"),
    typeof run?.viewer?.embedParams?.bot === "string"
      ? run.viewer.embedParams.bot
      : null,
    run?.viewer?.authMessage?.authToken,
    session?.characterId,
  );
  const hasAutoLoginCredentials = Boolean(
    run?.viewer?.postMessageAuth &&
      run.viewer.authMessage?.authToken &&
      run.viewer.authMessage?.sessionToken,
  );
  const autoLoginLabel = run?.viewer?.postMessageAuth
    ? hasAutoLoginCredentials
      ? "Credentials stored"
      : "Waiting for stored credentials"
    : "Manual login required";
  const autoLoginSubtitle = botUsername
    ? `Bot ${botUsername} is ready for automatic sign-in.`
    : viewerLocation
      ? `Viewer ${viewerLocation}`
      : "Launch with a live runtime to create bot credentials automatically.";
  const runtimeLabel =
    session?.status === "running"
      ? "Connected to 2004scape"
      : session?.status === "paused"
        ? "Loop paused"
        : session?.status === "connecting"
          ? "Connecting to 2004scape"
          : session?.status === "disconnected"
            ? "Waiting for the game gateway"
            : run?.supportsBackground
              ? "Continuous background run"
              : "Foreground session only";
  const runtimeTone =
    session?.status === "running"
      ? "success"
      : run?.health.state === "offline"
        ? "danger"
        : run?.health.state === "degraded" || session?.status === "disconnected"
          ? "warn"
          : "neutral";
  const steeringReady = Boolean(session?.canSendCommands && session?.sessionId);
  const steeringLabel = steeringReady
    ? "Live steering ready"
    : session?.sessionId
      ? "Bridge reconnecting"
      : "Waiting for command bridge";
  const steeringSubtitle = session?.sessionId
    ? `Session ${session.sessionId}`
    : `Run ${run?.runId ?? "pending"}`;
  const viewerLabel =
    run?.viewerAttachment === "attached"
      ? "Viewer attached"
      : run?.viewerAttachment === "detached"
        ? "Viewer detached"
        : "Viewer pending";
  const viewerSubtitle =
    run?.viewerAttachment === "attached"
      ? "The run stays alive if you leave this screen."
      : run?.viewerAttachment === "detached"
        ? "Reattach without restarting the autonomous loop."
        : viewerLocation
          ? `Viewer ${viewerLocation}`
          : "Viewer status will update after launch.";
  const tutorialLabel = tutorialActive
    ? "Tutorial in progress"
    : "Tutorial clear";
  const tutorialTone = tutorialActive ? "warn" : "success";
  const tutorialSubtitle = tutorialPrompt;
  const loopLabel = autoPlayEnabled ? "Autoplay active" : "Autoplay paused";
  const loopSubtitle =
    session?.summary ??
    run?.summary ??
    "Waiting for the 2004scape runtime to report live state.";
  const playerLabel = formatPlayerState(player);
  const playerSubtitle = [
    readStringValue(player, "name"),
    readStringValue(combatStyle, "weaponName"),
    readStringValue(combatStyle, "activeStyle"),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const fieldIntelLabel =
    nearbyTargets.length > 0
      ? nearbyTargets
          .map((target) =>
            target.action ? `${target.name} (${target.action})` : target.name,
          )
          .join(" · ")
      : "No nearby targets reported yet.";
  const fieldIntelSubtitle = summarizeInventoryAndSkills(telemetry);

  const sendOperatorMessage = useCallback(
    async (content: string) => {
      if (!run || content.length === 0 || sending) return false;

      setSending(true);
      setStatusMessage(null);
      try {
        if (run.runId) {
          const response = await client.sendAppRunMessage(run.runId, content);
          setStatusMessage(response.message ?? "Operator message sent.");
          return response.success;
        }
        setStatusMessage("Waiting for the 2004scape command bridge.");
        return false;
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : "Failed to send the 2004scape operator message.",
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
      setStatusMessage(null);
      try {
        const response = await client.controlAppRun(run.runId, action);
        setStatusMessage(
          response.message ??
            (action === "pause"
              ? "2004scape session paused."
              : "2004scape session resumed."),
        );
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : `Failed to ${action} the 2004scape session.`,
        );
      }
    },
    [run],
  );

  if (!run) {
    return (
      <SurfaceEmptyState
        title="2004scape operator surface"
        body="Launch 2004scape to verify auto-login, background runtime, and the live agent loop here."
      />
    );
  }

  return (
    <section
      className={`space-y-3 ${variant === "live" ? "p-3" : ""}`}
      data-testid={
        variant === "live"
          ? "2004scape-live-operator-surface"
          : variant === "running"
            ? "2004scape-running-operator-surface"
            : "2004scape-detail-operator-surface"
      }
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
        <SurfaceSection title="Launch & Loop">
          <SurfaceGrid>
            <SurfaceCard
              label="Bot Login"
              value={autoLoginLabel}
              tone={hasAutoLoginCredentials ? "success" : "warn"}
              subtitle={autoLoginSubtitle}
            />
            <SurfaceCard
              label="Autoplay"
              value={loopLabel}
              tone={runtimeTone}
              subtitle={loopSubtitle}
            />
            <SurfaceCard
              label="Tutorial"
              value={tutorialLabel}
              tone={tutorialTone}
              subtitle={tutorialSubtitle}
            />
            <SurfaceCard
              label="Operator Chat"
              value={steeringLabel}
              tone={steeringReady ? "success" : "warn"}
              subtitle={steeringSubtitle}
            />
          </SurfaceGrid>
        </SurfaceSection>
      ) : null}

      {showDashboard ? (
        <SurfaceSection title="Live State">
          <SurfaceGrid>
            <SurfaceCard
              label="Goal"
              value={session?.goalLabel ?? "No goal recorded."}
              subtitle={
                session?.summary ??
                run.summary ??
                "The bot has not reported a live objective yet."
              }
            />
            <SurfaceCard
              label="Current Intent"
              value={intentLabel}
              subtitle={
                runtimeLabel !== "Connected to 2004scape"
                  ? runtimeLabel
                  : (run.health.message ?? "Live loop is responding.")
              }
            />
            <SurfaceCard
              label="Player"
              value={playerLabel}
              subtitle={
                playerSubtitle ||
                "Player identity and combat state will appear after login."
              }
            />
            <SurfaceCard
              label="Viewer"
              value={viewerLabel}
              tone={toneForViewerAttachment(run.viewerAttachment)}
              subtitle={viewerSubtitle}
            />
            <SurfaceCard
              label="Field Intel"
              value={fieldIntelLabel}
              subtitle={fieldIntelSubtitle}
            />
            <SurfaceCard
              label="Identity"
              value={session?.characterId ?? botUsername ?? "Identity pending"}
              subtitle={
                session?.agentId
                  ? `Agent ${session.agentId}`
                  : "The agent identity will appear once the session is attached."
              }
            />
            <SurfaceCard
              label="Last Heartbeat"
              value={formatDetailTimestamp(
                run.lastHeartbeatAt ?? run.updatedAt,
              )}
              subtitle={`Started ${formatDetailTimestamp(run.startedAt)}`}
            />
          </SurfaceGrid>
          {nearbyTargets.length > 0 ? (
            <div className="space-y-2">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-muted">
                Nearby Targets
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {nearbyTargets.map((target) => (
                  <div
                    key={target.id}
                    className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 text-xs-tight font-medium text-txt">
                      <span>{target.name}</span>
                      <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
                        {formatDistance(target.distance)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
                      {target.action
                        ? `Primary action: ${target.action}`
                        : "Waiting for an action hint."}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {gameplayNotes.length > 0 ? (
            <div className="space-y-2">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-muted">
                Game Feed
              </div>
              {gameplayNotes.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2"
                >
                  <div className="text-xs-tight font-medium text-txt">
                    {entry.label}
                  </div>
                  <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
                    {entry.detail}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {recentActivity.length > 0 ? (
            <div className="space-y-2">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-muted">
                Recent Activity
              </div>
              {recentActivity.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2"
                >
                  <div className="flex items-center gap-2 text-xs-tight font-medium text-txt">
                    <span>{entry.action ?? "activity"}</span>
                    <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
                      {formatDetailTimestamp(entry.ts)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
                    {entry.detail ?? "No detail captured."}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2 text-xs-tight italic text-muted">
              No recent gameplay activity has been captured yet.
            </div>
          )}
        </SurfaceSection>
      ) : null}

      {showChat ? (
        <SurfaceSection title="Steering">
          {suggestedPrompts.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {suggestedPrompts.slice(0, 4).map((prompt) => (
                <Button
                  key={prompt}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-10 rounded-xl px-3 shadow-sm"
                  onClick={() => void handleSuggestedPrompt(prompt)}
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
              >
                Pause session
              </Button>
            ) : null}
            {session?.controls?.includes("resume") ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-10 rounded-xl px-3 shadow-sm"
                onClick={() => void handleControl("resume")}
              >
                Resume session
              </Button>
            ) : null}
          </div>
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              value={operatorMessage}
              onChange={(event) => setOperatorMessage(event.target.value)}
              placeholder="Tell the bot what to train, where to go, or what to say."
              className="min-h-11 rounded-xl"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSendMessage();
                }
              }}
              disabled={!session?.sessionId}
            />
            <Button
              type="button"
              className="min-h-11 rounded-xl px-4 shadow-sm"
              onClick={() => void handleSendMessage()}
              disabled={
                sending ||
                !session?.sessionId ||
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
      <div className="text-2xs uppercase tracking-[0.18em] text-muted">
        2004scape run stays independent from the viewer.
      </div>
    </section>
  );
}
