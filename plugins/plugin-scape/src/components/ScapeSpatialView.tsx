/**
 * ScapeSpatialView — the 'scape operator surface authored once with the spatial
 * vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no app-shell runtime
 * import). The snapshot mirrors the real producer telemetry that
 * `buildScapeSessionState` (routes.ts) emits, reshaped into the small flat view
 * model the surface needs.
 */

import {
  Button,
  Card,
  Divider,
  HStack,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

export interface ScapePosition {
  x: number;
  z: number;
}

export interface ScapeAgentRow {
  name: string;
  combatLevel: number | null;
  hp: number | null;
  maxHp: number | null;
  runEnergy: number | null;
  inCombat: boolean;
  position: ScapePosition | null;
  tick: number | null;
}

export interface ScapeGoalRow {
  id: string;
  title: string;
  status: string;
  /** 0..1 fraction, or null when the goal tracks no progress. */
  progress: number | null;
  notes: string | null;
}

export interface ScapeSkillRow {
  name: string;
  level: number | null;
  xp: number | null;
}

export interface ScapeInventoryRow {
  itemId: number | null;
  name: string;
  count: number;
  slot: number | null;
}

export interface ScapeNearbyRow {
  id: string;
  name: string;
  /** Pre-formatted distance label ("here", "1 tile", "3 tiles", "?"). */
  distance: string;
}

export interface ScapeMemoryRow {
  id: string;
  kind: string;
  text: string;
  weight: number | null;
}

export interface ScapeActionRow {
  id: string;
  action: string;
  message: string;
  success: boolean;
}

export interface ScapeSnapshot {
  /** SdkConnectionStatus: idle | connecting | ... | connected | failed | closed. */
  connectionStatus: string;
  pausedByOperator: boolean;
  operatorGoal: string | null;
  /** Whether the host can dispatch operator commands for this run. */
  canSend: boolean;
  activeGoal: ScapeGoalRow | null;
  agent: ScapeAgentRow | null;
  skills: ScapeSkillRow[];
  inventory: ScapeInventoryRow[];
  nearbyNpcs: ScapeNearbyRow[];
  nearbyPlayers: ScapeNearbyRow[];
  nearbyItems: ScapeNearbyRow[];
  memoryCount: number;
  recentMemories: ScapeMemoryRow[];
  recentActions: ScapeActionRow[];
  suggestedPrompts: string[];
  draft?: string;
}

const FALLBACK_PROMPTS = ["check status", "set goal", "pause"] as const;

function connectionTone(status: string): SpatialTone {
  switch (status) {
    case "connected":
      return "success";
    case "connecting":
    case "auth-pending":
    case "spawn-pending":
    case "reconnecting":
      return "warning";
    case "failed":
    case "closed":
      return "danger";
    default:
      return "muted";
  }
}

function goalStatusTone(status: string): SpatialTone {
  switch (status) {
    case "active":
      return "primary";
    case "completed":
      return "success";
    case "abandoned":
      return "danger";
    case "paused":
      return "warning";
    default:
      return "muted";
  }
}

function memoryWeightTone(weight: number | null): SpatialTone {
  if (weight === null) return "muted";
  if (weight >= 4) return "primary";
  if (weight >= 3) return "warning";
  return "muted";
}

function formatPosition(pos: ScapePosition | null): string {
  return pos ? `${pos.x}, ${pos.z}` : "unknown";
}

function formatHp(agent: ScapeAgentRow | null): string {
  if (!agent || agent.hp === null || agent.maxHp === null) return "-";
  return `${agent.hp} / ${agent.maxHp}`;
}

/** ASCII progress bar of width-1 cells, e.g. "[####------] 40%". */
function progressBar(progress: number | null): string {
  if (progress === null) return "no progress tracked";
  const pct = Math.max(0, Math.min(1, progress));
  const filled = Math.round(pct * 10);
  const bar = `${"#".repeat(filled)}${"-".repeat(10 - filled)}`;
  return `[${bar}] ${Math.round(pct * 100)}%`;
}

export interface ScapeSpatialViewProps {
  snapshot: ScapeSnapshot;
  /**
   * Dispatch by agent id: `pause`, `resume`, `send`, `prompt:<text>`,
   * `goal:focus`.
   */
  onAction?: (action: string) => void;
}

export function ScapeSpatialView({
  snapshot,
  onAction,
}: ScapeSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const {
    connectionStatus,
    pausedByOperator,
    operatorGoal,
    canSend,
    activeGoal,
    agent,
    skills,
    inventory,
    nearbyNpcs,
    nearbyPlayers,
    nearbyItems,
    memoryCount,
    recentMemories,
    recentActions,
    suggestedPrompts,
  } = snapshot;
  const prompts = suggestedPrompts.length
    ? suggestedPrompts
    : [...FALLBACK_PROMPTS];

  return (
    <Card title="'scape Operator" gap={1} padding={1}>
      {/* Hero banner / status strip. */}
      <HStack gap={1} align="center" wrap>
        <Text
          style="caption"
          tone={connectionTone(connectionStatus)}
          grow={1}
          wrap={false}
        >
          {connectionStatus}
        </Text>
        <Text
          style="caption"
          tone={pausedByOperator ? "warning" : "success"}
          wrap={false}
        >
          {pausedByOperator ? "paused" : "running"}
        </Text>
        <Text style="caption" tone="muted" wrap={false}>
          {canSend ? "commands ready" : "commands unavailable"}
        </Text>
      </HStack>

      {operatorGoal ? (
        <Text style="caption" tone="primary" wrap={false}>
          steer: {operatorGoal}
        </Text>
      ) : null}

      {/* Agent vitals. */}
      <Divider label="agent" />
      {agent ? (
        <VStack gap={0}>
          <HStack gap={1} align="center">
            <Text bold grow={1} wrap={false}>
              {agent.name}
            </Text>
            <Text style="caption" tone="muted" wrap={false}>
              cb {agent.combatLevel ?? "?"}
            </Text>
            <Text
              style="caption"
              tone={agent.inCombat ? "danger" : "muted"}
              wrap={false}
            >
              {agent.inCombat ? "in combat" : "idle"}
            </Text>
          </HStack>
          <HStack gap={1}>
            <Text style="caption" tone="muted" grow={1} wrap={false}>
              hp {formatHp(agent)}
            </Text>
            <Text style="caption" tone="muted" wrap={false}>
              run {agent.runEnergy ?? "?"}%
            </Text>
            <Text style="caption" tone="muted" wrap={false}>
              tick {agent.tick ?? "?"}
            </Text>
          </HStack>
          <Text style="caption" tone="muted" wrap={false}>
            pos {formatPosition(agent.position)}
          </Text>
        </VStack>
      ) : (
        <Text tone="muted" style="caption">
          agent unknown
        </Text>
      )}

      {/* Operator controls. */}
      <Divider label="controls" />
      <HStack gap={1} wrap>
        {pausedByOperator ? (
          <Button
            grow={1}
            tone="success"
            agent="resume"
            onPress={dispatch("resume")}
          >
            Resume
          </Button>
        ) : (
          <Button
            grow={1}
            variant="outline"
            tone="warning"
            agent="pause"
            onPress={dispatch("pause")}
          >
            Pause
          </Button>
        )}
        <Button
          variant="outline"
          tone="default"
          grow={1}
          disabled={!canSend}
          agent="send"
          onPress={dispatch("send")}
        >
          Send command
        </Button>
      </HStack>

      {/* Active goal + progress. */}
      <Divider label="active goal" />
      {activeGoal ? (
        <VStack gap={0} agent="goal-active">
          <HStack gap={1} align="center">
            <Text bold grow={1}>
              {activeGoal.title}
            </Text>
            <Text style="caption" tone={goalStatusTone(activeGoal.status)}>
              {activeGoal.status}
            </Text>
          </HStack>
          <Text style="caption" tone="muted" wrap={false}>
            {progressBar(activeGoal.progress)}
          </Text>
          {activeGoal.notes ? (
            <Text style="caption" tone="muted">
              {activeGoal.notes}
            </Text>
          ) : null}
        </VStack>
      ) : (
        <Text tone="muted" style="caption">
          no active goal
        </Text>
      )}

      {/* Steering — suggested prompts. */}
      <Divider label="steering" />
      <List gap={0}>
        {prompts.map((prompt, index) => (
          <Button
            key={prompt}
            variant="ghost"
            tone="default"
            width="100%"
            disabled={!canSend}
            agent={`prompt-${index}`}
            onPress={dispatch(`prompt:${prompt}`)}
          >
            {prompt}
          </Button>
        ))}
      </List>

      {/* Journal. */}
      <Divider label={`journal (${memoryCount})`} />
      {recentMemories.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          no memories yet
        </Text>
      ) : (
        <List gap={0}>
          {recentMemories.slice(0, 4).map((memory) => (
            <HStack key={memory.id} gap={1} agent={`memory-${memory.id}`}>
              <Text tone={memoryWeightTone(memory.weight)} wrap={false}>
                {memory.weight !== null && memory.weight >= 4 ? "*" : "."}
              </Text>
              <Text style="caption" grow={1}>
                {memory.text}
              </Text>
            </HStack>
          ))}
        </List>
      )}

      {/* Nearby world entities. */}
      <Divider label="nearby" />
      <HStack gap={1} align="start" wrap>
        <NearbyColumn label="npcs" rows={nearbyNpcs} />
        <NearbyColumn label="players" rows={nearbyPlayers} />
        <NearbyColumn label="items" rows={nearbyItems} />
      </HStack>

      {/* Skills. */}
      <Divider label="skills" />
      {skills.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          no skills
        </Text>
      ) : (
        <HStack gap={1} wrap>
          {skills.slice(0, 8).map((skill) => (
            <Text key={skill.name} style="caption" tone="muted" wrap={false}>
              {skill.name} {skill.level ?? "?"}
            </Text>
          ))}
        </HStack>
      )}

      {/* Inventory. */}
      <Divider label="inventory" />
      {inventory.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          empty
        </Text>
      ) : (
        <List gap={0}>
          {inventory.slice(0, 6).map((item) => (
            <HStack key={`${item.slot}:${item.itemId}`} gap={1}>
              <Text style="caption" grow={1} wrap={false}>
                {item.name}
              </Text>
              <Text style="caption" tone="muted" wrap={false}>
                x{item.count}
              </Text>
            </HStack>
          ))}
        </List>
      )}

      {/* Recent actions. */}
      <Divider label="recent actions" />
      {recentActions.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          no actions yet
        </Text>
      ) : (
        <List gap={0}>
          {recentActions.slice(0, 4).map((entry) => (
            <HStack key={entry.id} gap={1}>
              <Text tone={entry.success ? "success" : "danger"} wrap={false}>
                {entry.success ? "+" : "x"}
              </Text>
              <Text style="caption" grow={1} wrap={false}>
                {entry.action}
              </Text>
            </HStack>
          ))}
        </List>
      )}
    </Card>
  );
}

function NearbyColumn({
  label,
  rows,
}: {
  label: string;
  rows: ScapeNearbyRow[];
}) {
  return (
    <VStack gap={0} grow={1}>
      <Text style="label" tone="muted" wrap={false}>
        {label} ({rows.length})
      </Text>
      {rows.length === 0 ? (
        <Text style="caption" tone="muted" wrap={false}>
          none
        </Text>
      ) : (
        rows.slice(0, 3).map((row) => (
          <HStack key={row.id} gap={1}>
            <Text style="caption" grow={1} wrap={false}>
              {row.name}
            </Text>
            <Text style="caption" tone="muted" wrap={false}>
              {row.distance}
            </Text>
          </HStack>
        ))
      )}
    </VStack>
  );
}
