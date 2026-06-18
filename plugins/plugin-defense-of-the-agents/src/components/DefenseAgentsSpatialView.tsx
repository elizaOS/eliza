/**
 * DefenseAgentsSpatialView - the Defense of the Agents operator surface authored
 * once with the spatial vocabulary, so it renders correctly wherever it is shown:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out). It imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no app-core/ui-compat
 * runtime import, no DOM-only operator shell).
 *
 * This is ADDITIVE: the existing `DefenseAgentsOperatorSurface` (DOM) and
 * `DefenseAgentsTuiView` are untouched. This view is the single unified source
 * the spatial framework renders to all three modalities.
 */

import {
  Button,
  Card,
  Divider,
  HStack,
  List,
  type SpatialTone,
  Text,
} from "@elizaos/ui/spatial";

/** Status severity for an event-log entry. */
export type DefenseEventTone = "info" | "success" | "warning" | "error";

export interface DefenseEventRow {
  id: string;
  /** Short kind/label, e.g. "command", "respawn", "error". */
  label: string;
  message: string;
  tone: DefenseEventTone;
}

/** Lane the hero can be moved to. */
export type DefenseLane = "top" | "mid" | "bot";

export interface DefenseSnapshot {
  /** Run lifecycle status as reported by the host (running/ready/degraded/...). */
  status: string;
  /** Active run id, or null when no match is live. */
  runId: string | null;
  /** Whether the host can currently relay commands to the game. */
  canSendCommands: boolean;
  /** Hero class, e.g. "mage". Null until deployed. */
  heroClass: string | null;
  /** Lane the hero currently holds, or null when unassigned. */
  heroLane: DefenseLane | null;
  heroLevel: number | null;
  heroHp: number | null;
  heroMaxHp: number | null;
  /** Whether the auto-play heuristic loop is active. */
  autoPlay: boolean;
  /** Human-readable objective line, e.g. "Mage holding mid lane". */
  goalLabel: string | null;
  /** Tactical prompts the host suggests (already filtered to relevant ones). */
  suggestedPrompts: string[];
  /** Most-recent event-log entries, newest first. */
  events: DefenseEventRow[];
}

const LANES: DefenseLane[] = ["top", "mid", "bot"];

const EVENT_TONE: Record<DefenseEventTone, SpatialTone> = {
  info: "muted",
  success: "success",
  warning: "warning",
  error: "danger",
};

const EVENT_MARK: Record<DefenseEventTone, string> = {
  info: ".",
  success: "+",
  warning: "!",
  error: "x",
};

function statusTone(status: string): SpatialTone {
  if (status === "running" || status === "ready") return "success";
  if (status === "degraded" || status === "failed") return "danger";
  if (status === "respawning") return "warning";
  return "muted";
}

function statusLabel(status: string): string {
  if (status === "running" || status === "ready") return "live";
  if (status === "degraded" || status === "failed") return "needs attention";
  if (status === "respawning") return "respawning";
  if (status === "idle") return "idle";
  return "starting";
}

function formatHeroClass(value: string | null): string {
  if (!value) return "Not deployed";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "Mage Lv3 mid, 80/100 HP" — the same line the legacy surface renders. */
export function formatHeroLine(snapshot: DefenseSnapshot): string {
  const heroClass = formatHeroClass(snapshot.heroClass);
  const levelLabel =
    snapshot.heroLevel !== null ? ` Lv${snapshot.heroLevel}` : "";
  const laneLabel = snapshot.heroLane ? ` ${snapshot.heroLane}` : "";
  const hpLabel =
    snapshot.heroHp !== null && snapshot.heroMaxHp !== null
      ? `, ${snapshot.heroHp}/${snapshot.heroMaxHp} HP`
      : "";
  return `${heroClass}${levelLabel}${laneLabel}${hpLabel}`;
}

export interface DefenseAgentsSpatialViewProps {
  snapshot: DefenseSnapshot;
  /**
   * Dispatch by agent id: `autoplay`, `recall`, `lane:<top|mid|bot>`,
   * `prompt:<text>`.
   */
  onAction?: (action: string) => void;
}

export function DefenseAgentsSpatialView({
  snapshot,
  onAction,
}: DefenseAgentsSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const canSend = snapshot.canSendCommands && snapshot.runId !== null;
  const prompts = snapshot.suggestedPrompts.slice(0, 4);
  const events = snapshot.events.slice(0, 5);

  return (
    <Card title="Defense of the Agents" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="caption" tone={statusTone(snapshot.status)} grow={1}>
          {statusLabel(snapshot.status)}
        </Text>
        <Text style="caption" tone={canSend ? "success" : "muted"}>
          {canSend ? "relay ready" : "relay syncing"}
        </Text>
      </HStack>

      <Text style="caption" tone="muted" wrap={false}>
        {snapshot.runId ? `run ${snapshot.runId}` : "no live match"}
      </Text>

      <Divider label="hero" />
      <Text bold width="100%">
        {formatHeroLine(snapshot)}
      </Text>
      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={snapshot.autoPlay ? "primary" : "muted"}
          grow={1}
        >
          {snapshot.autoPlay ? "autoplay" : "manual"}
        </Text>
        {snapshot.heroLane ? (
          <Text style="caption" tone="muted">
            {snapshot.heroLane} lane
          </Text>
        ) : null}
      </HStack>
      {snapshot.goalLabel ? (
        <Text style="caption" tone="muted">
          {snapshot.goalLabel}
        </Text>
      ) : null}

      <Divider label="commands" />
      <HStack gap={1} wrap>
        <Button
          grow={1}
          variant={snapshot.autoPlay ? "solid" : "outline"}
          tone={snapshot.autoPlay ? "primary" : "default"}
          disabled={!canSend}
          agent="command-autoplay"
          onPress={dispatch("autoplay")}
        >
          {snapshot.autoPlay ? "Autoplay on" : "Autoplay off"}
        </Button>
        <Button
          variant="outline"
          tone="danger"
          disabled={!canSend}
          agent="command-recall"
          onPress={dispatch("recall")}
        >
          Recall
        </Button>
      </HStack>
      <HStack gap={1} wrap>
        {LANES.map((lane) => (
          <Button
            key={lane}
            grow={1}
            variant={snapshot.heroLane === lane ? "solid" : "outline"}
            tone={snapshot.heroLane === lane ? "primary" : "default"}
            disabled={!canSend}
            agent={`command-lane-${lane}`}
            onPress={dispatch(`lane:${lane}`)}
          >
            {lane}
          </Button>
        ))}
      </HStack>

      {prompts.length > 0 ? (
        <>
          <Divider label="suggested" />
          <List gap={0}>
            {prompts.map((prompt) => (
              <Button
                key={prompt}
                width="100%"
                variant="ghost"
                tone="default"
                disabled={!canSend}
                agent={`prompt-${prompt}`}
                onPress={dispatch(`prompt:${prompt}`)}
              >
                {prompt}
              </Button>
            ))}
          </List>
        </>
      ) : null}

      <Divider label="events" />
      {events.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No match events yet
        </Text>
      ) : (
        <List gap={0}>
          {events.map((event) => (
            <HStack key={event.id} gap={1} align="center">
              <Text tone={EVENT_TONE[event.tone]}>
                {EVENT_MARK[event.tone]}
              </Text>
              <Text style="caption" tone="muted" wrap={false}>
                {event.label}
              </Text>
              <Text grow={1} wrap={false}>
                {event.message}
              </Text>
            </HStack>
          ))}
        </List>
      )}
    </Card>
  );
}
