/**
 * LifeOpsSpatialView - the LifeOps personal-assistant dashboard authored once
 * with the spatial vocabulary, so it renders correctly wherever it is shown:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot in, primitives out; rows carry `agent`
 * ids so the agent surface can drive them) and imports only the cross-modality
 * primitives, so it is safe to render in the Node agent process where the
 * terminal lives (no server/connector runtime import).
 *
 * The snapshot mirrors `LifeOpsService.getOverview()`: merged owner + agent
 * operational state - pending tasks (occurrences), goals with review status,
 * active reminders, and the day's circadian/schedule insight - preserving the
 * brief / approvals / schedule information architecture of the GUI dashboard.
 */

import {
  Card,
  Divider,
  HStack,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

/** Owner vs. agent-ops attribution for a LifeOps record. */
export type LifeOpsSubjectKind = "owner" | "agent";

/** Lifecycle state of a scheduled occurrence (pending task). */
export type LifeOpsOccurrenceState =
  | "scheduled"
  | "visible"
  | "snoozed"
  | "completed"
  | "skipped"
  | "expired"
  | "muted";

/** Goal lifecycle status. */
export type LifeOpsGoalStatus = "active" | "paused" | "archived" | "satisfied";

/** Reminder delivery urgency. */
export type LifeOpsReminderUrgency = "low" | "medium" | "high" | "critical";

/** A pending occurrence (task) the agent is tracking for a subject. */
export interface LifeOpsOccurrenceRow {
  id: string;
  title: string;
  state: LifeOpsOccurrenceState;
  /** Pre-formatted relative/short due time; empty when no due date. */
  dueAt: string;
  /** Priority score (higher = more important). */
  priority: number;
  subjectType: LifeOpsSubjectKind;
}

/** A goal with its current review/lifecycle status. */
export interface LifeOpsGoalRow {
  id: string;
  title: string;
  status: LifeOpsGoalStatus;
  subjectType: LifeOpsSubjectKind;
  /** Progress fraction in [0, 1]; null when unmeasured. */
  progress: number | null;
}

/** An active reminder waiting to fire on a channel. */
export interface LifeOpsReminderRow {
  id: string;
  title: string;
  /** Pre-formatted relative/short scheduled-for time. */
  scheduledFor: string;
  /** Delivery channel (push, sms, email, ...). */
  channel: string;
  urgency: LifeOpsReminderUrgency;
  subjectType: LifeOpsSubjectKind;
}

/** Per-subject operational rollup (owner or agent-ops). */
export interface LifeOpsSectionSnapshot {
  occurrences: LifeOpsOccurrenceRow[];
  goals: LifeOpsGoalRow[];
  reminders: LifeOpsReminderRow[];
  /** One-line natural-language summary of this section. */
  summary: string;
}

/** The day's circadian/schedule insight (conflict + sleep readiness). */
export interface LifeOpsScheduleSnapshot {
  /** e.g. "awake", "winding_down", "sleeping". */
  circadianState: string;
  /** e.g. "morning", "afternoon", "late night". */
  relativeTime: string;
  /** Sleep readiness, e.g. "slept", "sleeping_now", "likely_missed". */
  sleepStatus: string;
  /** Number of detected calendar conflicts in the day. */
  conflictCount: number;
}

export interface LifeOpsSnapshot {
  owner: LifeOpsSectionSnapshot;
  agentOps: LifeOpsSectionSnapshot;
  schedule: LifeOpsScheduleSnapshot | null;
  loading?: boolean;
  error?: string | null;
}

const EMPTY_SECTION: LifeOpsSectionSnapshot = {
  occurrences: [],
  goals: [],
  reminders: [],
  summary: "",
};

export const EMPTY_LIFEOPS_SNAPSHOT: LifeOpsSnapshot = {
  owner: EMPTY_SECTION,
  agentOps: EMPTY_SECTION,
  schedule: null,
};

function occurrenceTone(state: LifeOpsOccurrenceState): SpatialTone {
  switch (state) {
    case "expired":
      return "danger";
    case "snoozed":
    case "muted":
      return "warning";
    case "completed":
    case "skipped":
      return "success";
    case "visible":
      return "primary";
    default:
      return "default";
  }
}

function occurrenceMark(state: LifeOpsOccurrenceState): string {
  switch (state) {
    case "completed":
      return "x";
    case "skipped":
      return "-";
    case "expired":
      return "!";
    case "snoozed":
      return "z";
    case "muted":
      return "m";
    case "visible":
      return ">";
    default:
      return ".";
  }
}

function goalTone(status: LifeOpsGoalStatus): SpatialTone {
  switch (status) {
    case "active":
      return "primary";
    case "satisfied":
      return "success";
    case "paused":
      return "warning";
    default:
      return "muted";
  }
}

function urgencyTone(urgency: LifeOpsReminderUrgency): SpatialTone {
  switch (urgency) {
    case "critical":
      return "danger";
    case "high":
      return "warning";
    case "medium":
      return "primary";
    default:
      return "muted";
  }
}

function sleepTone(sleepStatus: string): SpatialTone {
  switch (sleepStatus) {
    case "likely_missed":
      return "danger";
    case "sleeping_now":
      return "primary";
    case "slept":
      return "success";
    default:
      return "muted";
  }
}

function progressLabel(progress: number | null): string {
  if (progress === null) return "--";
  const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
  return `${pct}%`;
}

function OccurrenceList({
  occurrences,
  prefix,
}: {
  occurrences: LifeOpsOccurrenceRow[];
  prefix: string;
}) {
  if (occurrences.length === 0) {
    return (
      <Text tone="muted" style="caption">
        No pending tasks
      </Text>
    );
  }
  return (
    <List gap={0}>
      {occurrences.slice(0, 6).map((occ) => (
        <HStack
          key={occ.id}
          gap={1}
          align="center"
          agent={`${prefix}-occ-${occ.id}`}
        >
          <Text tone={occurrenceTone(occ.state)}>
            {occurrenceMark(occ.state)}
          </Text>
          <Text bold wrap={false} grow={1}>
            {occ.title}
          </Text>
          {occ.dueAt ? (
            <Text style="caption" tone="muted">
              {occ.dueAt}
            </Text>
          ) : null}
        </HStack>
      ))}
    </List>
  );
}

function GoalList({ goals }: { goals: LifeOpsGoalRow[] }) {
  if (goals.length === 0) {
    return (
      <Text tone="muted" style="caption">
        No active goals
      </Text>
    );
  }
  return (
    <List gap={0}>
      {goals.slice(0, 5).map((goal) => (
        <HStack key={goal.id} gap={1} align="center" agent={`goal-${goal.id}`}>
          <Text tone={goalTone(goal.status)} wrap={false}>
            {goal.status}
          </Text>
          <Text wrap={false} grow={1}>
            {goal.title}
          </Text>
          <Text style="caption" tone="muted">
            {progressLabel(goal.progress)}
          </Text>
        </HStack>
      ))}
    </List>
  );
}

function ReminderList({ reminders }: { reminders: LifeOpsReminderRow[] }) {
  if (reminders.length === 0) {
    return (
      <Text tone="muted" style="caption">
        No active reminders
      </Text>
    );
  }
  return (
    <List gap={0}>
      {reminders.slice(0, 5).map((reminder) => (
        <HStack
          key={reminder.id}
          gap={1}
          align="center"
          agent={`reminder-${reminder.id}`}
        >
          <Text tone={urgencyTone(reminder.urgency)} wrap={false}>
            {reminder.urgency}
          </Text>
          <Text wrap={false} grow={1}>
            {reminder.title}
          </Text>
          <Text style="caption" tone="muted" wrap={false}>
            {reminder.channel} {reminder.scheduledFor}
          </Text>
        </HStack>
      ))}
    </List>
  );
}

function SectionPanel({
  label,
  section,
  prefix,
}: {
  label: string;
  section: LifeOpsSectionSnapshot;
  prefix: string;
}) {
  return (
    <VStack gap={1}>
      <Divider label={label} />
      {section.summary ? (
        <Text style="caption" tone="muted" wrap>
          {section.summary}
        </Text>
      ) : null}
      <Text style="label" tone="muted">
        tasks
      </Text>
      <OccurrenceList occurrences={section.occurrences} prefix={prefix} />
      <Text style="label" tone="muted">
        goals
      </Text>
      <GoalList goals={section.goals} />
      <Text style="label" tone="muted">
        reminders
      </Text>
      <ReminderList reminders={section.reminders} />
    </VStack>
  );
}

function SchedulePanel({ schedule }: { schedule: LifeOpsScheduleSnapshot }) {
  const conflictTone: SpatialTone =
    schedule.conflictCount > 0 ? "danger" : "success";
  return (
    <VStack gap={1}>
      <Divider label="schedule" />
      <HStack gap={1} align="center" wrap>
        <Text style="caption" tone="muted">
          {schedule.relativeTime}
        </Text>
        <Text style="caption" tone="primary" grow={1}>
          {schedule.circadianState}
        </Text>
        <Text style="caption" tone={sleepTone(schedule.sleepStatus)}>
          {schedule.sleepStatus}
        </Text>
      </HStack>
      <HStack gap={1} align="center">
        <Text tone={conflictTone}>
          {schedule.conflictCount > 0 ? "!" : "."}
        </Text>
        <Text wrap={false} grow={1}>
          calendar conflicts
        </Text>
        <Text style="caption" tone={conflictTone}>
          {schedule.conflictCount}
        </Text>
      </HStack>
    </VStack>
  );
}

export interface LifeOpsSpatialViewProps {
  snapshot: LifeOpsSnapshot;
}

export function LifeOpsSpatialView({ snapshot }: LifeOpsSpatialViewProps) {
  const ownerActive = snapshot.owner.occurrences.length;
  const agentActive = snapshot.agentOps.occurrences.length;
  return (
    <Card title="LifeOps" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="caption" tone="primary" grow={1}>
          {snapshot.loading
            ? "loading"
            : `${ownerActive} owner / ${agentActive} agent tasks`}
        </Text>
        <Text style="caption" tone="muted">
          {snapshot.schedule ? snapshot.schedule.relativeTime : "no schedule"}
        </Text>
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      <SectionPanel label="owner" section={snapshot.owner} prefix="owner" />
      <SectionPanel
        label="agent-ops"
        section={snapshot.agentOps}
        prefix="agent"
      />

      {snapshot.schedule ? (
        <SchedulePanel schedule={snapshot.schedule} />
      ) : (
        <VStack gap={1}>
          <Divider label="schedule" />
          <Text tone="muted" style="caption">
            No schedule insight
          </Text>
        </VStack>
      )}
    </Card>
  );
}
