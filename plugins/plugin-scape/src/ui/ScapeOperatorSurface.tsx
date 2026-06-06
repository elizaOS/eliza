import {
  type AppOperatorSurfaceProps,
  type AppSessionJsonValue,
  client,
  formatDetailTimestamp,
  SurfaceBadge,
  SurfaceCard,
  SurfaceSection,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
  useApp,
} from "@elizaos/app-core/ui-compat";
import { Button } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { type CSSProperties, useCallback, useMemo, useState } from "react";
import {
  GameSurfaceHero,
  GameSurfaceShell,
  GameSurfaceStrip,
  GameSurfaceZone,
  HeroCta,
  type StatChip,
  WaitingForSession,
} from "./game-surface-shell";

const SCAPE_HERO = "/api/views/scape/hero";
const SCAPE_ACCENT = "#d98a2b";

// ─────────────────────────────────────────────────────────────────────────
// Telemetry shape — a partial view of what buildScapeSessionState emits.

type OperatorSurfaceTone = "neutral" | "accent" | "success" | "warn" | "danger";
// Keep this permissive: all fields are optional so an empty / idle session
// still renders a useful frame.
// ─────────────────────────────────────────────────────────────────────────

interface ScapePosition {
  x: number;
  z: number;
}

interface ScapeAgentSelf {
  name?: string;
  combatLevel?: number;
  hp?: number;
  maxHp?: number;
  level?: number;
  runEnergy?: number;
  inCombat?: boolean;
  position?: ScapePosition;
  tick?: number;
}

interface ScapeActiveGoal {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  source: string;
  progress: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ScapeJournalMemory {
  id: string;
  kind: string;
  text: string;
  weight: number | null;
  timestamp: number;
  position: ScapePosition | null;
}

interface ScapeJournalSection {
  sessionCount?: number;
  memoryCount?: number;
  recent?: ScapeJournalMemory[];
}

interface ScapeNearbyNpc {
  id?: number;
  defId?: number;
  name?: string;
  combatLevel?: number | null;
  hp?: number | null;
  position?: ScapePosition;
  distance?: number | null;
}

interface ScapeNearbyPlayer {
  id?: number;
  name?: string;
  combatLevel?: number;
  position?: ScapePosition;
  distance?: number | null;
}

interface ScapeNearbyItem {
  itemId?: number;
  name?: string;
  count?: number;
  position?: ScapePosition;
  distance?: number | null;
}

interface ScapeNearbySection {
  npcs?: ScapeNearbyNpc[];
  players?: ScapeNearbyPlayer[];
  items?: ScapeNearbyItem[];
}

interface ScapeSkill {
  id?: number;
  name?: string;
  level?: number;
  baseLevel?: number;
  xp?: number;
}

interface ScapeInventoryItem {
  slot?: number;
  itemId?: number;
  name?: string;
  count?: number;
}

interface ScapeTelemetry {
  clientUrl?: string;
  connectionStatus?: string;
  pausedByOperator?: boolean;
  operatorGoal?: string | null;
  activeGoal?: ScapeActiveGoal | null;
  journal?: ScapeJournalSection;
  agent?: ScapeAgentSelf | null;
  skills?: ScapeSkill[];
  inventory?: ScapeInventoryItem[];
  nearby?: ScapeNearbySection;
}

// ─────────────────────────────────────────────────────────────────────────
// Permissive readers — telemetry arrives as AppSessionJsonValue so every
// cast has to be defensive. These helpers centralize the "is this shape
// what I think it is?" check.
// ─────────────────────────────────────────────────────────────────────────

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

function readString(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(
  record: Record<string, AppSessionJsonValue> | null | undefined,
  key: string,
): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function readPosition(
  record: Record<string, AppSessionJsonValue> | null | undefined,
): ScapePosition | undefined {
  const pos = asRecord(record?.position);
  const x = readNumber(pos, "x");
  const z = readNumber(pos, "z");
  if (x === null || z === null) return undefined;
  return { x, z };
}

function extractAgent(
  telemetry: Record<string, AppSessionJsonValue> | null,
): ScapeAgentSelf | null {
  const record = asRecord(telemetry?.agent);
  if (!record) return null;
  return {
    name: readString(record, "name") ?? undefined,
    combatLevel: readNumber(record, "combatLevel") ?? undefined,
    hp: readNumber(record, "hp") ?? undefined,
    maxHp: readNumber(record, "maxHp") ?? undefined,
    level: readNumber(record, "level") ?? undefined,
    runEnergy: readNumber(record, "runEnergy") ?? undefined,
    inCombat: readBoolean(record, "inCombat") ?? undefined,
    position: readPosition(record),
    tick: readNumber(record, "tick") ?? undefined,
  };
}

function extractActiveGoal(
  telemetry: Record<string, AppSessionJsonValue> | null,
): ScapeActiveGoal | null {
  const record = asRecord(telemetry?.activeGoal);
  if (!record) return null;
  const id = readString(record, "id");
  const title = readString(record, "title");
  const status = readString(record, "status");
  const source = readString(record, "source");
  if (!id || !title || !status || !source) return null;
  return {
    id,
    title,
    status,
    source,
    notes: readString(record, "notes"),
    progress: readNumber(record, "progress"),
    createdAt: readNumber(record, "createdAt") ?? 0,
    updatedAt: readNumber(record, "updatedAt") ?? 0,
  };
}

function extractMemories(
  telemetry: Record<string, AppSessionJsonValue> | null,
): ScapeJournalMemory[] {
  const journal = asRecord(telemetry?.journal);
  const recent = asArray(journal?.recent);
  return recent
    .map((raw): ScapeJournalMemory | null => {
      const record = asRecord(raw);
      if (!record) return null;
      const id = readString(record, "id");
      const kind = readString(record, "kind");
      const text = readString(record, "text");
      if (!id || !kind || !text) return null;
      return {
        id,
        kind,
        text,
        weight: readNumber(record, "weight"),
        timestamp: readNumber(record, "timestamp") ?? 0,
        position: readPosition(record) ?? null,
      };
    })
    .filter((memory): memory is ScapeJournalMemory => memory !== null);
}

function extractJournalSection(
  telemetry: Record<string, AppSessionJsonValue> | null,
): ScapeJournalSection {
  const record = asRecord(telemetry?.journal);
  return {
    sessionCount: readNumber(record, "sessionCount") ?? undefined,
    memoryCount: readNumber(record, "memoryCount") ?? undefined,
    recent: extractMemories(telemetry),
  };
}

function extractNearbyNpcs(
  telemetry: Record<string, AppSessionJsonValue> | null,
): ScapeNearbyNpc[] {
  const nearby = asRecord(telemetry?.nearby);
  return asArray(nearby?.npcs)
    .map((raw): ScapeNearbyNpc | null => {
      const record = asRecord(raw);
      if (!record) return null;
      return {
        id: readNumber(record, "id") ?? undefined,
        defId: readNumber(record, "defId") ?? undefined,
        name: readString(record, "name") ?? undefined,
        combatLevel: readNumber(record, "combatLevel"),
        hp: readNumber(record, "hp"),
        position: readPosition(record),
        distance: readNumber(record, "distance"),
      };
    })
    .filter((npc): npc is ScapeNearbyNpc => npc !== null);
}

function extractNearbyPlayers(
  telemetry: Record<string, AppSessionJsonValue> | null,
): ScapeNearbyPlayer[] {
  const nearby = asRecord(telemetry?.nearby);
  return asArray(nearby?.players)
    .map((raw): ScapeNearbyPlayer | null => {
      const record = asRecord(raw);
      if (!record) return null;
      return {
        id: readNumber(record, "id") ?? undefined,
        name: readString(record, "name") ?? undefined,
        combatLevel: readNumber(record, "combatLevel") ?? undefined,
        position: readPosition(record),
        distance: readNumber(record, "distance"),
      };
    })
    .filter((player): player is ScapeNearbyPlayer => player !== null);
}

function extractNearbyItems(
  telemetry: Record<string, AppSessionJsonValue> | null,
): ScapeNearbyItem[] {
  const nearby = asRecord(telemetry?.nearby);
  return asArray(nearby?.items)
    .map((raw): ScapeNearbyItem | null => {
      const record = asRecord(raw);
      if (!record) return null;
      return {
        itemId: readNumber(record, "itemId") ?? undefined,
        name: readString(record, "name") ?? undefined,
        count: readNumber(record, "count") ?? undefined,
        position: readPosition(record),
        distance: readNumber(record, "distance"),
      };
    })
    .filter((item): item is ScapeNearbyItem => item !== null);
}

function extractSkills(
  telemetry: Record<string, AppSessionJsonValue> | null,
): ScapeSkill[] {
  return asArray(telemetry?.skills)
    .map((raw): ScapeSkill | null => {
      const record = asRecord(raw);
      if (!record) return null;
      return {
        id: readNumber(record, "id") ?? undefined,
        name: readString(record, "name") ?? undefined,
        level: readNumber(record, "level") ?? undefined,
        baseLevel: readNumber(record, "baseLevel") ?? undefined,
        xp: readNumber(record, "xp") ?? undefined,
      };
    })
    .filter((skill): skill is ScapeSkill => skill !== null);
}

function extractInventory(
  telemetry: Record<string, AppSessionJsonValue> | null,
): ScapeInventoryItem[] {
  return asArray(telemetry?.inventory)
    .map((raw): ScapeInventoryItem | null => {
      const record = asRecord(raw);
      if (!record) return null;
      return {
        slot: readNumber(record, "slot") ?? undefined,
        itemId: readNumber(record, "itemId") ?? undefined,
        name: readString(record, "name") ?? undefined,
        count: readNumber(record, "count") ?? undefined,
      };
    })
    .filter((item): item is ScapeInventoryItem => item !== null);
}

function extractTelemetry(
  telemetry: Record<string, AppSessionJsonValue> | null,
): ScapeTelemetry {
  return {
    clientUrl: readString(telemetry, "clientUrl") ?? undefined,
    connectionStatus: readString(telemetry, "connectionStatus") ?? undefined,
    pausedByOperator: readBoolean(telemetry, "pausedByOperator") ?? undefined,
    operatorGoal: readString(telemetry, "operatorGoal"),
    activeGoal: extractActiveGoal(telemetry),
    journal: extractJournalSection(telemetry),
    agent: extractAgent(telemetry),
    skills: extractSkills(telemetry),
    inventory: extractInventory(telemetry),
    nearby: {
      npcs: extractNearbyNpcs(telemetry),
      players: extractNearbyPlayers(telemetry),
      items: extractNearbyItems(telemetry),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Presentation helpers
// ─────────────────────────────────────────────────────────────────────────

function formatDistance(distance: number | null | undefined): string {
  if (distance === null || distance === undefined) return "?";
  if (distance <= 0) return "here";
  return `${distance} tile${distance === 1 ? "" : "s"}`;
}

function formatPosition(pos: ScapePosition | undefined | null): string {
  if (!pos) return "unknown";
  return `${pos.x}, ${pos.z}`;
}

function formatHp(agent: ScapeAgentSelf | null): string {
  if (!agent || agent.hp === undefined || agent.maxHp === undefined) {
    return "—";
  }
  return `${agent.hp} / ${agent.maxHp}`;
}

// Real SdkConnectionStatus values from plugins/plugin-scape/src/sdk/index.ts:
// idle | connecting | auth-pending | spawn-pending | connected | reconnecting
// | closed | failed
function connectionTone(status: string | undefined): OperatorSurfaceTone {
  switch (status) {
    case "connected":
      return "success";
    case "connecting":
    case "auth-pending":
    case "spawn-pending":
    case "reconnecting":
      return "warn";
    case "failed":
    case "closed":
      return "danger";
    default:
      return "neutral";
  }
}

function connectionLabel(status: string | undefined): string {
  switch (status) {
    case "connected":
      return "Spawned in xRSPS";
    case "auth-pending":
      return "Authenticating…";
    case "spawn-pending":
      return "Waiting for spawn…";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "closed":
      return "Connection closed";
    case "failed":
      return "Connection failed";
    default:
      return "Idle (bot-SDK not configured)";
  }
}

function goalStatusTone(status: string): OperatorSurfaceTone {
  switch (status) {
    case "active":
      return "accent";
    case "completed":
      return "success";
    case "abandoned":
      return "danger";
    case "paused":
      return "warn";
    default:
      return "neutral";
  }
}

function memoryWeightTone(
  weight: number | null | undefined,
): OperatorSurfaceTone {
  if (weight === null || weight === undefined) return "neutral";
  if (weight >= 4) return "accent";
  if (weight >= 3) return "warn";
  return "neutral";
}

function SuggestedPromptButton({
  prompt,
  index,
  disabled,
  onSelect,
}: {
  prompt: string;
  index: number;
  disabled: boolean;
  onSelect: (prompt: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `suggested-prompt-${index}`,
    role: "button",
    label: prompt,
    group: "operator-chat",
    description: `Send the suggested directive "${prompt}" to the agent`,
  });
  return (
    <Button
      ref={ref}
      size="sm"
      variant="outline"
      disabled={disabled}
      onClick={() => {
        onSelect(prompt);
      }}
      {...agentProps}
    >
      {prompt}
    </Button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────

export function ScapeOperatorSurface({
  appName,
  variant = "detail",
  focus = "all",
}: AppOperatorSurfaceProps) {
  const { appRuns } = useApp();
  const { run, matchingRuns } = useMemo(
    () => selectLatestRunForApp(appName, appRuns),
    [appName, appRuns],
  );

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [controlling, setControlling] = useState(false);

  const session = run?.session ?? null;
  const telemetryRecord =
    session?.telemetry && typeof session.telemetry === "object"
      ? session.telemetry
      : null;
  const telemetry = useMemo(
    () => extractTelemetry(telemetryRecord),
    [telemetryRecord],
  );
  const activity = (session?.activity ?? []).slice(0, 3);
  const suggestedPrompts = (session?.suggestedPrompts ?? []).slice(0, 2);

  const agent = telemetry.agent;
  const activeGoal = telemetry.activeGoal;
  const memories = (telemetry.journal?.recent ?? []).slice(0, 2);
  const nearbyNpcs = (telemetry.nearby?.npcs ?? []).slice(0, 3);
  const nearbyPlayers = (telemetry.nearby?.players ?? []).slice(0, 3);
  const nearbyItems = (telemetry.nearby?.items ?? []).slice(0, 3);
  const skills = (telemetry.skills ?? []).slice(0, 5);
  const inventory = (telemetry.inventory ?? []).slice(0, 4);

  const paused =
    telemetry.pausedByOperator === true || session?.status === "paused";
  const connectionStatus = telemetry.connectionStatus ?? "idle";
  const botSdkOnline = connectionStatus === "connected";

  const showDashboard = focus !== "chat";
  const showChat = focus !== "dashboard";
  const surfaceTitle =
    variant === "live"
      ? "'scape Live Dashboard"
      : variant === "running"
        ? "'scape Run Surface"
        : "'scape Operator Surface";

  const sendOperatorMessage = useCallback(
    async (content: string): Promise<boolean> => {
      if (!run || content.length === 0 || sending) return false;
      setSending(true);
      setStatusMessage(null);
      try {
        if (!run.runId) {
          setStatusMessage("Waiting for the 'scape command bridge.");
          return false;
        }
        const response = await client.sendAppRunMessage(run.runId, content);
        setStatusMessage(response.message ?? "Operator message sent.");
        return response.success;
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : "Failed to send operator message.",
        );
        return false;
      } finally {
        setSending(false);
      }
    },
    [run, sending],
  );

  const handleSuggestedPrompt = useCallback(
    async (prompt: string) => {
      await sendOperatorMessage(prompt.trim());
    },
    [sendOperatorMessage],
  );

  const handleControl = useCallback(
    async (action: "pause" | "resume") => {
      if (!run || controlling) return;
      setControlling(true);
      setStatusMessage(null);
      try {
        const response = await client.controlAppRun(run.runId, action);
        setStatusMessage(
          response.message ??
            (action === "pause"
              ? "'scape session paused."
              : "'scape session resumed."),
        );
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : `Failed to ${action} the 'scape session.`,
        );
      } finally {
        setControlling(false);
      }
    },
    [run, controlling],
  );

  const pauseControl = useAgentElement<HTMLButtonElement>({
    id: "control-pause",
    role: "button",
    label: "Pause autonomous loop",
    group: "session-controls",
    description: "Freeze the 'scape agent's autonomous loop",
    status: paused ? "active" : "inactive",
  });
  const resumeControl = useAgentElement<HTMLButtonElement>({
    id: "control-resume",
    role: "button",
    label: "Resume autonomous loop",
    group: "session-controls",
    description: "Let the 'scape agent act again after a pause",
    status: paused ? "inactive" : "active",
  });
  if (!run) {
    const chips: StatChip[] = [
      { icon: "◇", label: "Bot SDK", value: "Token pending", state: "pending" },
      { icon: "◉", label: "Agent", value: "Spawn pending", state: "pending" },
      { icon: "◆", label: "Journal", value: "Goals · memory", state: "idle" },
      { icon: "⚔", label: "World", value: "xRSPS standby", state: "idle" },
    ];
    return (
      <div data-testid="scape-operator-ready">
        <GameSurfaceShell>
          <GameSurfaceHero
            heroUrl={SCAPE_HERO}
            title="'scape"
            statusLabel="xRSPS spawn ready"
            statusState="pending"
            cta={<HeroCta label="Spawn agent" accent={SCAPE_ACCENT} disabled />}
          />
          <GameSurfaceStrip chips={chips} />
          <WaitingForSession
            accent={SCAPE_ACCENT}
            message="Waiting for an xRSPS session. Spawn the agent to stream live perception, goals, the Scape Journal, and nearby world state here."
          />
        </GameSurfaceShell>
      </div>
    );
  }

  const liveChips: StatChip[] = [
    {
      icon: "◇",
      label: "Bot SDK",
      value: botSdkOnline ? "Connected" : connectionStatus,
      state: connectionTone(connectionStatus) === "success"
        ? "ready"
        : connectionTone(connectionStatus) === "danger"
          ? "danger"
          : "pending",
    },
    {
      icon: "◉",
      label: "Agent",
      value: agent?.name ?? "Unspawned",
      state: agent ? "active" : "idle",
    },
    {
      icon: "♥",
      label: "Vitals",
      value: agent ? formatHp(agent) : "—",
      state: agent?.inCombat ? "danger" : agent ? "ready" : "idle",
    },
    {
      icon: "◆",
      label: "Goal",
      value: activeGoal?.title ?? telemetry.operatorGoal ?? "None",
      state: activeGoal || telemetry.operatorGoal ? "active" : "idle",
    },
  ];
  return (
    <div
      data-testid={
        variant === "live"
          ? "scape-live-operator-surface"
          : variant === "running"
            ? "scape-running-operator-surface"
            : "scape-detail-operator-surface"
      }
    >
      <GameSurfaceShell>
        <GameSurfaceHero
          heroUrl={SCAPE_HERO}
          title={surfaceTitle}
          statusLabel={`${run.status}${paused ? " · paused" : ""} · ${run.health.state}`}
          statusState={
            paused ? "pending" : run.health.state === "healthy" ? "ready" : "pending"
          }
          cta={
            <HeroCta
              label={paused ? "Resume" : "Pause"}
              accent={SCAPE_ACCENT}
              disabled={controlling}
              onClick={() => void handleControl(paused ? "resume" : "pause")}
            />
          }
        />
        <GameSurfaceStrip chips={liveChips} />
        <GameSurfaceZone>
          {/* Header badges */}
          <div className="flex flex-wrap items-center gap-2">
            <SurfaceBadge tone={toneForStatusText(run.status)}>
              {run.status}
            </SurfaceBadge>
            <SurfaceBadge tone={toneForViewerAttachment(run.viewerAttachment)}>
              {run.viewerAttachment}
            </SurfaceBadge>
            <SurfaceBadge tone={toneForHealthState(run.health.state)}>
              {run.health.state}
            </SurfaceBadge>
            {paused ? <SurfaceBadge tone="warn">paused</SurfaceBadge> : null}
            <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
              {matchingRuns.length} active run
              {matchingRuns.length === 1 ? "" : "s"}
            </span>
          </div>

      {/* Bot connection + agent identity + goal at-a-glance */}
      {showDashboard ? (
        <SurfaceSection title="Agent">
          <div className="space-y-2">
            <SurfaceCard
              label="Bot SDK"
              value={connectionLabel(connectionStatus)}
              tone={connectionTone(connectionStatus)}
              subtitle={botSdkOnline ? "Perception live" : "SDK offline"}
            />
            <SurfaceCard
              label="Character"
              value={agent?.name ?? "—"}
              subtitle={
                agent
                  ? `Combat ${agent.combatLevel ?? "?"} · HP ${formatHp(agent)} · Run ${agent.runEnergy ?? "?"}%`
                  : "The agent has not spawned yet."
              }
            />
            <SurfaceCard
              label="Location"
              value={formatPosition(agent?.position)}
              subtitle={
                agent?.inCombat
                  ? "Currently in combat."
                  : agent?.tick
                    ? `Tick ${agent.tick}`
                    : "Idle."
              }
            />
            <SurfaceCard
              label="Operator Goal"
              value={telemetry.operatorGoal ?? "No directive set."}
              tone={telemetry.operatorGoal ? "accent" : "neutral"}
              subtitle={telemetry.operatorGoal ? "Active directive" : "Idle"}
            />
          </div>
        </SurfaceSection>
      ) : null}

      {/* Pause / resume — only meaningful when the bot-SDK is live */}
      {showDashboard ? (
        <SurfaceSection title="Controls">
          <div className="flex flex-wrap gap-2">
            <Button
              ref={pauseControl.ref}
              size="sm"
              variant={paused ? "default" : "outline"}
              disabled={controlling || paused}
              onClick={() => {
                void handleControl("pause");
              }}
              aria-current={paused ? "true" : undefined}
              {...pauseControl.agentProps}
            >
              Pause
            </Button>
            <Button
              ref={resumeControl.ref}
              size="sm"
              variant={paused ? "default" : "outline"}
              disabled={controlling || !paused}
              onClick={() => {
                void handleControl("resume");
              }}
              aria-current={!paused ? "true" : undefined}
              {...resumeControl.agentProps}
            >
              Resume
            </Button>
            <span className="ml-auto self-center text-2xs uppercase tracking-[0.16em] text-muted">
              {paused ? "Paused" : botSdkOnline ? "Running" : "Offline"}
            </span>
          </div>
        </SurfaceSection>
      ) : null}

      {/* Active journal goal */}
      {showDashboard && activeGoal ? (
        <SurfaceSection title="Active Goal">
          <div className="rounded-2xl border border-border/35 bg-card/74 p-3">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium text-default">
                {activeGoal.title}
              </div>
              <SurfaceBadge tone={goalStatusTone(activeGoal.status)}>
                {activeGoal.status}
              </SurfaceBadge>
              <SurfaceBadge tone="neutral">{activeGoal.source}</SurfaceBadge>
              {typeof activeGoal.progress === "number" ? (
                <span className="ml-auto text-xs-tight text-muted-strong">
                  {Math.round(activeGoal.progress * 100)}%
                </span>
              ) : null}
            </div>
            {activeGoal.notes ? (
              <p className="mt-2 text-xs leading-5 text-muted-strong">
                {activeGoal.notes}
              </p>
            ) : null}
            {activeGoal.updatedAt > 0 ? (
              <div className="mt-2 text-2xs uppercase tracking-[0.16em] text-muted">
                Updated {formatDetailTimestamp(activeGoal.updatedAt)}
              </div>
            ) : null}
          </div>
        </SurfaceSection>
      ) : null}

      {showChat ? (
        <SurfaceSection title="Steering">
          <div className="space-y-2">
            {suggestedPrompts.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {suggestedPrompts.map((prompt, index) => (
                  <SuggestedPromptButton
                    key={prompt}
                    prompt={prompt}
                    index={index}
                    disabled={sending}
                    onSelect={handleSuggestedPrompt}
                  />
                ))}
              </div>
            ) : null}
            {statusMessage ? (
              <p className="text-xs-tight text-muted-strong">{statusMessage}</p>
            ) : null}
          </div>
        </SurfaceSection>
      ) : null}

      {/* Recent memories from the Scape Journal */}
      {showDashboard ? (
        <SurfaceSection title="Scape Journal">
          {memories.length > 0 ? (
            <ul className="space-y-1.5">
              {memories.map((memory) => (
                <li
                  key={memory.id}
                  className="rounded-xl border border-border/35 bg-card/74 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <SurfaceBadge tone={memoryWeightTone(memory.weight)}>
                      {memory.kind}
                    </SurfaceBadge>
                    {memory.position ? (
                      <span className="text-2xs uppercase tracking-[0.16em] text-muted">
                        {formatPosition(memory.position)}
                      </span>
                    ) : null}
                    <span className="ml-auto text-2xs uppercase tracking-[0.16em] text-muted">
                      {memory.timestamp > 0
                        ? formatDetailTimestamp(memory.timestamp)
                        : ""}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-default">
                    {memory.text}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs-tight text-muted-strong">No journal yet.</p>
          )}
        </SurfaceSection>
      ) : null}

      {/* Nearby NPCs / players / items */}
      {showDashboard ? (
        <SurfaceSection title="Nearby">
          <div className="space-y-2">
            <SurfaceCard
              label="NPCs"
              value={
                nearbyNpcs.length > 0
                  ? nearbyNpcs
                      .map(
                        (npc) =>
                          `${npc.name ?? "unknown"} (${formatDistance(npc.distance)})`,
                      )
                      .join(" · ")
                  : "—"
              }
              subtitle={
                nearbyNpcs.length > 0
                  ? `${nearbyNpcs.length} visible`
                  : "No NPCs"
              }
            />
            <SurfaceCard
              label="Players"
              value={
                nearbyPlayers.length > 0
                  ? nearbyPlayers
                      .map(
                        (player) =>
                          `${player.name ?? "unknown"} (${formatDistance(player.distance)})`,
                      )
                      .join(" · ")
                  : "—"
              }
              subtitle={
                nearbyPlayers.length > 0
                  ? `${nearbyPlayers.length} visible`
                  : "No players"
              }
            />
            <SurfaceCard
              label="Ground Items"
              value={
                nearbyItems.length > 0
                  ? nearbyItems
                      .map(
                        (item) =>
                          `${item.name ?? "unknown"}${
                            item.count && item.count > 1
                              ? ` x${item.count}`
                              : ""
                          }`,
                      )
                      .join(" · ")
                  : "—"
              }
              subtitle={
                nearbyItems.length > 0
                  ? `${nearbyItems.length} drops`
                  : "No drops"
              }
            />
            <SurfaceCard
              label="Inventory"
              value={
                inventory.length > 0
                  ? inventory
                      .map(
                        (item) =>
                          `${item.name ?? "unknown"}${
                            item.count && item.count > 1
                              ? ` x${item.count}`
                              : ""
                          }`,
                      )
                      .join(" · ")
                  : "—"
              }
              subtitle={
                inventory.length > 0
                  ? `${inventory.length} slot${inventory.length === 1 ? "" : "s"}`
                  : "Empty"
              }
            />
          </div>
        </SurfaceSection>
      ) : null}

      {/* Skills snapshot */}
      {showDashboard && skills.length > 0 ? (
        <SurfaceSection title="Skills">
          <div className="flex flex-wrap gap-1.5">
            {skills.map((skill) => (
              <SurfaceBadge key={skill.id ?? skill.name} tone="neutral">
                {skill.name ?? "?"} {skill.level ?? "?"}
              </SurfaceBadge>
            ))}
          </div>
        </SurfaceSection>
      ) : null}

      {/* Autonomous loop recent activity (pushEventLog entries) */}
      {showDashboard && activity.length > 0 ? (
        <SurfaceSection title="Recent Actions">
          <ul className="space-y-1">
            {activity.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-2 rounded-xl border border-border/35 bg-card/74 px-3 py-1.5"
              >
                <SurfaceBadge
                  tone={entry.severity === "warning" ? "warn" : "neutral"}
                >
                  {entry.type}
                </SurfaceBadge>
                <span className="text-xs text-default">{entry.message}</span>
              </li>
            ))}
          </ul>
        </SurfaceSection>
      ) : null}
        </GameSurfaceZone>
      </GameSurfaceShell>
    </div>
  );
}

function ScapeTuiPromptButton({
  prompt,
  index,
  disabled,
  onSelect,
}: {
  prompt: string;
  index: number;
  disabled: boolean;
  onSelect: (prompt: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tui-suggested-prompt-${index}`,
    role: "button",
    label: prompt,
    group: "tui-scape-controls",
    description: `Send the suggested directive "${prompt}" to the 'scape agent`,
    onActivate: () => onSelect(prompt),
  });
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={() => onSelect(prompt)}
      style={tuiButtonStyle}
      {...agentProps}
    >
      {prompt}
    </button>
  );
}

export function ScapeTuiView() {
  const { appRuns, setActionNotice } = useApp();
  const { run, matchingRuns } = useMemo(
    () => selectLatestRunForApp("@elizaos/plugin-scape", appRuns),
    [appRuns],
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const session = run?.session ?? null;
  const telemetryRecord =
    session?.telemetry && typeof session.telemetry === "object"
      ? session.telemetry
      : null;
  const telemetry = useMemo(
    () => extractTelemetry(telemetryRecord),
    [telemetryRecord],
  );
  const suggestedPrompts = session?.suggestedPrompts ?? [];
  const agent = telemetry.agent;
  const activeGoal = telemetry.activeGoal;
  const paused =
    telemetry.pausedByOperator === true || session?.status === "paused";
  const canSend = Boolean(session?.canSendCommands);
  const viewState = {
    viewType: "tui",
    viewId: "scape",
    appName: "@elizaos/plugin-scape",
    runId: run?.runId ?? null,
    status: run?.status ?? "idle",
    health: run?.health.state ?? null,
    viewerAttachment: run?.viewerAttachment ?? null,
    activeRunCount: matchingRuns.length,
    sessionStatus: session?.status ?? null,
    canSend,
    paused,
    connectionStatus: telemetry.connectionStatus ?? "idle",
    agent: agent
      ? {
          name: agent.name ?? null,
          combatLevel: agent.combatLevel ?? null,
          hp: agent.hp ?? null,
          maxHp: agent.maxHp ?? null,
          runEnergy: agent.runEnergy ?? null,
          inCombat: agent.inCombat ?? false,
          position: agent.position ?? null,
        }
      : null,
    activeGoal: activeGoal
      ? {
          id: activeGoal.id,
          title: activeGoal.title,
          status: activeGoal.status,
          progress: activeGoal.progress,
        }
      : null,
    inventoryCount: telemetry.inventory?.length ?? 0,
    skillCount: telemetry.skills?.length ?? 0,
    memoryCount: telemetry.journal?.memoryCount ?? 0,
    nearbyNpcCount: telemetry.nearby?.npcs?.length ?? 0,
    nearbyPlayerCount: telemetry.nearby?.players?.length ?? 0,
    nearbyItemCount: telemetry.nearby?.items?.length ?? 0,
    suggestedPromptCount: suggestedPrompts.length,
  };

  const sendDraft = async (content: string) => {
    const trimmed = content.trim();
    if (!run?.runId || !trimmed || sending) return;
    setSending(true);
    try {
      const response = await client.sendAppRunMessage(run.runId, trimmed);
      setActionNotice(
        response.message,
        response.success ? "success" : "error",
        2600,
      );
      setDraft("");
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : "Failed to send operator message.",
        "error",
        3200,
      );
    } finally {
      setSending(false);
    }
  };

  const tuiCommandInput = useAgentElement<HTMLInputElement>({
    id: "tui-command-input",
    role: "text-input",
    label: "'scape command",
    group: "tui-scape-controls",
    description: "Natural-language operator instruction for the 'scape agent",
    getValue: () => draft,
    onFill: (value) => setDraft(value),
  });
  const tuiSendControl = useAgentElement<HTMLButtonElement>({
    id: "tui-send-command",
    role: "button",
    label: "Send command",
    group: "tui-scape-controls",
    description: "Send the typed directive to the 'scape agent",
    onActivate: () => void sendDraft(draft),
  });

  return (
    <div data-view-state={JSON.stringify(viewState)} style={tuiRootStyle}>
      <div style={tuiRouteStyle}>elizaos://scape --type=tui</div>
      <div data-status={run?.status ?? "idle"} style={tuiMetaStyle}>
        {run?.status ?? "idle"} | {telemetry.connectionStatus ?? "idle"} |{" "}
        {paused ? "paused" : "running"}
      </div>
      <section style={tuiPanelStyle} aria-label="'scape state">
        <strong style={tuiTitleStyle}>'scape</strong>
        <div>run {run?.runId ?? "none"}</div>
        <div>agent {agent?.name ?? "unknown"}</div>
        <div>
          position{" "}
          {agent?.position
            ? `${agent.position.x}, ${agent.position.z}`
            : "unknown"}
        </div>
        <div>goal {activeGoal?.title ?? telemetry.operatorGoal ?? "none"}</div>
        <div>commands {canSend ? "available" : "unavailable"}</div>
        <div style={tuiSubtleStyle}>suggested prompts</div>
        {(suggestedPrompts.length
          ? suggestedPrompts
          : ["check status", "set goal", "pause"]
        )
          .slice(0, 6)
          .map((prompt, index) => (
            <ScapeTuiPromptButton
              key={prompt}
              prompt={prompt}
              index={index}
              disabled={!canSend || sending}
              onSelect={(value) => void sendDraft(value)}
            />
          ))}
        <input
          ref={tuiCommandInput.ref}
          aria-label="'scape command"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void sendDraft(draft);
          }}
          placeholder="Send an operator instruction..."
          style={tuiInputStyle}
          {...tuiCommandInput.agentProps}
        />
        <button
          ref={tuiSendControl.ref}
          type="button"
          disabled={!canSend || sending || !draft.trim()}
          onClick={() => void sendDraft(draft)}
          style={tuiButtonStyle}
          {...tuiSendControl.agentProps}
        >
          send command
        </button>
      </section>
    </div>
  );
}

const tuiRootStyle: CSSProperties = {
  minHeight: "100vh",
  background: "#020617",
  color: "#cbd5e1",
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  padding: 20,
};
const tuiRouteStyle: CSSProperties = { color: "#7dd3fc", marginBottom: 4 };
const tuiMetaStyle: CSSProperties = { color: "#475569", marginBottom: 16 };
const tuiPanelStyle: CSSProperties = {
  border: "1px solid rgba(125,211,252,0.3)",
  borderRadius: 6,
  padding: 16,
  maxWidth: 760,
};
const tuiTitleStyle: CSSProperties = {
  display: "block",
  color: "#e2e8f0",
  marginBottom: 10,
};
const tuiSubtleStyle: CSSProperties = { color: "#64748b", marginTop: 14 };
const tuiButtonStyle: CSSProperties = {
  display: "block",
  width: "100%",
  margin: "8px 0",
  background: "transparent",
  color: "#a7f3d0",
  border: "1px solid rgba(167,243,208,0.45)",
  borderRadius: 4,
  padding: "6px 8px",
  cursor: "pointer",
  fontFamily: "inherit",
};
const tuiInputStyle: CSSProperties = {
  width: "100%",
  marginTop: 14,
  background: "#020617",
  color: "#e2e8f0",
  border: "1px solid rgba(125,211,252,0.35)",
  borderRadius: 4,
  padding: "8px",
  fontFamily: "inherit",
};
