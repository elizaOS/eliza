/**
 * OrchestratorSpatialView — the task-orchestration workbench authored once with
 * the spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a typed snapshot + an action callback in,
 * primitives out) and imports only the cross-modality primitives plus a
 * type-only view of the orchestrator records from `@elizaos/ui`, so it is safe
 * to render in the Node agent process where the terminal lives (no host runtime
 * import — the `import type` is erased).
 *
 * Two modes:
 *   - list   — paginated task threads with status, priority, session counts, and
 *              cost; the workbench landing.
 *   - detail — drill-down for one thread: sessions, decisions, artifacts, events,
 *              transcripts, pending user inputs, and plan steps.
 */

import type {
  CodingAgentOrchestratorStatus,
  CodingAgentPendingDecisionRecord,
  CodingAgentTaskArtifactRecord,
  CodingAgentTaskDecisionRecord,
  CodingAgentTaskEventRecord,
  CodingAgentTaskSessionRecord,
  CodingAgentTaskThread,
  CodingAgentTaskThreadDetail,
  CodingAgentTaskTranscriptRecord,
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

type TaskStatus = CodingAgentTaskThread["status"];
type TaskPriority = CodingAgentTaskThread["priority"];

/** One plan step distilled from a thread's current plan, for display. */
export interface OrchestratorPlanStep {
  id: string;
  label: string;
  state: "pending" | "active" | "done" | "blocked";
}

/** The full snapshot the workbench renders from. `detail` is present only when a
 * thread is open; absent means the list landing. */
export interface OrchestratorSnapshot {
  status: CodingAgentOrchestratorStatus | null;
  /** The current page of task threads (server-paginated). */
  threads: CodingAgentTaskThread[];
  /** True when more threads exist beyond this page. */
  hasMore: boolean;
  /** The open thread's drill-down, or null on the list landing. */
  detail: CodingAgentTaskThreadDetail | null;
  /** Plan steps distilled for the open thread. */
  planSteps: OrchestratorPlanStep[];
  /** Pending user inputs awaiting a human on the open thread. */
  pendingInputs: CodingAgentPendingDecisionRecord[];
  loading?: boolean;
  error?: string | null;
}

const STATUS_TONE: Record<TaskStatus, SpatialTone> = {
  open: "primary",
  active: "success",
  validating: "primary",
  waiting_on_user: "warning",
  blocked: "warning",
  interrupted: "warning",
  done: "success",
  failed: "danger",
  archived: "muted",
};

const STATUS_MARK: Record<TaskStatus, string> = {
  open: "o",
  active: ">",
  validating: "~",
  waiting_on_user: "?",
  blocked: "!",
  interrupted: "!",
  done: "+",
  failed: "x",
  archived: ".",
};

const PRIORITY_TONE: Record<TaskPriority, SpatialTone> = {
  low: "muted",
  normal: "default",
  high: "warning",
  urgent: "danger",
};

const PLAN_TONE: Record<OrchestratorPlanStep["state"], SpatialTone> = {
  pending: "muted",
  active: "primary",
  done: "success",
  blocked: "danger",
};

const PLAN_MARK: Record<OrchestratorPlanStep["state"], string> = {
  pending: "[ ]",
  active: "[>]",
  done: "[x]",
  blocked: "[!]",
};

const VERIFY_TONE: Record<
  CodingAgentTaskArtifactRecord["verificationStatus"],
  SpatialTone
> = {
  passed: "success",
  failed: "danger",
  pending: "warning",
  unknown: "muted",
};

function statusTone(status: string): SpatialTone {
  return STATUS_TONE[status as TaskStatus] ?? "muted";
}

function statusMark(status: string): string {
  return STATUS_MARK[status as TaskStatus] ?? ".";
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export interface OrchestratorSpatialViewProps {
  snapshot: OrchestratorSnapshot;
  /**
   * Dispatch by agent id. List: `open:<taskId>`, `create`, `pause-all`,
   * `resume-all`, `refresh`. Detail: `back`, `pause`, `resume`, `validate`,
   * `fork`, `delete`, `stop-session:<sessionId>`.
   */
  onAction?: (action: string) => void;
}

export function OrchestratorSpatialView({
  snapshot,
  onAction,
}: OrchestratorSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  if (snapshot.detail) {
    return (
      <OrchestratorDetail
        detail={snapshot.detail}
        planSteps={snapshot.planSteps}
        pendingInputs={snapshot.pendingInputs}
        dispatch={dispatch}
      />
    );
  }
  return (
    <OrchestratorList
      status={snapshot.status}
      threads={snapshot.threads}
      hasMore={snapshot.hasMore}
      loading={snapshot.loading}
      error={snapshot.error}
      dispatch={dispatch}
    />
  );
}

function OrchestratorList({
  status,
  threads,
  hasMore,
  loading,
  error,
  dispatch,
}: {
  status: CodingAgentOrchestratorStatus | null;
  threads: CodingAgentTaskThread[];
  hasMore: boolean;
  loading?: boolean;
  error?: string | null;
  dispatch: (action: string) => () => void;
}) {
  return (
    <Card title="Orchestrator" gap={1} padding={1}>
      <HStack gap={1} align="center" wrap>
        <Text style="caption" tone="muted" grow={1}>
          {loading ? "loading" : `${threads.length} threads`}
        </Text>
        {status ? (
          <>
            <Text style="caption" tone="success">
              {`${status.activeTaskCount} active`}
            </Text>
            <Text style="caption" tone="warning">
              {`${status.blockedTaskCount} blocked`}
            </Text>
            <Text style="caption" tone="muted">
              {`${status.sessionCount} sessions`}
            </Text>
            <Text style="caption" tone="primary">
              {formatUsd(status.usage.costUsd)}
            </Text>
          </>
        ) : null}
      </HStack>

      {error ? (
        <Text tone="danger" style="caption">
          {error}
        </Text>
      ) : null}

      <HStack gap={1} wrap>
        <Button grow={1} agent="create" onPress={dispatch("create")}>
          New task
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="pause-all"
          onPress={dispatch("pause-all")}
        >
          Pause all
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="resume-all"
          onPress={dispatch("resume-all")}
        >
          Resume all
        </Button>
        <Button
          variant="ghost"
          tone="default"
          agent="refresh"
          onPress={dispatch("refresh")}
        >
          Refresh
        </Button>
      </HStack>

      <Divider label="tasks" />
      {threads.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No task threads
        </Text>
      ) : (
        <List gap={1}>
          {threads.map((thread) => (
            <TaskThreadRow
              key={thread.id}
              thread={thread}
              dispatch={dispatch}
            />
          ))}
        </List>
      )}
      {hasMore ? (
        <Text tone="muted" align="center" style="caption">
          more…
        </Text>
      ) : null}
    </Card>
  );
}

function TaskThreadRow({
  thread,
  dispatch,
}: {
  thread: CodingAgentTaskThread;
  dispatch: (action: string) => () => void;
}) {
  return (
    <VStack gap={0} agent={`task-${thread.id}`}>
      <HStack gap={1} align="center">
        <Text tone={statusTone(thread.status)}>
          {statusMark(thread.status)}
        </Text>
        <Text bold wrap={false} grow={1}>
          {thread.title}
        </Text>
        <Text style="caption" tone={PRIORITY_TONE[thread.priority]}>
          {thread.priority}
        </Text>
      </HStack>
      <HStack gap={1} align="center" wrap>
        <Text style="caption" tone={statusTone(thread.status)}>
          {statusLabel(thread.status)}
        </Text>
        <Text style="caption" tone="muted">
          {`${thread.activeSessionCount}/${thread.sessionCount} sess`}
        </Text>
        <Text style="caption" tone="muted">
          {`${thread.decisionCount} dec`}
        </Text>
        <Text style="caption" tone="muted">
          {formatTokens(thread.usage.totalTokens)}
        </Text>
        <Text style="caption" tone="primary" grow={1}>
          {formatUsd(thread.usage.costUsd)}
        </Text>
        <Button
          variant="outline"
          tone="default"
          agent={`open-${thread.id}`}
          onPress={dispatch(`open:${thread.id}`)}
        >
          Open
        </Button>
      </HStack>
    </VStack>
  );
}

function OrchestratorDetail({
  detail,
  planSteps,
  pendingInputs,
  dispatch,
}: {
  detail: CodingAgentTaskThreadDetail;
  planSteps: OrchestratorPlanStep[];
  pendingInputs: CodingAgentPendingDecisionRecord[];
  dispatch: (action: string) => () => void;
}) {
  return (
    <Card title="Task" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Button
          variant="ghost"
          tone="default"
          agent="back"
          onPress={dispatch("back")}
        >
          {"< Back"}
        </Button>
        <Text style="caption" tone={statusTone(detail.status)} grow={1}>
          {statusLabel(detail.status)}
        </Text>
        <Text style="caption" tone={PRIORITY_TONE[detail.priority]}>
          {detail.priority}
        </Text>
      </HStack>

      <Text style="subheading" bold wrap>
        {detail.title}
      </Text>
      {detail.goal ? (
        <Text style="caption" tone="muted" wrap>
          {clamp(detail.goal, 200)}
        </Text>
      ) : null}

      <HStack gap={1} wrap>
        {detail.paused ? (
          <Button agent="resume" onPress={dispatch("resume")}>
            Resume
          </Button>
        ) : (
          <Button
            variant="outline"
            tone="default"
            agent="pause"
            onPress={dispatch("pause")}
          >
            Pause
          </Button>
        )}
        <Button
          variant="outline"
          tone="default"
          agent="validate"
          onPress={dispatch("validate")}
        >
          Validate
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="fork"
          onPress={dispatch("fork")}
        >
          Fork
        </Button>
        <Button
          variant="ghost"
          tone="danger"
          agent="delete"
          onPress={dispatch("delete")}
        >
          Delete
        </Button>
      </HStack>

      {pendingInputs.length > 0 ? (
        <PendingInputs inputs={pendingInputs} />
      ) : null}

      {planSteps.length > 0 ? <PlanSection steps={planSteps} /> : null}

      <SessionsSection sessions={detail.sessions} dispatch={dispatch} />

      {detail.decisions.length > 0 ? (
        <DecisionsSection decisions={detail.decisions} />
      ) : null}

      {detail.artifacts.length > 0 ? (
        <ArtifactsSection artifacts={detail.artifacts} />
      ) : null}

      {detail.events.length > 0 ? (
        <EventsSection events={detail.events} />
      ) : null}

      {detail.transcripts.length > 0 ? (
        <TranscriptsSection transcripts={detail.transcripts} />
      ) : null}
    </Card>
  );
}

function PendingInputs({
  inputs,
}: {
  inputs: CodingAgentPendingDecisionRecord[];
}) {
  return (
    <VStack gap={0}>
      <Divider label="awaiting you" />
      <List gap={0}>
        {inputs.slice(0, 4).map((input) => (
          <VStack
            key={input.sessionId}
            gap={0}
            agent={`pending-${input.sessionId}`}
          >
            <Text tone="warning" bold wrap>
              {clamp(input.promptText, 120)}
            </Text>
            {input.recentOutput ? (
              <Text style="caption" tone="muted" wrap={false}>
                {clamp(input.recentOutput, 80)}
              </Text>
            ) : null}
          </VStack>
        ))}
      </List>
    </VStack>
  );
}

function PlanSection({ steps }: { steps: OrchestratorPlanStep[] }) {
  return (
    <VStack gap={0}>
      <Divider label="plan" />
      <List gap={0}>
        {steps.slice(0, 10).map((step) => (
          <HStack
            key={step.id}
            gap={1}
            align="center"
            agent={`plan-${step.id}`}
          >
            <Text tone={PLAN_TONE[step.state]}>{PLAN_MARK[step.state]}</Text>
            <Text
              grow={1}
              wrap={false}
              tone={step.state === "done" ? "muted" : "default"}
            >
              {step.label}
            </Text>
          </HStack>
        ))}
      </List>
    </VStack>
  );
}

function SessionsSection({
  sessions,
  dispatch,
}: {
  sessions: CodingAgentTaskSessionRecord[];
  dispatch: (action: string) => () => void;
}) {
  return (
    <VStack gap={0}>
      <Divider label={`sessions (${sessions.length})`} />
      {sessions.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No sessions
        </Text>
      ) : (
        <List gap={1}>
          {sessions.slice(0, 8).map((session) => (
            <VStack
              key={session.id}
              gap={0}
              agent={`session-${session.sessionId}`}
            >
              <HStack gap={1} align="center">
                <Text tone={statusTone(session.status)}>
                  {statusMark(session.status)}
                </Text>
                <Text bold wrap={false} grow={1}>
                  {session.label}
                </Text>
                <Button
                  variant="ghost"
                  tone="danger"
                  agent={`stop-${session.sessionId}`}
                  onPress={dispatch(`stop-session:${session.sessionId}`)}
                >
                  Stop
                </Button>
              </HStack>
              <HStack gap={1} align="center" wrap>
                <Text style="caption" tone="muted">
                  {session.framework}
                </Text>
                {session.model ? (
                  <Text style="caption" tone="muted" wrap={false}>
                    {session.model}
                  </Text>
                ) : null}
                <Text style="caption" tone="muted">
                  {formatTokens(session.totalTokens)}
                </Text>
                <Text style="caption" tone="primary" grow={1}>
                  {formatUsd(session.costUsd)}
                </Text>
                {session.activeTool ? (
                  <Text style="caption" tone="success" wrap={false}>
                    {session.activeTool}
                  </Text>
                ) : null}
              </HStack>
            </VStack>
          ))}
        </List>
      )}
    </VStack>
  );
}

function DecisionsSection({
  decisions,
}: {
  decisions: CodingAgentTaskDecisionRecord[];
}) {
  return (
    <VStack gap={0}>
      <Divider label={`decisions (${decisions.length})`} />
      <List gap={0}>
        {decisions.slice(0, 6).map((decision) => (
          <HStack
            key={decision.id}
            gap={1}
            align="center"
            agent={`decision-${decision.id}`}
          >
            <Text tone="primary" wrap={false}>
              {decision.decision}
            </Text>
            <Text grow={1} wrap={false}>
              {clamp(decision.promptText, 100)}
            </Text>
          </HStack>
        ))}
      </List>
    </VStack>
  );
}

function ArtifactsSection({
  artifacts,
}: {
  artifacts: CodingAgentTaskArtifactRecord[];
}) {
  return (
    <VStack gap={0}>
      <Divider label={`artifacts (${artifacts.length})`} />
      <List gap={0}>
        {artifacts.slice(0, 6).map((artifact) => (
          <HStack
            key={artifact.id}
            gap={1}
            align="center"
            agent={`artifact-${artifact.id}`}
          >
            <Text tone={VERIFY_TONE[artifact.verificationStatus]} wrap={false}>
              {artifact.verificationStatus === "passed"
                ? "+"
                : artifact.verificationStatus === "failed"
                  ? "x"
                  : artifact.verificationStatus === "pending"
                    ? "~"
                    : "."}
            </Text>
            <Text grow={1} wrap={false}>
              {artifact.title}
            </Text>
            <Text style="caption" tone="muted" wrap={false}>
              {artifact.artifactType}
            </Text>
          </HStack>
        ))}
      </List>
    </VStack>
  );
}

function EventsSection({ events }: { events: CodingAgentTaskEventRecord[] }) {
  return (
    <VStack gap={0}>
      <Divider label={`events (${events.length})`} />
      <List gap={0}>
        {events.slice(0, 6).map((event) => (
          <HStack
            key={event.id}
            gap={1}
            align="center"
            agent={`event-${event.id}`}
          >
            <Text style="caption" tone="muted" wrap={false}>
              {event.eventType}
            </Text>
            <Text style="caption" grow={1} wrap={false}>
              {clamp(event.summary, 90)}
            </Text>
          </HStack>
        ))}
      </List>
    </VStack>
  );
}

function TranscriptsSection({
  transcripts,
}: {
  transcripts: CodingAgentTaskTranscriptRecord[];
}) {
  return (
    <VStack gap={0}>
      <Divider label={`transcript (${transcripts.length})`} />
      <List gap={0}>
        {transcripts.slice(-6).map((line) => (
          <Text
            key={line.id}
            style="caption"
            tone={line.direction === "stderr" ? "danger" : "muted"}
            wrap={false}
          >
            {clamp(line.content.replace(/\s+/g, " ").trim(), 110)}
          </Text>
        ))}
      </List>
    </VStack>
  );
}
