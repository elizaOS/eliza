import type {
  CodingAgentSession,
  CodingAgentTaskThread,
  CodingAgentTaskThreadDetail,
} from "@elizaos/ui/api/client-types-cloud";
import {
  client,
  EmptyWidgetState,
  PULSE_STATUSES,
  STATUS_DOT,
  TERMINAL_STATUSES,
  useApp,
  usePtySessions,
  WidgetSection,
} from "@elizaos/ui";
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
  vars?: Record<string, unknown>,
): string => String(vars?.defaultValue ?? key);

function deriveSessionActivity(
  session: CodingAgentSession,
  t: typeof fallbackTranslate,
): string {
  if (session.status === "tool_running" && session.toolDescription) {
    return t("codingagenttaskspanel.runningTool", {
      defaultValue: "Running {{tool}}",
      tool: session.toolDescription,
    }).slice(0, 60);
  }
  if (session.status === "blocked") {
    return t("codingagenttaskspanel.waitingForInput", {
      defaultValue: "Waiting for input",
    });
  }
  return t("codingagenttaskspanel.running", {
    defaultValue: "Running",
  });
}

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

function formatThreadKind(kind: string, t: typeof fallbackTranslate): string {
  const mapped: Record<string, string> = {
    coding: "codingagenttaskspanel.kind.coding",
  };
  return t(mapped[kind] ?? "codingagenttaskspanel.kind.unknown", {
    defaultValue: kind,
  });
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

function TaskCard({
  session,
  t,
}: {
  session: CodingAgentSession;
  t: typeof fallbackTranslate;
}) {
  const activity = session.lastActivity ?? deriveSessionActivity(session, t);

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
        <p className="mb-1 line-clamp-2 text-xs text-muted">
          {session.originalTask}
        </p>
      ) : null}
      <p
        className={`truncate text-[11px] ${
          session.status === "blocked" ? "text-warn" : "text-muted"
        }`}
      >
        {activity}
      </p>
    </div>
  );
}

function TaskItemsContent({
  sessions,
  t,
}: {
  sessions: CodingAgentSession[];
  t: typeof fallbackTranslate;
}) {
  if (sessions.length === 0) {
    return (
      <EmptyWidgetState
        icon={<Activity className="h-8 w-8" />}
        title={t("codingagenttaskspanel.noWorkRunning", {
          defaultValue: "No orchestrator work running",
        })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sessions.map((session) => (
        <TaskCard key={session.sessionId} session={session} t={t} />
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
    <div className="flex flex-col gap-2">
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
          <div className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
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
              defaultValue: "No sessions recorded.",
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
                        defaultValue: "No workspace",
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
                  <div className="mb-1 text-2xs uppercase tracking-[0.08em] text-muted">
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
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onReopen}
            className="h-7 px-2 text-xs-tight"
          >
            {t("codingagenttaskspanel.reopen", {
              defaultValue: "Reopen",
            })}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={onDelete}
            className="h-7 px-2 text-xs-tight text-danger hover:bg-danger/10"
          >
            {t("codingagenttaskspanel.delete", {
              defaultValue: "Delete",
            })}
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
  t,
  locale,
}: {
  thread: CodingAgentTaskThread;
  selected: boolean;
  onSelect: (threadId: string) => void;
  detail?: CodingAgentTaskThreadDetail | null;
  detailLoading?: boolean;
  busy?: boolean;
  onDelete?: () => void;
  onReopen?: () => void;
  t: typeof fallbackTranslate;
  locale?: string;
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
            {formatThreadStatus(thread.status, t)}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-2xs text-muted">
          <span>{formatThreadKind(thread.kind, t)}</span>
          <span>
            {t("codingagenttaskspanel.sessionsCount", {
              defaultValue: "{{count}} sessions",
              count: thread.sessionCount,
            })}
          </span>
          <span>
            {t("codingagenttaskspanel.decisionsCount", {
              defaultValue: "{{count}} decisions",
              count: thread.decisionCount,
            })}
          </span>
          <span>{formatIsoTime(thread.updatedAt, locale, t)}</span>
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
            <div className="text-xs-tight text-muted">
              {t("common.loading", { defaultValue: "Loading…" })}
            </div>
          ) : detail ? (
            <ThreadDetailContent
              detail={detail}
              busy={busy ?? false}
              onDelete={onDelete ?? (() => {})}
              onReopen={onReopen ?? (() => {})}
              t={t}
              locale={locale}
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
  const uiLanguage =
    typeof app?.uiLanguage === "string" ? app.uiLanguage : undefined;
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

  return (
    <WidgetSection
      title={t("taskseventspanel.Tasks", { defaultValue: "Tasks" })}
      icon={<Activity className="h-4 w-4" />}
      action={
        !fullPage ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setTab("tasks")}
            aria-label={t("taskseventspanel.OpenView", {
              defaultValue: "Open Tasks view",
            })}
          >
            <SquareArrowOutUpRight className="h-3.5 w-3.5" />
          </Button>
        ) : null
      }
      testId="chat-widget-orchestrator"
    >
      <div className="mb-2">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("codingagenttaskspanel.searchPlaceholder", {
            defaultValue: "Search tasks",
          })}
          className="h-8 w-full rounded-md border border-border/50 bg-bg px-2 text-xs text-txt outline-none transition-colors placeholder:text-muted focus:border-accent/50"
        />
      </div>
      {loadError ? (
        <div className="mb-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs text-danger">
          {t("codingagenttaskspanel.loadThreadsFailed", {
            defaultValue: "Failed to load task threads: {{error}}",
            error: loadError,
          })}
        </div>
      ) : null}
      {mutationError ? (
        <div className="mb-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs text-danger">
          {mutationError}
        </div>
      ) : null}
      {threads.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {detailError ? (
            <div className="rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs text-danger">
              {t("codingagenttaskspanel.loadTaskDetailFailed", {
                defaultValue: "Failed to load task detail: {{error}}",
                error: detailError,
              })}
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
                t={t}
                locale={uiLanguage}
              />
            ))}
          </div>
        </div>
      ) : loading ? (
        <div className="text-xs text-muted">
          {t("codingagenttaskspanel.loadingTasks", {
            defaultValue: "Loading tasks…",
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <TaskItemsContent sessions={activeSessions} t={t} />
        </div>
      )}
    </WidgetSection>
  );
}
