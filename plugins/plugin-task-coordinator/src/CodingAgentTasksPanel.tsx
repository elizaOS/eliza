// Direct subpath: the app renderer resolves the bare `@elizaos/ui` root to the
// browser barrel, which doesn't reliably re-export this newer component.
import {
  ApiError,
  Button,
  ChatEmptyStateWithRecommendations,
  type CodingAgentTaskThread,
  type CodingAgentTaskThreadDetail,
  client,
  useAppSelectorShallow,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Archive, Bot, ListChecks, Terminal } from "lucide-react";
import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  BackChip,
  SparseWatermark,
  TaskCard,
  TaskCountChip,
  TaskListHeader,
  TaskMetaChip,
  TaskSearchInput,
  TaskStatusMedallion,
} from "./TaskCardList";

const ANSI_ESCAPE_PATTERN = new RegExp(
  [
    "\\u001b(?:",
    "\\[[0-9;?]*[A-Za-z]|\\][^\\u0007]*\\u0007|[()][0-9A-Za-z])",
  ].join(""),
  "g",
);
const fallbackTranslate = (
  key: string,
  vars?: Record<string, unknown>,
): string => String(vars?.defaultValue ?? key);

function formatRelativeTime(ts: number, locale?: string): string {
  const delta = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (delta < 5) return formatter.format(0, "second");
  if (delta < 60) return formatter.format(-delta, "second");
  const minutes = Math.floor(delta / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.floor(hours / 24), "day");
}

function stripAnsi(str: string): string {
  return str.replace(ANSI_ESCAPE_PATTERN, "").trim();
}

function formatIsoTime(
  value: string | null | undefined,
  locale: string | undefined,
  t: typeof fallbackTranslate,
): string {
  if (!value) {
    return t("codingagenttaskspanel.unknown", {
      defaultValue: "Unknown",
    });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return t("codingagenttaskspanel.unknown", {
      defaultValue: "Unknown",
    });
  }
  return formatRelativeTime(date.getTime(), locale);
}

function formatThreadStatus(
  status: string,
  t: typeof fallbackTranslate,
): string {
  const mapped: Record<string, string> = {
    open: "codingagenttaskspanel.status.open",
    active: "codingagenttaskspanel.status.active",
    waiting_on_user: "codingagenttaskspanel.status.waitingOnUser",
    blocked: "codingagenttaskspanel.status.blocked",
    validating: "codingagenttaskspanel.status.validating",
    done: "codingagenttaskspanel.status.done",
    failed: "codingagenttaskspanel.status.failed",
    archived: "codingagenttaskspanel.status.archived",
    interrupted: "codingagenttaskspanel.status.interrupted",
  };
  return t(mapped[status] ?? "codingagenttaskspanel.status.unknown", {
    defaultValue: status.replace(/_/g, " "),
  });
}

// Only meaningful kinds get a label; generic/unknown kinds (e.g. "task") carry
// no signal and must not render a chip.
const THREAD_KIND_LABELS: Record<string, string> = {
  coding: "codingagenttaskspanel.kind.coding",
};

function formatThreadKind(
  kind: string,
  t: typeof fallbackTranslate,
): string | null {
  const key = THREAD_KIND_LABELS[kind];
  if (!key) return null;
  return t(key, { defaultValue: kind });
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

function getClientErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function DetailList({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-2xs font-semibold text-muted/70">{title}</div>
      {children}
    </div>
  );
}

function ThreadActionButton({
  agentId,
  label,
  description,
  variant,
  disabled,
  onClick,
  className,
}: {
  agentId: string;
  label: string;
  description: string;
  variant: "secondary";
  disabled: boolean;
  onClick: () => void;
  className: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group: "thread-actions",
    description,
  });
  return (
    <Button
      ref={ref}
      variant={variant}
      size="sm"
      disabled={disabled}
      onClick={onClick}
      className={className}
      aria-label={label}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

function ThreadDetailContent({
  detail,
  busy,
  onDelete,
  onReopen,
  t,
  locale,
}: {
  detail: CodingAgentTaskThreadDetail;
  busy: boolean;
  onDelete: () => void;
  onReopen: () => void;
  t: typeof fallbackTranslate;
  locale?: string;
}) {
  const latestTranscripts = (detail.transcripts ?? [])
    .filter(
      (entry) => entry.direction === "stdin" || entry.direction === "system",
    )
    .slice(-8)
    .reverse();
  const latestEvents = (detail.events ?? []).slice(-6).reverse();
  const latestDecisions = (detail.decisions ?? []).slice(-6).reverse();
  const latestArtifacts = (detail.artifacts ?? []).slice(-6).reverse();
  const pendingDecisions = (detail.pendingDecisions ?? []).slice(-4).reverse();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3 text-2xs text-muted">
        <span>
          {t("codingagenttaskspanel.sessionsCount", {
            defaultValue: "{{count}} sessions",
            count: (detail.sessions ?? []).length,
          })}
        </span>
        <span>
          {t("codingagenttaskspanel.artifactsCount", {
            defaultValue: "{{count}} artifacts",
            count: (detail.artifacts ?? []).length,
          })}
        </span>
        <span>
          {t("codingagenttaskspanel.transcriptEntriesCount", {
            defaultValue: "{{count}} transcript entries",
            count: (detail.transcripts ?? []).length,
          })}
        </span>
      </div>

      {detail.acceptanceCriteria && detail.acceptanceCriteria.length > 0 ? (
        <div>
          <div className="mb-1 text-2xs font-semibold text-muted">
            {t("codingagenttaskspanel.acceptance", {
              defaultValue: "Acceptance",
            })}
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

      <DetailList
        title={t("codingagenttaskspanel.sessions", {
          defaultValue: "Sessions",
        })}
      >
        {(detail.sessions ?? []).length === 0 ? (
          <div className="text-xs-tight text-muted">
            {t("codingagenttaskspanel.noSessionsRecorded", {
              defaultValue: "None",
            })}
          </div>
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
                    {formatThreadStatus(session.status, t)} ·{" "}
                    {session.workdir ||
                      session.repo ||
                      t("codingagenttaskspanel.noWorkspace", {
                        defaultValue: "None",
                      })}
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
                          ? t("codingagenttaskspanel.changedFilesMore", {
                              defaultValue:
                                "{{count}} changed files: {{preview}}, +{{remaining}} more",
                              count: summary.total,
                              preview,
                              remaining: summary.total - 3,
                            })
                          : t("codingagenttaskspanel.changedFiles", {
                              defaultValue:
                                "{{count}} changed files: {{preview}}",
                              count: summary.total,
                              preview,
                            });
                      })()}
                    </div>
                  ) : null}
                </div>
              ))}
          </div>
        )}
      </DetailList>

      {pendingDecisions.length > 0 ? (
        <DetailList
          title={t("codingagenttaskspanel.pendingUserInput", {
            defaultValue: "Pending User Input",
          })}
        >
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
                      t("codingagenttaskspanel.waitingForNextUserResponse", {
                        defaultValue:
                          "Coordinator is waiting for the next user response.",
                      })}
                </div>
              </div>
            ))}
          </div>
        </DetailList>
      ) : null}

      {latestArtifacts.length > 0 ? (
        <DetailList
          title={t("codingagenttaskspanel.artifacts", {
            defaultValue: "Artifacts",
          })}
        >
          <div className="space-y-1.5">
            {latestArtifacts.map((artifact) => (
              <div key={artifact.id} className="text-xs-tight text-txt">
                <div className="font-medium">{artifact.title}</div>
                <div className="break-all text-muted">
                  {artifact.artifactType} ·{" "}
                  {artifact.path ??
                    artifact.uri ??
                    t("codingagenttaskspanel.inline", {
                      defaultValue: "inline",
                    })}
                </div>
              </div>
            ))}
          </div>
        </DetailList>
      ) : null}

      {latestDecisions.length > 0 ? (
        <DetailList
          title={t("codingagenttaskspanel.coordinatorDecisions", {
            defaultValue: "Coordinator Decisions",
          })}
        >
          <div className="space-y-1.5">
            {latestDecisions.map((decision) => (
              <div key={decision.id} className="text-xs-tight text-txt">
                <div className="font-medium">
                  {decision.decision} ·{" "}
                  {formatRelativeTime(decision.timestamp, locale)}
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
        <DetailList
          title={t("codingagenttaskspanel.events", {
            defaultValue: "Events",
          })}
        >
          <div className="space-y-1.5">
            {latestEvents.map((event) => (
              <div key={event.id} className="text-xs-tight text-txt">
                <div className="font-medium">
                  {event.eventType.replace(/_/g, " ")} ·{" "}
                  {formatRelativeTime(event.timestamp, locale)}
                </div>
                <div className="line-clamp-2 text-muted">{event.summary}</div>
              </div>
            ))}
          </div>
        </DetailList>
      ) : null}

      {latestTranscripts.length > 0 ? (
        <DetailList
          title={t("codingagenttaskspanel.messages", {
            defaultValue: "Messages",
          })}
        >
          <div className="max-h-40 space-y-2 overflow-y-auto pr-1">
            {latestTranscripts.map((entry) => {
              const text = stripAnsi(entry.content);
              if (!text) return null;
              return (
                <div
                  key={entry.id}
                  className="rounded border border-border/40 bg-bg-hover/40 p-2"
                >
                  <div className="mb-1 text-2xs text-muted">
                    {entry.direction === "stdin"
                      ? t("codingagenttaskspanel.prompt", {
                          defaultValue: "prompt",
                        })
                      : t("codingagenttaskspanel.system", {
                          defaultValue: "system",
                        })}{" "}
                    · {formatRelativeTime(entry.timestamp, locale)}
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
          <ThreadActionButton
            agentId="action-reopen-thread"
            label={t("codingagenttaskspanel.reopen", {
              defaultValue: "Reopen",
            })}
            description="Reopen the selected archived task thread"
            variant="secondary"
            disabled={busy}
            onClick={onReopen}
            className="h-7 px-2 text-xs-tight"
          />
        ) : (
          <ThreadActionButton
            agentId="action-delete-thread"
            label={t("codingagenttaskspanel.delete", {
              defaultValue: "Delete",
            })}
            description="Delete (archive) the selected task thread"
            variant="secondary"
            disabled={busy}
            onClick={onDelete}
            className="h-7 px-2 text-xs-tight text-danger hover:bg-danger/10"
          />
        )}
      </div>
    </div>
  );
}

/** Visual chips summarizing a thread for the card list. Zero-value and unknown
 * metadata is omitted so a fresh task never shows bare "0" / "unknown" chips. */
function threadChips(
  thread: CodingAgentTaskThread,
  t: typeof fallbackTranslate,
  locale?: string,
): ReactNode {
  const kindLabel = thread.kind ? formatThreadKind(thread.kind, t) : null;
  return (
    <>
      {thread.sessionCount > 0 ? (
        <TaskMetaChip icon={<Bot className="h-3 w-3" />}>
          {t("codingagenttaskspanel.sessionsCount", {
            defaultValue: "{{count}} sessions",
            count: thread.sessionCount,
          })}
        </TaskMetaChip>
      ) : null}
      {thread.decisionCount > 0 ? (
        <TaskMetaChip icon={<ListChecks className="h-3 w-3" />}>
          {t("codingagenttaskspanel.decisionsCount", {
            defaultValue: "{{count}} decisions",
            count: thread.decisionCount,
          })}
        </TaskMetaChip>
      ) : null}
      {kindLabel ? (
        <TaskMetaChip icon={<Terminal className="h-3 w-3" />}>
          {kindLabel}
        </TaskMetaChip>
      ) : null}
      <span className="text-2xs text-muted/80">
        {formatIsoTime(thread.updatedAt, locale, t)}
      </span>
    </>
  );
}

/** Full-pane task detail entered by clicking a card. Header medallion + back. */
function ThreadDetailPane({
  thread,
  detail,
  detailLoading,
  busy,
  onBack,
  onDelete,
  onReopen,
  t,
  locale,
}: {
  thread: CodingAgentTaskThread;
  detail: CodingAgentTaskThreadDetail | null;
  detailLoading: boolean;
  busy: boolean;
  onBack: () => void;
  onDelete: () => void;
  onReopen: () => void;
  t: typeof fallbackTranslate;
  locale?: string;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="task-detail-pane">
      <BackChip
        label={t("codingagenttaskspanel.backToTasks", {
          defaultValue: "Tasks",
        })}
        onClick={onBack}
        testId="task-detail-back"
      />
      <div className="flex items-start gap-3 rounded-2xl bg-bg-accent/20 p-3">
        <TaskStatusMedallion status={thread.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-txt-strong">
            {thread.title}
          </div>
          {thread.originalRequest ? (
            <div className="mt-0.5 line-clamp-2 text-xs text-muted">
              {thread.originalRequest}
            </div>
          ) : null}
        </div>
      </div>
      {!detail && detailLoading ? (
        <div className="text-xs-tight text-muted">
          {t("common.loading", { defaultValue: "Loading…" })}
        </div>
      ) : detail ? (
        <ThreadDetailContent
          detail={detail}
          busy={busy}
          onDelete={onDelete}
          onReopen={onReopen}
          t={t}
          locale={locale}
        />
      ) : null}
    </div>
  );
}

export function CodingAgentTasksPanel({
  fullPage,
}: {
  fullPage?: boolean;
} = {}) {
  const { t: appT, uiLanguage: appUiLanguage } = useAppSelectorShallow((s) => ({
    t: s.t,
    uiLanguage: s.uiLanguage,
  }));
  const t = appT ?? fallbackTranslate;
  const uiLanguage =
    typeof appUiLanguage === "string" ? appUiLanguage : undefined;
  const [threads, setThreads] = useState<CodingAgentTaskThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] =
    useState<CodingAgentTaskThreadDetail | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  // The coding-agent endpoint is owned by the Node-only orchestrator plugin and
  // is absent on mobile/web; a 404 means "set up coding agents", not an error.
  const [backendAbsent, setBackendAbsent] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search.trim());
  const selectedThreadSummary = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );
  const searchLabel = t("codingagenttaskspanel.searchPlaceholder", {
    defaultValue: "Search tasks",
  });
  const showArchivedLabel = t("codingagenttaskspanel.showArchived", {
    defaultValue: "Show archived",
  });
  const { ref: searchRef, agentProps: searchAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "input-search-tasks",
      role: "text-input",
      label: searchLabel,
      group: "task-filters",
      description: "Filter task threads by title or request text",
    });
  const { ref: archivedRef, agentProps: archivedAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "toggle-show-archived",
      role: "toggle",
      label: showArchivedLabel,
      group: "task-filters",
      status: showArchived ? "active" : "inactive",
      description: "Toggle showing archived tasks",
      onActivate: () => setShowArchived((value) => !value),
    });

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
        setBackendAbsent(false);
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
        // The task-thread endpoint is owned by the Node-only
        // @elizaos/plugin-agent-orchestrator and is absent on mobile/web
        // surfaces. A 404 there means "no coding tasks", not a load failure —
        // render the empty state instead of the red error banner.
        if (error instanceof ApiError && error.status === 404) {
          setLoadError(null);
          setBackendAbsent(true);
          setThreads([]);
          setSelectedThreadId(null);
          setSelectedThread(null);
          return;
        }
        if (!silent) {
          setLoadError(
            getClientErrorMessage(
              error,
              t("codingagenttaskspanel.unknown", {
                defaultValue: "Unknown",
              }),
            ),
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
  }, [deferredSearch, showArchived, t]);

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
          getClientErrorMessage(
            error,
            t("codingagenttaskspanel.unknown", {
              defaultValue: "Unknown",
            }),
          ),
        );
        setSelectedThread(null);
      }
    };
    void loadDetail();

    return () => {
      cancelled = true;
    };
  }, [selectedThreadId, selectedThreadSummary?.updatedAt, t]);

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
        t("codingagenttaskspanel.deleteFailed", {
          defaultValue:
            error instanceof Error
              ? "Failed to delete task: {{error}}"
              : "Failed to delete task.",
          error: error instanceof Error ? error.message : undefined,
        }),
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
        t("codingagenttaskspanel.reopenFailed", {
          defaultValue:
            error instanceof Error
              ? "Failed to reopen task: {{error}}"
              : "Failed to reopen task.",
          error: error instanceof Error ? error.message : undefined,
        }),
      );
    } finally {
      setMutating(false);
    }
  };

  const activeCount = threads.filter((t) => t.status === "active").length;
  const doneCount = threads.filter((t) => t.status === "done").length;

  // Full-pane detail state — clicking a card swaps the list for its detail.
  if (selectedThreadId && selectedThreadSummary) {
    return (
      <div
        className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto bg-bg px-4 pb-28 pt-4 text-txt"
        data-testid="task-coordinator-panel"
      >
        {detailError ? (
          <div className="text-xs text-danger">
            {t("codingagenttaskspanel.loadTaskDetailFailed", {
              defaultValue: "Failed to load task detail: {{error}}",
              error: detailError,
            })}
          </div>
        ) : null}
        {mutationError ? (
          <div className="text-xs text-danger">{mutationError}</div>
        ) : null}
        <ThreadDetailPane
          thread={selectedThreadSummary}
          detail={selectedThread}
          detailLoading={loading}
          busy={mutating}
          onBack={() => setSelectedThreadId(null)}
          onDelete={handleDelete}
          onReopen={handleReopen}
          t={t}
          locale={uiLanguage}
        />
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto bg-bg px-4 pb-28 pt-4 text-txt"
      data-testid="task-coordinator-panel"
    >
      {fullPage ? (
        // The shell `ViewHeader` (icon-only back + centered "Tasks") owns this
        // view's top bar, so the panel drops its own title/back row to avoid a
        // second heading (#13565). The counts survive as a lightweight,
        // left-aligned meta strip that mirrors the SectionNav secondary-row
        // geometry beneath the uniform header.
        threads.length > 0 ? (
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1"
            data-testid="task-count-strip"
          >
            <TaskCountChip value={threads.length} label="total" />
            {activeCount > 0 ? (
              <TaskCountChip value={activeCount} label="active" tone="active" />
            ) : null}
            {doneCount > 0 ? (
              <TaskCountChip value={doneCount} label="done" tone="accent" />
            ) : null}
          </div>
        ) : null
      ) : (
        <TaskListHeader
          icon={<ListChecks className="h-5 w-5" />}
          title={t("taskseventspanel.Tasks", { defaultValue: "Coding Tasks" })}
          counts={
            threads.length > 0 ? (
              <>
                <TaskCountChip value={threads.length} label="total" />
                {activeCount > 0 ? (
                  <TaskCountChip
                    value={activeCount}
                    label="active"
                    tone="active"
                  />
                ) : null}
                {doneCount > 0 ? (
                  <TaskCountChip value={doneCount} label="done" tone="accent" />
                ) : null}
              </>
            ) : null
          }
        />
      )}

      {threads.length > 0 || loading ? (
        <div className="flex items-center gap-2">
          <TaskSearchInput
            value={search}
            onChange={setSearch}
            placeholder={searchLabel}
            inputRef={searchRef}
            agentProps={searchAgentProps}
          />
          <Button
            unstyled
            ref={archivedRef}
            type="button"
            onClick={() => setShowArchived((value) => !value)}
            aria-pressed={showArchived}
            data-testid="task-show-archived"
            className={`inline-flex h-9 min-h-11 items-center gap-2 rounded-xl border px-3 text-xs font-medium transition-colors ${
              showArchived
                ? "border-accent/40 bg-accent-subtle text-accent"
                : "border-border/50 bg-bg-accent/30 text-muted hover:text-txt"
            }`}
            {...archivedAgentProps}
          >
            <Archive className="h-3.5 w-3.5" />
            {showArchivedLabel}
          </Button>
        </div>
      ) : null}

      {loadError ? (
        <div className="text-xs text-danger">
          {t("codingagenttaskspanel.loadThreadsFailed", {
            defaultValue: "Failed to load task threads: {{error}}",
            error: loadError,
          })}
        </div>
      ) : null}
      {mutationError ? (
        <div className="text-xs text-danger">{mutationError}</div>
      ) : null}

      {threads.length > 0 ? (
        <>
          <div className="flex flex-col gap-2.5">
            {threads.map((thread) => (
              <TaskCard
                key={thread.id}
                id={thread.id}
                title={thread.title}
                subtitle={thread.summary || thread.originalRequest}
                status={thread.status}
                chips={threadChips(thread, t, uiLanguage)}
                onOpen={setSelectedThreadId}
                t={t}
              />
            ))}
          </div>
          {threads.length < 4 ? <SparseWatermark icon={ListChecks} /> : null}
        </>
      ) : loading ? (
        <div className="text-sm text-muted">
          {t("codingagenttaskspanel.loadingTasks", {
            defaultValue: "Loading",
          })}
        </div>
      ) : (
        <ChatEmptyStateWithRecommendations
          icon={Bot}
          testId="task-empty-state"
          title={
            backendAbsent
              ? t("codingagenttaskspanel.empty.setupTitle", {
                  defaultValue: "Coding agents aren't set up here yet.",
                })
              : t("codingagenttaskspanel.empty.title", {
                  defaultValue: "No coding tasks yet.",
                })
          }
          // Full-page Tasks is a designed-empty surface (#13565): no
          // suggestion/create CTAs here — the proactive-greeting child offers
          // to start a task in chat, so the empty state stays a quiet glyph +
          // one line. The embedded (non-fullPage) panel keeps its recommendation
          // chips for the spatial/coordinator surfaces that have no chat rail.
          recommendations={
            fullPage
              ? undefined
              : [
                  t("codingagenttaskspanel.empty.rec.fixBug", {
                    defaultValue: "Dispatch a coding agent to fix a failing test",
                  }),
                  t("codingagenttaskspanel.empty.rec.addFeature", {
                    defaultValue: "Have a coding agent add a small feature",
                  }),
                  backendAbsent
                    ? t("codingagenttaskspanel.empty.rec.setup", {
                        defaultValue: "Help me set up coding agents",
                      })
                    : t("codingagenttaskspanel.empty.rec.refactor", {
                        defaultValue: "Ask a coding agent to refactor a file",
                      }),
                ]
          }
        />
      )}
    </div>
  );
}
