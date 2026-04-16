import {
  client,
  EmptyWidgetState,
  PULSE_STATUSES,
  STATUS_DOT,
  TERMINAL_STATUSES,
  WidgetSection,
  usePtySessions,
  useApp,
  type CodingAgentSession,
  type CodingAgentTaskThread,
  type CodingAgentTaskThreadDetail,
} from "@elizaos/app-core";
import { Badge, Button } from "@elizaos/ui";
import { Activity, SquareArrowOutUpRight } from "lucide-react";
import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";

const ANSI_ESCAPE_PATTERN = new RegExp(
  [
    "\\u001b(?:",
    "\\[[0-9;?]*[A-Za-z]|\\][^\\u0007]*\\u0007|[()][0-9A-Za-z])",
  ].join(""),
  "g",
);

const fallbackTranslate = (
  key: string,
  vars?: { defaultValue?: string },
): string => vars?.defaultValue ?? key;

function deriveSessionActivity(session: CodingAgentSession): string {
  if (session.status === "tool_running" && session.toolDescription) {
    return `Running ${session.toolDescription}`.slice(0, 60);
  }
  if (session.status === "blocked") return "Waiting for input";
  return "Running";
}

function relativeTime(ts: number): string {
  const delta = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  const mins = Math.floor(delta / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function stripAnsi(str: string): string {
  return str.replace(ANSI_ESCAPE_PATTERN, "").trim();
}

function formatIsoTime(value?: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return relativeTime(date.getTime());
}

function formatThreadStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function getWorkspaceChangesSummary(
  metadata: Record<string, unknown>,
): { files: string[]; total: number } | null {
  const raw = metadata.workspaceChanges;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const workspaceChanges = raw as {
    changedFiles?: unknown;
    totalChangedFiles?: unknown;
  };
  const changedFiles = Array.isArray(workspaceChanges.changedFiles)
    ? workspaceChanges.changedFiles.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const total =
    typeof workspaceChanges.totalChangedFiles === "number"
      ? workspaceChanges.totalChangedFiles
      : changedFiles.length;
  if (total <= 0 || changedFiles.length === 0) {
    return null;
  }
  return {
    files: changedFiles,
    total,
  };
}

const THREAD_STATUS_BADGE: Record<string, string> = {
  open: "bg-muted/20 text-muted",
  active: "bg-ok/20 text-ok",
  waiting_on_user: "bg-warn/20 text-warn",
  blocked: "bg-warn/20 text-warn",
  validating: "bg-accent/20 text-accent",
  done: "bg-ok/20 text-ok",
  failed: "bg-danger/20 text-danger",
  archived: "bg-muted/20 text-muted",
  interrupted: "bg-warn/20 text-warn",
};

function getClientErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function TaskCard({ session }: { session: CodingAgentSession }) {
  const activity = session.lastActivity ?? deriveSessionActivity(session);

  return (
    <div className="rounded-lg border border-border/50 bg-bg-accent/30 p-3 text-left">
      <div className="mb-1 flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
            STATUS_DOT[session.status] ?? "bg-muted"
          }${PULSE_STATUSES.has(session.status) ? " animate-pulse" : ""}`}
        />
        <span className="flex-1 truncate text-xs font-semibold text-txt">
          {session.label}
        </span>
      </div>
      {session.originalTask ? (
        <p className="mb-1 line-clamp-2 text-xs-tight text-muted">
          {session.originalTask}
        </p>
      ) : null}
      <p
        className={`truncate text-xs-tight ${
          session.status === "blocked" ? "text-warn" : "text-muted"
        }`}
      >
        {activity}
      </p>
    </div>
  );
}

function TaskItemsContent({ sessions }: { sessions: CodingAgentSession[] }) {
  if (sessions.length === 0) {
    return (
      <EmptyWidgetState
        icon={<Activity className="h-8 w-8" />}
        title="No orchestrator work running"
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sessions.map((session) => (
        <TaskCard key={session.sessionId} session={session} />
      ))}
    </div>
  );
}

function DetailList({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-bg-accent/20 p-2.5">
      <div className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
        {title}
      </div>
      {children}
    </div>
  );
}

function ThreadDetailContent({
  detail,
  busy,
  onDelete,
  onReopen,
}: {
  detail: CodingAgentTaskThreadDetail;
  busy: boolean;
  onDelete: () => void;
  onReopen: () => void;
}) {
  const latestTranscripts = (detail.transcripts ?? [])
    .filter((entry) => entry.direction === "stdin" || entry.direction === "system")
    .slice(-8)
    .reverse();
  const latestEvents = (detail.events ?? []).slice(-6).reverse();
  const latestDecisions = (detail.decisions ?? []).slice(-6).reverse();
  const latestArtifacts = (detail.artifacts ?? []).slice(-6).reverse();
  const pendingDecisions = (detail.pendingDecisions ?? []).slice(-4).reverse();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-3 text-2xs text-muted">
        <span>{(detail.sessions ?? []).length} sessions</span>
        <span>{(detail.artifacts ?? []).length} artifacts</span>
        <span>{(detail.transcripts ?? []).length} transcript entries</span>
      </div>

      {detail.acceptanceCriteria && detail.acceptanceCriteria.length > 0 ? (
        <div>
          <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
            Acceptance
          </div>
          <div className="space-y-0.5">
            {detail.acceptanceCriteria.map((criterion) => (
              <div
                key={`${detail.id}-criterion-${criterion}`}
                className="text-xs-tight text-txt"
              >
                {criterion}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <DetailList title="Sessions">
        {(detail.sessions ?? []).length === 0 ? (
          <div className="text-xs-tight text-muted">No sessions recorded.</div>
        ) : (
          <div className="space-y-1.5">
            {(detail.sessions ?? [])
              .slice(-4)
              .reverse()
              .map((session) => (
                <div key={session.id} className="text-xs-tight text-txt">
                  <div className="font-medium">{session.label}</div>
                  <div className="text-muted">
                    {session.framework}
                    {session.providerSource
                      ? ` (${session.providerSource})`
                      : ""}
                    {" · "}
                    {session.status} ·{" "}
                    {session.workdir || session.repo || "no workspace"}
                  </div>
                  {getWorkspaceChangesSummary(session.metadata) ? (
                    <div className="text-muted">
                      {(() => {
                        const summary = getWorkspaceChangesSummary(
                          session.metadata,
                        );
                        if (!summary) return null;
                        const preview = summary.files.slice(0, 3).join(", ");
                        return summary.total > 3
                          ? `${summary.total} changed files: ${preview}, +${summary.total - 3} more`
                          : `${summary.total} changed files: ${preview}`;
                      })()}
                    </div>
                  ) : null}
                </div>
              ))}
          </div>
        )}
      </DetailList>

      {pendingDecisions.length > 0 ? (
        <DetailList title="Pending User Input">
          <div className="space-y-1.5">
            {pendingDecisions.map((decision) => (
              <div
                key={`${decision.threadId}-${decision.sessionId}`}
                className="text-xs-tight text-txt"
              >
                <div className="font-medium">{decision.promptText}</div>
                <div className="line-clamp-2 text-muted">
                  {typeof decision.llmDecision.reasoning === "string"
                    ? decision.llmDecision.reasoning
                    : decision.recentOutput ||
                      "Coordinator is waiting for the next user response."}
                </div>
              </div>
            ))}
          </div>
        </DetailList>
      ) : null}

      {latestArtifacts.length > 0 ? (
        <DetailList title="Artifacts">
          <div className="space-y-1.5">
            {latestArtifacts.map((artifact) => (
              <div key={artifact.id} className="text-xs-tight text-txt">
                <div className="font-medium">{artifact.title}</div>
                <div className="break-all text-muted">
                  {artifact.artifactType} ·{" "}
                  {artifact.path ?? artifact.uri ?? "inline"}
                </div>
              </div>
            ))}
          </div>
        </DetailList>
      ) : null}

      {latestDecisions.length > 0 ? (
        <DetailList title="Coordinator Decisions">
          <div className="space-y-1.5">
            {latestDecisions.map((decision) => (
              <div key={decision.id} className="text-xs-tight text-txt">
                <div className="font-medium">
                  {decision.decision} · {relativeTime(decision.timestamp)}
                </div>
                <div className="line-clamp-3 text-muted">
                  {decision.reasoning}
                </div>
              </div>
            ))}
          </div>
        </DetailList>
      ) : null}

      {latestEvents.length > 0 ? (
        <DetailList title="Events">
          <div className="space-y-1.5">
            {latestEvents.map((event) => (
              <div key={event.id} className="text-xs-tight text-txt">
                <div className="font-medium">
                  {event.eventType.replace(/_/g, " ")} ·{" "}
                  {relativeTime(event.timestamp)}
                </div>
                <div className="line-clamp-2 text-muted">{event.summary}</div>
              </div>
            ))}
          </div>
        </DetailList>
      ) : null}

      {latestTranscripts.length > 0 ? (
        <DetailList title="Messages">
          <div className="max-h-40 space-y-2 overflow-y-auto pr-1">
            {latestTranscripts.map((entry) => {
              const text = stripAnsi(entry.content);
              if (!text) return null;
              return (
                <div
                  key={entry.id}
                  className="rounded border border-border/40 bg-bg-hover/40 p-2"
                >
                  <div className="mb-1 text-2xs uppercase tracking-[0.08em] text-muted">
                    {entry.direction === "stdin" ? "prompt" : "system"} ·{" "}
                    {relativeTime(entry.timestamp)}
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-2xs text-txt">
                    {text}
                  </pre>
                </div>
              );
            })}
          </div>
        </DetailList>
      ) : null}

      <div className="flex gap-2 pt-1">
        {detail.status === "archived" ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onReopen}
            className="h-7 px-2 text-xs-tight"
          >
            Reopen
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onDelete}
            className="h-7 px-2 text-xs-tight text-danger hover:bg-danger/10"
          >
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

function TaskThreadCard({
  thread,
  selected,
  onSelect,
  detail,
  detailLoading,
  busy,
  onDelete,
  onReopen,
}: {
  thread: CodingAgentTaskThread;
  selected: boolean;
  onSelect: (threadId: string) => void;
  detail?: CodingAgentTaskThreadDetail | null;
  detailLoading?: boolean;
  busy?: boolean;
  onDelete?: () => void;
  onReopen?: () => void;
}) {
  return (
    <div
      className={`flex flex-col rounded-lg border transition-colors ${
        selected
          ? "border-accent/50 bg-bg-hover/70"
          : "border-border/50 bg-bg-accent/30"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(thread.id)}
        className="flex w-full flex-col gap-1 p-3 text-left hover:bg-bg-hover/30"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-txt">
              {thread.title}
            </div>
            <div className="mt-0.5 truncate text-xs-tight text-muted">
              {thread.originalRequest}
            </div>
          </div>
          <Badge
            variant="secondary"
            className={`shrink-0 text-3xs ${
              THREAD_STATUS_BADGE[thread.status] ?? "bg-muted/20 text-muted"
            }`}
          >
            {formatThreadStatus(thread.status)}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-2xs text-muted">
          <span>{thread.kind}</span>
          <span>{thread.sessionCount} sessions</span>
          <span>{thread.decisionCount} decisions</span>
          <span>{formatIsoTime(thread.updatedAt)}</span>
        </div>
        {thread.summary ? (
          <div className="line-clamp-2 text-xs-tight text-txt">
            {thread.summary}
          </div>
        ) : null}
      </button>

      {selected ? (
        <div className="px-3 pb-3 pt-2.5">
          {!detail && detailLoading ? (
            <div className="text-xs-tight text-muted">Loading...</div>
          ) : detail ? (
            <ThreadDetailContent
              detail={detail}
              busy={busy ?? false}
              onDelete={onDelete ?? (() => {})}
              onReopen={onReopen ?? (() => {})}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function CodingAgentTasksPanel({
  fullPage = false,
}: {
  fullPage?: boolean;
} = {}) {
  const app = useApp() as ReturnType<typeof useApp> | undefined;
  const t = app?.t ?? fallbackTranslate;
  const setTab = app?.setTab ?? (() => undefined);
  const { ptySessions } = usePtySessions();
  const activeSessions = useMemo(
    () =>
      (ptySessions ?? []).filter(
        (session) => !TERMINAL_STATUSES.has(session.status),
      ),
    [ptySessions],
  );
  const [threads, setThreads] = useState<CodingAgentTaskThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] =
    useState<CodingAgentTaskThreadDetail | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search.trim());
  const selectedThreadSummary = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );

  useEffect(() => {
    let cancelled = false;

    const refreshThreads = async (silent = false) => {
      if (!silent) {
        setLoading(true);
      }
      try {
        const nextThreads = await client.listCodingAgentTaskThreads({
          includeArchived: showArchived,
          search: deferredSearch || undefined,
          limit: 30,
        });
        if (cancelled) return;
        setLoadError(null);
        setMutationError(null);
        setThreads(nextThreads);
        setSelectedThreadId((current) => {
          if (current === null) return null;
          if (nextThreads.some((thread) => thread.id === current)) {
            return current;
          }
          return null;
        });
      } catch (error) {
        if (cancelled) return;
        if (!silent) {
          setLoadError(
            getClientErrorMessage(error, "Failed to load task threads."),
          );
        }
        if (!silent) {
          setThreads([]);
          setSelectedThreadId(null);
          setSelectedThread(null);
        }
      } finally {
        if (!cancelled && !silent) {
          setLoading(false);
        }
      }
    };

    void refreshThreads(false);
    const timer = setInterval(() => {
      // Poll in the background without toggling loading UI to avoid flicker.
      void refreshThreads(true);
    }, 5_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [deferredSearch, showArchived]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedThreadId) {
      setDetailError(null);
      setSelectedThread(null);
      return;
    }

    const loadDetail = async () => {
      try {
        const expectedUpdatedAt = selectedThreadSummary?.updatedAt ?? null;
        const detail = await client.getCodingAgentTaskThread(selectedThreadId);
        if (cancelled) return;
        setDetailError(null);
        setSelectedThread((current) => {
          if (
            current &&
            detail &&
            expectedUpdatedAt &&
            current.updatedAt === expectedUpdatedAt &&
            current.id === detail.id
          ) {
            return current;
          }
          return detail;
        });
      } catch (error) {
        if (cancelled) return;
        setDetailError(
          getClientErrorMessage(error, "Failed to load task detail."),
        );
        setSelectedThread(null);
      }
    };
    void loadDetail();

    return () => {
      cancelled = true;
    };
  }, [selectedThreadId, selectedThreadSummary?.updatedAt]);

  const handleDelete = async () => {
    if (!selectedThread) return;
    setMutating(true);
    setMutationError(null);
    try {
      await client.archiveCodingAgentTaskThread(selectedThread.id);
      const nextThreads = await client.listCodingAgentTaskThreads({
        includeArchived: showArchived,
        search: deferredSearch || undefined,
        limit: 30,
      });
      setLoadError(null);
      setDetailError(null);
      setMutationError(null);
      setThreads(nextThreads);
      setSelectedThreadId(nextThreads[0]?.id ?? null);
    } catch (error) {
      setMutationError(
        error instanceof Error
          ? `Failed to delete task: ${error.message}`
          : "Failed to delete task.",
      );
    } finally {
      setMutating(false);
    }
  };

  const handleReopen = async () => {
    if (!selectedThread) return;
    setMutating(true);
    setMutationError(null);
    try {
      await client.reopenCodingAgentTaskThread(selectedThread.id);
      const nextThreads = await client.listCodingAgentTaskThreads({
        includeArchived: false,
        search: deferredSearch || undefined,
        limit: 30,
      });
      setLoadError(null);
      setDetailError(null);
      setMutationError(null);
      setThreads(nextThreads);
      setShowArchived(false);
      setSelectedThreadId(nextThreads[0]?.id ?? null);
    } catch (error) {
      setMutationError(
        error instanceof Error
          ? `Failed to reopen task: ${error.message}`
          : "Failed to reopen task.",
      );
    } finally {
      setMutating(false);
    }
  };

  return (
    <WidgetSection
      title={t("taskseventspanel.Tasks", { defaultValue: "Tasks" })}
      icon={<Activity className="h-4 w-4" />}
      action={
        !fullPage ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-2xs"
            onClick={() => setTab("tasks")}
          >
            <SquareArrowOutUpRight className="h-3 w-3" />
            Open View
          </Button>
        ) : null
      }
      testId="chat-widget-orchestrator"
    >
      <div className="mb-2">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search tasks"
          className="h-8 w-full rounded-md border border-border/50 bg-bg px-2 text-xs-tight text-txt outline-none transition-colors placeholder:text-muted focus:border-accent/50"
        />
      </div>
      {loadError ? (
        <div className="mb-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs-tight text-danger">
          Failed to load task threads: {loadError}
        </div>
      ) : null}
      {mutationError ? (
        <div className="mb-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs-tight text-danger">
          {mutationError}
        </div>
      ) : null}
      {threads.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {detailError ? (
            <div className="rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs-tight text-danger">
              Failed to load task detail: {detailError}
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            {threads.map((thread) => (
              <TaskThreadCard
                key={thread.id}
                thread={thread}
                selected={thread.id === selectedThreadId}
                onSelect={(id) =>
                  setSelectedThreadId((current) => (current === id ? null : id))
                }
                detail={thread.id === selectedThreadId ? selectedThread : null}
                detailLoading={loading}
                busy={mutating}
                onDelete={handleDelete}
                onReopen={handleReopen}
              />
            ))}
          </div>
        </div>
      ) : loading ? (
        <div className="text-xs-tight text-muted">Loading tasks...</div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <TaskItemsContent sessions={activeSessions} />
        </div>
      )}
    </WidgetSection>
  );
}
