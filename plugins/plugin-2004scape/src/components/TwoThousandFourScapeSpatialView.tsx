/**
 * TwoThousandFourScapeSpatialView - the 2004scape operator surface authored once
 * with the spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a typed snapshot + an action callback in,
 * primitives out). It imports only the cross-modality primitives, so it is safe
 * to render in the Node agent process where the terminal lives - no app-core
 * `useApp()` context, no `useAgentElement`, no Tailwind, no CSS-var theming
 * beyond what the primitives already resolve.
 *
 * The rich GUI component (`TwoThousandFourScapeOperatorSurface`) is unchanged;
 * this view is additive. A host factors the live `useApp()` run + session +
 * telemetry into the {@link TwoThousandFourScapeSnapshot} shape and feeds it in.
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

export type TwoThousandFourScapeRunStatus =
  | "idle"
  | "running"
  | "paused"
  | "connecting"
  | "disconnected"
  | "error";

export interface TwoThousandFourScapePlayer {
  name: string | null;
  worldX: number | null;
  worldZ: number | null;
  hp: number | null;
  maxHp: number | null;
}

export interface TwoThousandFourScapeTarget {
  id: string;
  /** NPC or location object display name. */
  name: string;
  /** Distance in tiles, or null when unknown ("nearby"). */
  distance: number | null;
  /** Primary interact option (e.g. "Chop down", "Talk-to"), or null. */
  action: string | null;
}

export interface TwoThousandFourScapeFeedEntry {
  id: string;
  /** Sender / source label (e.g. "Game", "Dialog"). */
  label: string;
  detail: string;
}

export interface TwoThousandFourScapeActivityEntry {
  id: string;
  action: string;
  detail: string;
  /** Pre-formatted short timestamp, or null. */
  when: string | null;
}

export interface TwoThousandFourScapeSnapshot {
  /** Whether a live run/session exists at all. */
  hasRun: boolean;
  runId: string | null;
  sessionId: string | null;
  status: TwoThousandFourScapeRunStatus;
  /** Count of active runs for this app. */
  activeRunCount: number;
  canSendCommands: boolean;
  autoPlayEnabled: boolean;
  /** Current bot intent (e.g. "tutorial", "woodcut"), or null. */
  intent: string | null;
  tutorialActive: boolean;
  tutorialPrompt: string | null;
  player: TwoThousandFourScapePlayer;
  /** Combat-style weapon name, or null. */
  weaponName: string | null;
  /** Active combat style label (e.g. "Accurate"), or null. */
  combatStyle: string | null;
  /** "Woodcutting 5 · Hitpoints 10" style skill summary, or null. */
  skillsSummary: string | null;
  /** "Bronze axe · Logs x3" style inventory summary, or null. */
  inventorySummary: string | null;
  nearbyTargets: TwoThousandFourScapeTarget[];
  gameFeed: TwoThousandFourScapeFeedEntry[];
  recentActivity: TwoThousandFourScapeActivityEntry[];
  suggestedPrompts: string[];
  /** Which control affordances the session exposes. */
  controls: Array<"pause" | "resume">;
}

export const EMPTY_2004SCAPE_SNAPSHOT: TwoThousandFourScapeSnapshot = {
  hasRun: false,
  runId: null,
  sessionId: null,
  status: "idle",
  activeRunCount: 0,
  canSendCommands: false,
  autoPlayEnabled: false,
  intent: null,
  tutorialActive: false,
  tutorialPrompt: null,
  player: { name: null, worldX: null, worldZ: null, hp: null, maxHp: null },
  weaponName: null,
  combatStyle: null,
  skillsSummary: null,
  inventorySummary: null,
  nearbyTargets: [],
  gameFeed: [],
  recentActivity: [],
  suggestedPrompts: [],
  controls: [],
};

function statusTone(status: TwoThousandFourScapeRunStatus): SpatialTone {
  switch (status) {
    case "running":
      return "success";
    case "paused":
    case "connecting":
      return "warning";
    case "disconnected":
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

/** Format player coords + HP into one display line. */
export function formatPlayerLine(player: TwoThousandFourScapePlayer): string {
  const coords =
    player.worldX !== null && player.worldZ !== null
      ? `${player.worldX}, ${player.worldZ}`
      : "coords pending";
  const hp =
    player.hp !== null && player.maxHp !== null
      ? `${player.hp}/${player.maxHp} HP`
      : "HP pending";
  return `${coords} - ${hp}`;
}

function formatDistance(distance: number | null): string {
  return distance === null ? "nearby" : `${distance.toFixed(1)} tiles`;
}

export interface TwoThousandFourScapeSpatialViewProps {
  snapshot: TwoThousandFourScapeSnapshot;
  /** Dispatch by agent id: `prompt:<text>`, `control:pause`, `control:resume`. */
  onAction?: (action: string) => void;
}

export function TwoThousandFourScapeSpatialView({
  snapshot,
  onAction,
}: TwoThousandFourScapeSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const player = snapshot.player;
  const playerName = player.name ?? "no player";

  if (!snapshot.hasRun) {
    return (
      <Card title="2004scape" gap={1} padding={1}>
        <Text style="caption" tone="muted">
          Bot SDK standby
        </Text>
        <Divider label="session" />
        <Text tone="muted" align="center" style="caption">
          Waiting for a 2004scape session. Spawn the bot to stream live player
          telemetry, the tutorial flow, nearby targets, and the game feed.
        </Text>
      </Card>
    );
  }

  return (
    <Card title="2004scape" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="caption" tone={statusTone(snapshot.status)} grow={1}>
          {snapshot.status}
        </Text>
        <Text style="caption" tone="muted">
          autoplay {snapshot.autoPlayEnabled ? "on" : "off"}
        </Text>
        <Text style="caption" tone="muted">
          {snapshot.activeRunCount} active
        </Text>
      </HStack>

      <HStack gap={1} align="center">
        <Text style="caption" tone="muted">
          intent
        </Text>
        <Text style="caption" tone="primary" grow={1}>
          {snapshot.intent ?? (snapshot.status === "paused" ? "paused" : "-")}
        </Text>
        <Text
          style="caption"
          tone={snapshot.canSendCommands ? "success" : "warning"}
        >
          {snapshot.canSendCommands ? "steering-ready" : "steering-wait"}
        </Text>
      </HStack>

      <Divider label="player" />
      <Text bold wrap={false}>
        {playerName}
      </Text>
      <Text style="caption" tone="muted">
        {formatPlayerLine(player)}
      </Text>
      {snapshot.weaponName || snapshot.combatStyle ? (
        <Text style="caption" tone="muted" wrap={false}>
          {[snapshot.weaponName, snapshot.combatStyle]
            .filter((value): value is string => Boolean(value))
            .join(" - ")}
        </Text>
      ) : null}
      {snapshot.skillsSummary ? (
        <Text style="caption" tone="muted">
          {snapshot.skillsSummary}
        </Text>
      ) : null}
      {snapshot.inventorySummary ? (
        <Text style="caption" tone="muted">
          {snapshot.inventorySummary}
        </Text>
      ) : null}

      <Divider label="tutorial" />
      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={snapshot.tutorialActive ? "warning" : "success"}
        >
          {snapshot.tutorialActive ? "in-progress" : "clear"}
        </Text>
        <Text style="caption" tone="muted" grow={1} wrap={false}>
          {snapshot.tutorialPrompt ?? "Tutorial is clear."}
        </Text>
      </HStack>

      <Divider label={`targets (${snapshot.nearbyTargets.length})`} />
      {snapshot.nearbyTargets.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No nearby targets reported yet.
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.nearbyTargets.slice(0, 4).map((target) => (
            <HStack
              key={target.id}
              gap={1}
              align="center"
              agent={`target-${target.id}`}
            >
              <Text tone="primary">*</Text>
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {target.name}
                </Text>
                {target.action ? (
                  <Text style="caption" tone="muted" wrap={false}>
                    {target.action}
                  </Text>
                ) : null}
              </VStack>
              <Text style="caption" tone="muted">
                {formatDistance(target.distance)}
              </Text>
            </HStack>
          ))}
        </List>
      )}

      {snapshot.gameFeed.length > 0 ? (
        <>
          <Divider label="game feed" />
          <List gap={0}>
            {snapshot.gameFeed.slice(0, 4).map((entry) => (
              <HStack key={entry.id} gap={1} align="start">
                <Text style="caption" tone="muted" wrap={false}>
                  {entry.label}
                </Text>
                <Text style="caption" grow={1}>
                  {entry.detail}
                </Text>
              </HStack>
            ))}
          </List>
        </>
      ) : null}

      {snapshot.recentActivity.length > 0 ? (
        <>
          <Divider label="recent activity" />
          <List gap={0}>
            {snapshot.recentActivity.slice(0, 4).map((entry) => (
              <HStack key={entry.id} gap={1} align="center">
                <Text style="caption" wrap={false}>
                  {entry.action}
                </Text>
                <Text style="caption" tone="muted" grow={1}>
                  {entry.detail}
                </Text>
                {entry.when ? (
                  <Text style="caption" tone="muted" wrap={false}>
                    {entry.when}
                  </Text>
                ) : null}
              </HStack>
            ))}
          </List>
        </>
      ) : null}

      <Divider label="steering" />
      {snapshot.suggestedPrompts.length > 0 ? (
        <HStack gap={1} wrap>
          {snapshot.suggestedPrompts.slice(0, 6).map((prompt) => (
            <Button
              key={prompt}
              variant="outline"
              tone="default"
              disabled={!snapshot.canSendCommands}
              agent={`prompt-${prompt}`}
              onPress={dispatch(`prompt:${prompt}`)}
            >
              {prompt}
            </Button>
          ))}
        </HStack>
      ) : (
        <Text tone="muted" align="center" style="caption">
          No suggested prompts.
        </Text>
      )}
      <HStack gap={1} wrap>
        {snapshot.controls.includes("pause") ? (
          <Button
            grow={1}
            variant="outline"
            tone="warning"
            agent="control-pause"
            onPress={dispatch("control:pause")}
          >
            Pause
          </Button>
        ) : null}
        {snapshot.controls.includes("resume") ? (
          <Button
            grow={1}
            agent="control-resume"
            onPress={dispatch("control:resume")}
          >
            Resume
          </Button>
        ) : null}
      </HStack>
    </Card>
  );
}
