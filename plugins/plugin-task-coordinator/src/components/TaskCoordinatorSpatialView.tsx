/**
 * TaskCoordinatorSpatialView — the coding-agent task coordinator authored once
 * with the spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI — mounted in `<SpatialSurface>` (DOM). Only the GUI modality ships;
 *     "xr" and "tui" remain compatibility values in the manifest schema.
 *
 * It is purely presentational (a typed snapshot + an action callback in,
 * primitives out) and imports only the cross-modality primitives plus a
 * type-only view of the task-thread records from `@elizaos/ui`, so it is safe to
 * render in the Node agent process where the terminal lives (the `import type`
 * is erased).
 *
 * Two modes:
 *   - list   — the searchable task-thread list with count chips and a
 *              show-archived toggle; the coordinator landing.
 *   - detail — drill-down for one thread: acceptance criteria, sessions,
 *              artifacts, decisions, events, and recent messages, with
 *              Delete/Reopen affordances.
 */

import type {
  CodingAgentTaskArtifactRecord,
  CodingAgentTaskDecisionRecord,
  CodingAgentTaskEventRecord,
  CodingAgentTaskSessionRecord,
  CodingAgentTaskThread,
  CodingAgentTaskThreadDetail,
} from "@elizaos/ui";
import {
  Button,
  Card,
  Divider,
  Field,
  HStack,
  List,
  Spacer,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

type TaskStatus = CodingAgentTaskThread["status"];

/** A task-thread row distilled for list display. */
export interface TaskCoordinatorRow {
  id: string;
  title: string;
  subtitle?: string;
  status: string;
  sessionCount: number;
  decisionCount: number;
}

export interface TaskCoordinatorSnapshot {
  /** The current page of task threads (server-filtered). */
  threads: TaskCoordinatorRow[];
  /** The open thread id, or null on the list landing. */
  selectedThreadId: string | null;
  /** The open thread's drill-down, or null on the list landing. */
  detail: CodingAgentTaskThreadDetail | null;
  /** Whether the archived threads are included in the current list. */
  showArchived: boolean;
  /** The current search query. */
  search: string;
  loading?: boolean;
  error?: string | null;
}

export const EMPTY_TASK_COORDINATOR_SNAPSHOT: TaskCoordinatorSnapshot = {
  threads: [],
  selectedThreadId: null,
  detail: null,
  showArchived: false,
  search: "",
};

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

function statusTone(status: string): SpatialTone {
  return STATUS_TONE[status as TaskStatus] ?? "muted";
}

function statusMark(status: string): string {
  return STATUS_MARK[status as TaskStatus] ?? ".";
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Distil a thread record into the presentational row shape. */
export function toTaskCoordinatorRow(
  thread: CodingAgentTaskThread,
): TaskCoordinatorRow {
  return {
    id: thread.id,
    title: thread.title,
    subtitle: thread.summary || thread.originalRequest || undefined,
    status: thread.status,
    sessionCount: thread.sessionCount,
    decisionCount: thread.decisionCount,
  };
}

export interface TaskCoordinatorSpatialViewProps {
  snapshot: TaskCoordinatorSnapshot;
  /**
   * Dispatch by agent id. List: `open:<threadId>`, `search:<text>`,
   * `toggle-archived`, `refresh`. Detail: `back`, `delete-thread`,
   * `reopen-thread`.
   */
  onAction?: (action: string) => void;
}

export function TaskCoordinatorSpatialView({
  snapshot,
  onAction,
}: TaskCoordinatorSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  if (snapshot.detail) {
    return (
      <TaskDetail
        detail={snapshot.detail}
        dispatch={dispatch}
        onAction={onAction}
      />
    );
  }
  return (
    <TaskList
      threads={snapshot.threads}
      showArchived={snapshot.showArchived}
      search={snapshot.search}
      loading={snapshot.loading}
      error={snapshot.error}
      dispatch={dispatch}
      onAction={onAction}
    />
  );
}

function TaskList({
  threads,
  showArchived,
  search,
  loading,
  error,
  dispatch,
  onAction,
}: {
  threads: TaskCoordinatorRow[];
  showArchived: boolean;
  search: string;
  loading?: boolean;
  error?: string | null;
  dispatch: (action: string) => () => void;
  onAction?: (action: string) => void;
}) {
  const activeCount = threads.filter((t) => t.status === "active").length;
  const doneCount = threads.filter((t) => t.status === "done").length;
  return (
    <Card gap={1} padding={1}>
      <Spacer size={8} />
      <HStack gap={1} align="center" wrap>
        <Text style="caption" tone="muted" grow={1}>
          {loading ? "loading" : `${threads.length} total`}
        </Text>
        {activeCount > 0 ? (
          <Text style="caption" tone="success">
            {`${activeCount} active`}
          </Text>
        ) : null}
        {doneCount > 0 ? (
          <Text style="caption" tone="primary">
            {`${doneCount} done`}
          </Text>
        ) : null}
      </HStack>

      {error ? (
        <Text tone="danger" style="caption">
          {error}
        </Text>
      ) : null}

      <HStack gap={1} align="center" wrap>
        <Field
          placeholder="Search tasks"
          value={search}
          agent="search"
          grow={1}
          onChange={(value) => onAction?.(`search:${value}`)}
        />
        <Button
          variant={showArchived ? "solid" : "outline"}
          tone="default"
          agent="toggle-archived"
          onPress={dispatch("toggle-archived")}
        >
          {showArchived ? "Hide archived" : "Show archived"}
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
          {loading ? "Loading" : "Dispatch a coding agent from chat."}
        </Text>
      ) : (
        <List gap={1}>
          {threads.map((thread) => (
            <TaskRow key={thread.id} thread={thread} dispatch={dispatch} />
          ))}
        </List>
      )}
    </Card>
  );
}

function TaskRow({
  thread,
  dispatch,
}: {
  thread: TaskCoordinatorRow;
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
        <Button
          variant="outline"
          tone="default"
          agent={`open-${thread.id}`}
          onPress={dispatch(`open:${thread.id}`)}
        >
          Open
        </Button>
      </HStack>
      <HStack gap={1} align="center" wrap>
        <Text style="caption" tone={statusTone(thread.status)}>
          {statusLabel(thread.status)}
        </Text>
        {thread.sessionCount > 0 ? (
          <Text style="caption" tone="muted">
            {`${thread.sessionCount} sess`}
          </Text>
        ) : null}
        {thread.decisionCount > 0 ? (
          <Text style="caption" tone="muted">
            {`${thread.decisionCount} dec`}
          </Text>
        ) : null}
        {thread.subtitle ? (
          <Text style="caption" tone="muted" grow={1} wrap={false}>
            {clamp(thread.subtitle, 80)}
          </Text>
        ) : null}
      </HStack>
    </VStack>
  );
}

function TaskDetail({
  detail,
  dispatch,
}: {
  detail: CodingAgentTaskThreadDetail;
  dispatch: (action: string) => () => void;
  onAction?: (action: string) => void;
}) {
  return (
    <Card gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Button
          variant="ghost"
          tone="default"
          agent="back"
          onPress={dispatch("back")}
        >
          {"< Tasks"}
        </Button>
        <Text style="caption" tone={statusTone(detail.status)} grow={1}>
          {statusLabel(detail.status)}
        </Text>
      </HStack>

      <Text style="subheading" bold wrap>
        {detail.title}
      </Text>
      {detail.originalRequest ? (
        <Text style="caption" tone="muted" wrap>
          {clamp(detail.originalRequest, 200)}
        </Text>
      ) : null}

      <HStack gap={1} wrap>
        {detail.status === "archived" ? (
          <Button agent="reopen-thread" onPress={dispatch("reopen-thread")}>
            Reopen
          </Button>
        ) : (
          <Button
            variant="ghost"
            tone="danger"
            agent="delete-thread"
            onPress={dispatch("delete-thread")}
          >
            Delete
          </Button>
        )}
      </HStack>

      {detail.acceptanceCriteria.length > 0 ? (
        <AcceptanceSection criteria={detail.acceptanceCriteria} />
      ) : null}

      <SessionsSection sessions={detail.sessions} />

      {detail.artifacts.length > 0 ? (
        <ArtifactsSection artifacts={detail.artifacts} />
      ) : null}

      {detail.decisions.length > 0 ? (
        <DecisionsSection decisions={detail.decisions} />
      ) : null}

      {detail.events.length > 0 ? (
        <EventsSection events={detail.events} />
      ) : null}
    </Card>
  );
}

function AcceptanceSection({ criteria }: { criteria: string[] }) {
  return (
    <VStack gap={0}>
      <Divider label="acceptance" />
      <List gap={0}>
        {criteria.slice(0, 8).map((criterion) => (
          <Text key={criterion} style="caption" wrap>
            {clamp(criterion, 110)}
          </Text>
        ))}
      </List>
    </VStack>
  );
}

function SessionsSection({
  sessions,
}: {
  sessions: CodingAgentTaskSessionRecord[];
}) {
  return (
    <VStack gap={0}>
      <Divider label={`sessions (${sessions.length})`} />
      {sessions.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          None
        </Text>
      ) : (
        <List gap={0}>
          {sessions
            .slice(-6)
            .reverse()
            .map((session) => (
              <VStack key={session.id} gap={0} agent={`session-${session.id}`}>
                <Text bold wrap={false}>
                  {session.label}
                </Text>
                <HStack gap={1} align="center" wrap>
                  <Text style="caption" tone={statusTone(session.status)}>
                    {statusLabel(session.status)}
                  </Text>
                  <Text style="caption" tone="muted">
                    {session.framework}
                  </Text>
                  <Text style="caption" tone="muted" grow={1} wrap={false}>
                    {session.workdir || session.repo || "no workspace"}
                  </Text>
                </HStack>
              </VStack>
            ))}
        </List>
      )}
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
        {artifacts
          .slice(-6)
          .reverse()
          .map((artifact) => (
            <HStack
              key={artifact.id}
              gap={1}
              align="center"
              agent={`artifact-${artifact.id}`}
            >
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

function DecisionsSection({
  decisions,
}: {
  decisions: CodingAgentTaskDecisionRecord[];
}) {
  return (
    <VStack gap={0}>
      <Divider label={`decisions (${decisions.length})`} />
      <List gap={0}>
        {decisions
          .slice(-6)
          .reverse()
          .map((decision) => (
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
                {clamp(decision.reasoning || decision.promptText, 100)}
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
        {events
          .slice(-6)
          .reverse()
          .map((event) => (
            <HStack
              key={event.id}
              gap={1}
              align="center"
              agent={`event-${event.id}`}
            >
              <Text style="caption" tone="muted" wrap={false}>
                {event.eventType.replace(/_/g, " ")}
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
