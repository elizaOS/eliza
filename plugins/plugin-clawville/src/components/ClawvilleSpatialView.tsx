/**
 * ClawvilleSpatialView - the ClawVille operator panel authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus a type-only view of
 * the run/event/action shapes, so it is safe to render in the Node agent process
 * where the terminal lives (no browser/`@elizaos/ui` runtime import).
 *
 * This is the operator control panel (status dashboard + command shell), NOT the
 * embedded 3D game viewer — that is served separately via the
 * `/api/apps/clawville/viewer` iframe route.
 */

import type {
  AppRunSummary,
  GameOperatorAction,
  GameOperatorEvent,
} from "@elizaos/ui";
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

/** Telemetry the panel surfaces from `run.session.telemetry`. */
export interface ClawvilleTelemetry {
  /** Friendly label for the nearest building, falls back to its id. */
  nearestBuildingLabel: string;
  /** Skills/knowledge the agent has learned, or null when unknown. */
  knowledgeCount: number | null;
}

/** The presentational snapshot the view renders from. */
export interface ClawvilleSnapshot {
  /** Active run id, or null when no ClawVille session is live. */
  runId: string | null;
  /** App run status: running/ready/degraded/failed/idle. */
  status: string;
  /** Whether the operator can dispatch commands to the run. */
  canSend: boolean;
  /** Current objective / goal line. */
  goalLabel: string | null;
  telemetry: ClawvilleTelemetry;
  /** Quick-action commands (PRIMARY_COMMANDS + suggested prompts). */
  actions: GameOperatorAction[];
  /** Recent run events, newest last. */
  events: GameOperatorEvent[];
}

const EVENT_TONE: Record<
  NonNullable<GameOperatorEvent["tone"]>,
  SpatialTone
> = {
  user: "primary",
  success: "success",
  info: "muted",
  warning: "warning",
  error: "danger",
};

function eventTone(tone: GameOperatorEvent["tone"]): SpatialTone {
  return tone ? EVENT_TONE[tone] : "muted";
}

function eventMark(tone: GameOperatorEvent["tone"]): string {
  switch (tone) {
    case "error":
      return "x";
    case "warning":
      return "!";
    case "success":
      return "+";
    case "user":
      return ">";
    default:
      return ".";
  }
}

function statusTone(status: string): SpatialTone {
  if (status === "running" || status === "ready") return "success";
  if (status === "degraded" || status === "failed") return "danger";
  return "muted";
}

function statusLabel(status: string): string {
  if (status === "running" || status === "ready") return "live";
  if (status === "degraded" || status === "failed") return "needs-attention";
  return "starting";
}

/**
 * Build a snapshot from the canonical {@link AppRunSummary} the operator surface
 * consumes. Mirrors the derivations in `ClawvilleOperatorSurface` so the unified
 * view stays in lockstep with the GUI panel.
 */
export function toClawvilleSnapshot(
  run: AppRunSummary | null,
  events: GameOperatorEvent[],
  actions: GameOperatorAction[],
): ClawvilleSnapshot {
  const telemetry =
    run?.session?.telemetry && typeof run.session.telemetry === "object"
      ? (run.session.telemetry as Record<string, unknown>)
      : null;
  const label = telemetry?.nearestBuildingLabel ?? telemetry?.nearestBuildingId;
  const knowledge = telemetry?.knowledgeCount;
  return {
    runId: run?.runId ?? null,
    status: run?.status ?? "idle",
    canSend: Boolean(run?.runId && run.session?.canSendCommands),
    goalLabel: run?.session?.goalLabel ?? null,
    telemetry: {
      nearestBuildingLabel:
        typeof label === "string" && label.trim().length > 0
          ? label.trim()
          : "the reef",
      knowledgeCount:
        typeof knowledge === "number" && Number.isFinite(knowledge)
          ? knowledge
          : null,
    },
    actions,
    events,
  };
}

export interface ClawvilleSpatialViewProps {
  snapshot: ClawvilleSnapshot;
  /** Dispatched with the action's `command` string when an action is pressed. */
  onAction?: (command: string) => void;
}

export function ClawvilleSpatialView({
  snapshot,
  onAction,
}: ClawvilleSpatialViewProps) {
  const { telemetry } = snapshot;
  const learned = telemetry.knowledgeCount ?? 0;
  const dispatch = (command: string) => () => onAction?.(command);
  return (
    <Card title="ClawVille" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="caption" tone={statusTone(snapshot.status)} grow={1}>
          {statusLabel(snapshot.status)}
        </Text>
        <Text style="caption" tone={snapshot.canSend ? "success" : "muted"}>
          {snapshot.canSend ? "commands ready" : "commands locked"}
        </Text>
      </HStack>

      <Divider label="status" />
      <VStack gap={0}>
        <HStack gap={1} align="center">
          <Text style="caption" tone="muted" grow={1}>
            run
          </Text>
          <Text wrap={false}>{snapshot.runId ?? "none"}</Text>
        </HStack>
        <HStack gap={1} align="center">
          <Text style="caption" tone="muted" grow={1}>
            location
          </Text>
          <Text wrap={false}>{telemetry.nearestBuildingLabel}</Text>
        </HStack>
        <HStack gap={1} align="center">
          <Text style="caption" tone="muted" grow={1}>
            learned
          </Text>
          <Text wrap={false}>{`${learned}`}</Text>
        </HStack>
      </VStack>
      <Text style="caption" tone="muted">
        {snapshot.goalLabel ?? `Near ${telemetry.nearestBuildingLabel}`}
      </Text>

      <Divider label="commands" />
      {snapshot.actions.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No commands available
        </Text>
      ) : (
        <VStack gap={1}>
          {snapshot.actions.slice(0, 6).map((action) => (
            <Button
              key={action.id}
              variant="outline"
              tone="default"
              width="100%"
              disabled={!snapshot.canSend}
              agent={`command-${action.id}`}
              onPress={dispatch(action.command)}
            >
              {action.label}
            </Button>
          ))}
        </VStack>
      )}

      <Divider label="events" />
      {snapshot.events.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No events yet
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.events.slice(-6).map((event) => (
            <HStack key={event.id} gap={1} align="center">
              <Text tone={eventTone(event.tone)}>{eventMark(event.tone)}</Text>
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {event.label}
                </Text>
                <Text style="caption" tone="muted">
                  {event.message}
                </Text>
              </VStack>
            </HStack>
          ))}
        </List>
      )}
    </Card>
  );
}
