/**
 * TrajectoryLoggerSpatialView — the trajectory inspector authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus type-only views of
 * the trajectory wire shapes, so it is safe to render in the Node agent process
 * where the terminal lives (no browser/runtime import, no polling hook).
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
import type {
  UIEvaluationEvent,
  UILlmCall,
  UIProviderAccess,
  UIToolEvent,
} from "../api-client.ts";
import type { PhaseName, PhaseStatus, PhaseSummary } from "../phases.ts";
import { extractShouldRespondDecision, PHASES } from "../phases.ts";

export type Slot = "now" | "last";

/** One trajectory track: its phase tabs plus a recording/empty indicator. */
export interface TrajectoryTrack {
  /** True once the agent has captured at least one turn for this slot. */
  hasTrajectory: boolean;
  /** Phase summaries in canonical order (HANDLE / PLAN / ACTION / EVALUATE). */
  phases: PhaseSummary[];
}

export interface TrajectorySnapshot {
  /** False while the first poll is still in flight. */
  ready: boolean;
  /** Whether the active ("now") trajectory is currently recording. */
  recording: boolean;
  /** Fetch error from the trajectories endpoint, if any. */
  error?: string | null;
  /** In-flight trajectory track. */
  now: TrajectoryTrack;
  /** Last completed trajectory track. */
  last: TrajectoryTrack;
  /** Which phase tab (if any) is expanded into its drilldown body. */
  selected?: { slot: Slot; phase: PhaseName } | null;
}

export interface TrajectoryLoggerSpatialViewProps {
  snapshot: TrajectorySnapshot;
  /** Dispatch by agent id: `select:<slot>:<phase>`, `refresh`. */
  onAction?: (action: string) => void;
}

const EMPTY_TRACK: TrajectoryTrack = {
  hasTrajectory: false,
  phases: PHASES.map((phase) => ({
    phase,
    status: "idle",
    summary: null,
    llmCalls: [],
    providerAccesses: [],
    toolEvents: [],
    evaluationEvents: [],
  })),
};

export const EMPTY_TRAJECTORY_SNAPSHOT: TrajectorySnapshot = {
  ready: false,
  recording: false,
  error: null,
  now: EMPTY_TRACK,
  last: EMPTY_TRACK,
  selected: null,
};

function statusTone(status: PhaseStatus): SpatialTone {
  switch (status) {
    case "active":
      return "primary";
    case "done":
      return "success";
    case "error":
      return "danger";
    case "skipped":
      return "warning";
    default:
      return "muted";
  }
}

/** ASCII status marker (avoid East-Asian ambiguous glyphs in the terminal). */
function statusMark(status: PhaseStatus): string {
  switch (status) {
    case "active":
      return "*";
    case "done":
      return "+";
    case "error":
      return "x";
    case "skipped":
      return "-";
    default:
      return ".";
  }
}

export function TrajectoryLoggerSpatialView({
  snapshot,
  onAction,
}: TrajectoryLoggerSpatialViewProps) {
  const selected = resolveSelected(snapshot);
  return (
    <Card title="Trajectories" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="caption" tone="muted" grow={1}>
          route
        </Text>
        {!snapshot.ready ? (
          <Text style="caption" tone="muted">
            loading
          </Text>
        ) : (
          <Text
            style="caption"
            tone={snapshot.recording ? "danger" : "muted"}
            bold={snapshot.recording}
          >
            {snapshot.recording ? "[*] recording" : "[ ] idle"}
          </Text>
        )}
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      <PhaseStrip
        live
        slot="now"
        track={snapshot.now}
        selectedPhase={selected?.slot === "now" ? selected.phase : null}
        onSelect={(phase) => onAction?.(`select:now:${phase}`)}
      />
      <PhaseStrip
        live={false}
        slot="last"
        track={snapshot.last}
        selectedPhase={selected?.slot === "last" ? selected.phase : null}
        onSelect={(phase) => onAction?.(`select:last:${phase}`)}
      />

      {selected.summary ? (
        <VStack gap={1}>
          <Divider
            label={`${selected.slot === "now" ? "now" : "last"} / ${selected.summary.phase}`}
          />
          <PhaseDrilldownBody phase={selected.summary} />
        </VStack>
      ) : null}
    </Card>
  );
}

function resolveSelected(snapshot: TrajectorySnapshot): {
  slot: Slot;
  phase: PhaseName;
  summary: PhaseSummary | null;
} {
  const sel = snapshot.selected ?? null;
  if (!sel) return { slot: "now", phase: "HANDLE", summary: null };
  const track = sel.slot === "now" ? snapshot.now : snapshot.last;
  const summary = track.phases.find((p) => p.phase === sel.phase) ?? null;
  return { slot: sel.slot, phase: sel.phase, summary };
}

function PhaseStrip({
  live,
  slot,
  track,
  selectedPhase,
  onSelect,
}: {
  live: boolean;
  slot: Slot;
  track: TrajectoryTrack;
  selectedPhase: PhaseName | null;
  onSelect: (phase: PhaseName) => void;
}) {
  const recording = live && track.hasTrajectory;
  const lastDone = track.phases.reduce(
    (acc, p, i) => (p.status !== "idle" ? i : acc),
    -1,
  );
  const total = track.phases.length;
  // Borderless labeled section (no nested box). The divider carries the
  // now/last label; recording state shows through the phase statuses.
  return (
    <VStack gap={1} agent={`strip-${slot}`}>
      <Divider label={live ? "now" : "last"} />
      <Text
        style="caption"
        tone={recording ? "primary" : "muted"}
        align="center"
      >
        {!track.hasTrajectory ? "no turn yet" : progressBar(lastDone, total)}
      </Text>
      <List gap={0}>
        {track.phases.map((p) => (
          <HStack
            key={p.phase}
            gap={1}
            align="center"
            agent={`phase-${slot}-${p.phase}`}
          >
            <Text tone={statusTone(p.status)} bold>
              {statusMark(p.status)}
            </Text>
            <Text bold={selectedPhase === p.phase} width="30%" wrap={false}>
              {p.phase}
            </Text>
            <Text style="caption" tone="muted" grow={1} wrap={false}>
              {p.summary ?? p.status}
            </Text>
            <Button
              variant={selectedPhase === p.phase ? "solid" : "ghost"}
              tone={statusTone(p.status)}
              agent={`select-${slot}-${p.phase}`}
              onPress={() => onSelect(p.phase)}
            >
              {phaseCount(p) || "open"}
            </Button>
          </HStack>
        ))}
      </List>
    </VStack>
  );
}

function progressBar(lastDone: number, total: number): string {
  if (total <= 0) return "";
  const filled = Math.max(0, lastDone + 1);
  return `[${"=".repeat(filled)}${"-".repeat(Math.max(0, total - filled))}]`;
}

function phaseCount(phase: PhaseSummary): string {
  const n =
    phase.llmCalls.length +
    phase.toolEvents.length +
    phase.evaluationEvents.length;
  return n > 0 ? String(n) : "";
}

function PhaseDrilldownBody({ phase }: { phase: PhaseSummary }) {
  switch (phase.phase) {
    case "HANDLE":
      return <HandleBody calls={phase.llmCalls} ctx={phase.providerAccesses} />;
    case "PLAN":
      return <PlanBody calls={phase.llmCalls} />;
    case "ACTION":
      return <ActionBody events={phase.toolEvents} />;
    case "EVALUATE":
      return (
        <EvaluateBody calls={phase.llmCalls} events={phase.evaluationEvents} />
      );
  }
}

function preview(text: string, max = 160): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
}

function HandleBody({
  calls,
  ctx,
}: {
  calls: UILlmCall[];
  ctx: UIProviderAccess[];
}) {
  const respond = calls.find(
    (c) => (c.stepType || c.purpose || "").toLowerCase() === "should_respond",
  );
  const decision = respond ? extractShouldRespondDecision(respond) : null;
  const providers = [
    ...new Set(ctx.map((p) => p.providerName).filter(Boolean)),
  ];
  if (!decision && providers.length === 0) {
    return (
      <Text style="caption" tone="muted" dim>
        no handle activity
      </Text>
    );
  }
  return (
    <VStack gap={1}>
      {decision ? (
        <HStack gap={1} align="center">
          <Text bold>{decision.decision}</Text>
          {decision.reasoning ? (
            <Text style="caption" tone="muted" grow={1}>
              {preview(decision.reasoning)}
            </Text>
          ) : null}
        </HStack>
      ) : null}
      {providers.length > 0 ? (
        <Text style="caption" tone="muted">
          {`ctx: ${providers.join(", ")}`}
        </Text>
      ) : null}
    </VStack>
  );
}

function PlanBody({ calls }: { calls: UILlmCall[] }) {
  const last = calls[calls.length - 1];
  if (!last) {
    return (
      <Text style="caption" tone="muted" dim>
        no plan yet
      </Text>
    );
  }
  const text = preview(last.response);
  return (
    <VStack gap={1}>
      {last.actionType ? <Text bold>{last.actionType}</Text> : null}
      {text ? (
        <Text style="caption" tone="muted">
          {text}
        </Text>
      ) : null}
    </VStack>
  );
}

function ActionBody({ events }: { events: UIToolEvent[] }) {
  if (events.length === 0) {
    return (
      <Text style="caption" tone="muted" dim>
        no actions
      </Text>
    );
  }
  return (
    <List gap={1}>
      {events.map((e) => {
        const name = e.actionName || e.toolName || e.name || "action";
        const tone = toolTone(e);
        return (
          <HStack key={e.id} gap={1} align="center" agent={`tool-${e.id}`}>
            <Text tone={tone} bold>
              {toolMark(e)}
            </Text>
            <Text grow={1} wrap={false}>
              {name}
            </Text>
            {typeof e.durationMs === "number" ? (
              <Text style="caption" tone="muted">
                {`${e.durationMs}ms`}
              </Text>
            ) : null}
            {e.error ? (
              <Text style="caption" tone="danger" wrap={false}>
                {preview(e.error, 40)}
              </Text>
            ) : null}
          </HStack>
        );
      })}
    </List>
  );
}

function toolTone(e: UIToolEvent): SpatialTone {
  if (e.type === "tool_error" || e.error || e.success === false)
    return "danger";
  if (
    e.type === "tool_result" ||
    e.status === "completed" ||
    e.success === true
  )
    return "success";
  if (e.status === "skipped") return "warning";
  return "primary";
}

function toolMark(e: UIToolEvent): string {
  if (e.type === "tool_error" || e.error || e.success === false) return "x";
  if (
    e.type === "tool_result" ||
    e.status === "completed" ||
    e.success === true
  )
    return "+";
  if (e.status === "skipped") return "-";
  return "*";
}

function EvaluateBody({
  calls,
  events,
}: {
  calls: UILlmCall[];
  events: UIEvaluationEvent[];
}) {
  if (events.length === 0 && calls.length === 0) {
    return (
      <Text style="caption" tone="muted" dim>
        no evaluation
      </Text>
    );
  }
  return (
    <List gap={1}>
      {events.map((e) => {
        const name = e.evaluatorName || e.name || "evaluator";
        const tone =
          e.error || e.success === false
            ? "danger"
            : e.success === true || e.status === "completed"
              ? "success"
              : e.status === "skipped"
                ? "warning"
                : "primary";
        return (
          <VStack key={e.id} gap={0} agent={`eval-${e.id}`}>
            <HStack gap={1} align="center">
              <Text tone={tone as SpatialTone} grow={1} wrap={false}>
                {name}
              </Text>
              {e.decision ? (
                <Text style="caption" tone="muted">
                  {e.decision}
                </Text>
              ) : null}
            </HStack>
            {e.thought ? (
              <Text style="caption" tone="muted">
                {preview(e.thought)}
              </Text>
            ) : null}
            {e.error ? (
              <Text style="caption" tone="danger">
                {preview(e.error, 80)}
              </Text>
            ) : null}
          </VStack>
        );
      })}
    </List>
  );
}
