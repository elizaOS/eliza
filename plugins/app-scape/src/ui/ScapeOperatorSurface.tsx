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
  type SurfaceTone,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
  useApp,
} from "@elizaos/app-core";
import { Button, Input } from "@elizaos/ui";
import { useCallback, useMemo, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────
// Telemetry shape — a partial view of what buildScapeSessionState emits.
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

// Real SdkConnectionStatus values from plugins/app-scape/src/sdk/index.ts:
// idle | connecting | auth-pending | spawn-pending | connected | reconnecting
// | closed | failed
function connectionTone(status: string | undefined): SurfaceTone {
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

function goalStatusTone(status: string): SurfaceTone {
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

function memoryWeightTone(weight: number | null | undefined): SurfaceTone {
  if (weight === null || weight === undefined) return "neutral";
  if (weight >= 4) return "accent";
  if (weight >= 3) return "warn";
  return "neutral";
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

  const [operatorMessage, setOperatorMessage] = useState("");
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
  const activity = session?.activity ?? [];
  const suggestedPrompts = session?.suggestedPrompts ?? [];

  const agent = telemetry.agent;
  const activeGoal = telemetry.activeGoal;
  const memories = telemetry.journal?.recent ?? [];
  const nearbyNpcs = telemetry.nearby?.npcs ?? [];
  const nearbyPlayers = telemetry.nearby?.players ?? [];
  const nearbyItems = telemetry.nearby?.items ?? [];
  const skills = telemetry.skills ?? [];
  const inventory = telemetry.inventory ?? [];

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

  const handleSendMessage = useCallback(async () => {
    const content = operatorMessage.trim();
    if (content.length === 0) return;
    const sent = await sendOperatorMessage(content);
    if (sent) setOperatorMessage("");
  }, [operatorMessage, sendOperatorMessage]);

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

  if (!run) {
    return (
      <SurfaceEmptyState
        title="'scape operator surface"
        body="Launch 'scape to watch the agent spawn in xRSPS, then steer it from here with natural-language directives."
      />
    );
  }

  return (
    <section
      className={`space-y-3 ${variant === "live" ? "p-3" : ""}`}
      data-testid={
        variant === "live"
          ? "scape-live-operator-surface"
          : variant === "running"
            ? "scape-running-operator-surface"
            : "scape-detail-operator-surface"
      }
    >
      {/* Header badges */}
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
        {paused ? <SurfaceBadge tone="warn">paused</SurfaceBadge> : null}
        <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
          {matchingRuns.length} active run{matchingRuns.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Bot connection + agent identity + goal at-a-glance */}
      {showDashboard ? (
        <SurfaceSection title="Agent">
          <SurfaceGrid>
            <SurfaceCard
              label="Bot SDK"
              value={connectionLabel(connectionStatus)}
              tone={connectionTone(connectionStatus)}
              subtitle={
                botSdkOnline
                  ? "Autonomous loop is receiving perception."
                  : "Set SCAPE_BOT_SDK_URL + SCAPE_BOT_SDK_TOKEN to bring the agent online."
              }
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
              subtitle={
                telemetry.operatorGoal
                  ? "Active until the agent completes it or you override."
                  : "Type a directive below or pick a suggested prompt."
              }
            />
          </SurfaceGrid>
        </SurfaceSection>
      ) : null}

      {/* Pause / resume — only meaningful when the bot-SDK is live */}
      {showDashboard ? (
        <SurfaceSection title="Session Controls">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={paused ? "default" : "outline"}
              disabled={controlling || paused}
              onClick={() => {
                void handleControl("pause");
              }}
            >
              Pause autonomous loop
            </Button>
            <Button
              size="sm"
              variant={paused ? "default" : "outline"}
              disabled={controlling || !paused}
              onClick={() => {
                void handleControl("resume");
              }}
            >
              Resume autonomous loop
            </Button>
            <span className="ml-auto self-center text-xs-tight text-muted-strong">
              {paused
                ? "Loop is paused. Resume to let the agent act again."
                : botSdkOnline
                  ? "Loop is running. Pause to freeze the agent."
                  : "Loop is offline until the bot-SDK connects."}
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

      {/* Operator chat */}
      {showChat ? (
        <SurfaceSection title="Steer the Agent">
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                value={operatorMessage}
                onChange={(event) => {
                  setOperatorMessage(event.target.value);
                }}
                placeholder="Tell the agent what to do — e.g. 'go kill 20 chickens in Lumbridge'"
                disabled={sending}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSendMessage();
                  }
                }}
              />
              <Button
                size="sm"
                disabled={sending || operatorMessage.trim().length === 0}
                onClick={() => {
                  void handleSendMessage();
                }}
              >
                Send
              </Button>
            </div>
            {suggestedPrompts.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {suggestedPrompts.map((prompt) => (
                  <Button
                    key={prompt}
                    size="sm"
                    variant="outline"
                    disabled={sending}
                    onClick={() => {
                      void handleSuggestedPrompt(prompt);
                    }}
                  >
                    {prompt}
                  </Button>
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
            <p className="text-xs-tight text-muted-strong">
              The agent has not written any memories yet. Directives, spawn
              events, and notable encounters will appear here.
            </p>
          )}
        </SurfaceSection>
      ) : null}

      {/* Nearby NPCs / players / items */}
      {showDashboard ? (
        <SurfaceSection title="Nearby">
          <SurfaceGrid>
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
                  : "None in view."
              }
              subtitle={
                nearbyNpcs.length > 0
                  ? `${nearbyNpcs.length} reported by perception`
                  : "Autonomous loop has not reported any NPCs."
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
                  : "None in view."
              }
              subtitle={
                nearbyPlayers.length > 0
                  ? `${nearbyPlayers.length} human players nearby`
                  : "No other players within perception range."
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
                  : "Nothing to loot."
              }
              subtitle={
                nearbyItems.length > 0
                  ? "Tell the agent to pick it up with a directive below."
                  : "No drops within perception range."
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
                  : "Empty."
              }
              subtitle={
                inventory.length > 0
                  ? `${inventory.length} slot${inventory.length === 1 ? "" : "s"} held`
                  : "The agent is carrying nothing."
              }
            />
          </SurfaceGrid>
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
            {activity.slice(0, 8).map((entry) => (
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
    </section>
  );
}
