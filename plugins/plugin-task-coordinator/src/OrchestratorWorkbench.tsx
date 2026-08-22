/**
 * Coordinates the live orchestrator task list, timeline, and extracted detail panels.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { client } from "@elizaos/ui/api";
import type { CodingAgentTaskThreadDetail } from "@elizaos/ui/api/client-types-cloud";
import { Button } from "@elizaos/ui/components/ui/button";
import { useAppSelectorShallow } from "@elizaos/ui/state";
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  CircleStop,
  Layers,
  PanelRightOpen,
  Pause,
} from "lucide-react";
import {
  type CSSProperties,
  type UIEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { OrchestratorAccountHealthPanel } from "./OrchestratorAccountHealthPanel";
import {
  blockMatchesSelection,
  blockSelection,
  blockSelectionKey,
  blockTitle,
  type DetailDrawerSelection,
  OperatorDetailDrawer,
} from "./orchestrator-operator-detail";
import {
  type ConversationBlock,
  ConversationBlockView,
} from "./orchestrator-stream";
import { buildConversation } from "./orchestrator-stream.helpers";
import { TaskInspector, WorkbenchHeader } from "./orchestrator-task-inspector";
import {
  fallbackTranslate,
  resolveSenderName,
  type StatusFilter,
  StatusGlyph,
  type Translate,
} from "./orchestrator-workbench-glyphs";
import {
  FilterSelect,
  orchestratorTaskChips,
} from "./orchestrator-workbench-list";
import {
  BackChip,
  SparseWatermark,
  TaskCard,
  TaskEmptyState,
  TaskSearchInput,
} from "./TaskCardList";
import { useOrchestratorData } from "./use-orchestrator-data";

export { TaskInspector, WorkbenchHeader } from "./orchestrator-task-inspector";

function readInitialTaskId(): string | null {
  if (typeof window === "undefined") return null;
  // Accept both producers: `?task=` (copy-link) and `?taskId=` (the in-chat
  // task widget). Either opens the workbench straight onto that task.
  const params = new URLSearchParams(window.location.search);
  return params.get("task") ?? params.get("taskId");
}

const MOBILE_QUERY = "(max-width: 767px)";

// The view bundle ships no CSS — it borrows the host stylesheet, which never
// generates the plugin's responsive (`md:`) variants. So responsiveness is
// driven in JS via matchMedia and applied with always-present classes + inline
// styles instead of breakpoint utilities.
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

// Mobile inspector slide-over geometry. Inline styles (not `md:` utilities)
// because the bundle has no CSS of its own — see useIsMobile.
export const INSPECTOR_DRAWER_STYLE: CSSProperties = {
  position: "absolute",
  insetBlock: 0,
  right: 0,
  zIndex: 30,
  width: "86%",
  maxWidth: "22rem",
  boxShadow: "0 10px 30px rgba(0, 0, 0, 0.45)",
};

export const HIDDEN_STYLE: CSSProperties = { display: "none" };

// Timeline header above the message stream. Desktop packs it into one row;
// mobile splits into a title row (back · status · title · details) and a
// secondary controls row (status badge · system-events toggle) so the task
// title is never crushed by the trailing controls.
function TimelineHeader({
  detail,
  isMobile,
  onBack,
  onOpenInspector,
  t,
}: {
  detail: CodingAgentTaskThreadDetail;
  isMobile: boolean;
  onBack: () => void;
  onOpenInspector: () => void;
  t: Translate;
}) {
  const statusDot = (
    <StatusGlyph
      status={detail.status}
      paused={detail.paused}
      t={t}
      size="h-4 w-4"
    />
  );
  const title = (
    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-txt">
      {detail.title}
    </span>
  );
  const pausedLabel = t("orchestrator.status.paused", {
    defaultValue: "Paused",
  });
  const pausedBadge = detail.paused ? (
    <span
      className="inline-flex shrink-0 text-warn"
      title={pausedLabel}
      aria-label={pausedLabel}
      role="img"
    >
      <Pause className="h-3.5 w-3.5" aria-hidden />
    </span>
  ) : null;
  const detailsLabel = t("orchestrator.action.details", {
    defaultValue: "Details",
  });
  const backLabel = t("orchestrator.action.backToList", {
    defaultValue: "Back to tasks",
  });
  const { ref: backRef, agentProps: backAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "timeline-back",
      role: "button",
      label: backLabel,
      group: "orchestrator-timeline",
      description: "Go back to the task list",
    });
  const { ref: detailsRef, agentProps: detailsAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "timeline-open-inspector",
      role: "button",
      label: detailsLabel,
      group: "orchestrator-timeline",
      description: "Open the task details panel",
    });

  if (isMobile) {
    return (
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <Button
            unstyled
            ref={backRef}
            type="button"
            onClick={onBack}
            className="-ml-1 shrink-0 p-1 text-muted transition-colors hover:text-txt"
            aria-label={backLabel}
            data-testid="orchestrator-back"
            {...backAgentProps}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          {statusDot}
          {title}
          <Button
            unstyled
            ref={detailsRef}
            type="button"
            onClick={onOpenInspector}
            className="shrink-0 p-1 text-muted transition-colors hover:text-txt"
            aria-label={detailsLabel}
            title={detailsLabel}
            data-testid="orchestrator-open-inspector"
            {...detailsAgentProps}
          >
            <PanelRightOpen className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        {pausedBadge ? (
          <div className="mt-1.5 flex items-center gap-1.5">{pausedBadge}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5">
      <BackChip label={backLabel} onClick={onBack} testId="orchestrator-back" />
      {statusDot}
      {title}
      {pausedBadge}
      <Button
        unstyled
        ref={detailsRef}
        type="button"
        onClick={onOpenInspector}
        className="shrink-0 p-1 text-muted transition-colors hover:text-txt"
        aria-label={detailsLabel}
        title={detailsLabel}
        data-testid="orchestrator-open-inspector"
        {...detailsAgentProps}
      >
        <PanelRightOpen className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

function TimelineInspectButton({
  block,
  label,
  onInspect,
}: {
  block: ConversationBlock;
  label: string;
  onInspect: (block: ConversationBlock) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `timeline-inspect-${block.key}`,
    role: "button",
    label,
    group: "orchestrator-timeline",
    description: "Inspect this timeline entry in the operator detail panel",
    onActivate: () => onInspect(block),
  });
  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      onClick={() => onInspect(block)}
      className="mt-1.5 flex h-6 w-6 shrink-0 items-center justify-center text-muted opacity-0 transition-colors hover:text-txt focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      aria-label={label}
      title={label}
      data-testid="orchestrator-inspect-block"
      {...agentProps}
    >
      <PanelRightOpen className="h-3.5 w-3.5" />
    </Button>
  );
}

function InspectorBackdrop({
  label,
  onClose,
}: {
  label: string;
  onClose: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "inspector-backdrop-close",
    role: "button",
    label,
    group: "orchestrator-inspector",
    description: "Close the mobile task or operator detail panel",
    onActivate: onClose,
  });
  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      aria-label={label}
      onClick={onClose}
      className="absolute inset-0 z-20 bg-black/40"
      data-testid="orchestrator-inspector-backdrop"
      {...agentProps}
    />
  );
}

function TimelineLoadOlderButton({
  label,
  onLoad,
}: {
  label: string;
  onLoad: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "timeline-load-older",
    role: "button",
    label,
    group: "orchestrator-timeline",
    description: "Load older entries in the task timeline",
  });
  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      onClick={onLoad}
      className="flex items-center gap-1 px-1 py-0.5 text-2xs text-muted transition-colors hover:text-txt"
      data-testid="orchestrator-load-older"
      aria-label={label}
      {...agentProps}
    >
      <ArrowDownToLine className="h-3 w-3" />
      {label}
    </Button>
  );
}

export function OrchestratorWorkbench() {
  const {
    t: appT,
    uiLanguage,
    copyToClipboard,
    agentStatus,
    setTab,
  } = useAppSelectorShallow((s) => ({
    t: s.t,
    uiLanguage: s.uiLanguage,
    copyToClipboard: s.copyToClipboard,
    agentStatus: s.agentStatus,
    setTab: s.setTab,
  }));
  const t = appT ?? fallbackTranslate;
  const locale = typeof uiLanguage === "string" ? uiLanguage : undefined;
  const mainAgentName =
    typeof agentStatus?.agentName === "string"
      ? agentStatus.agentName
      : undefined;

  const [selectedId, setSelectedId] = useState<string | null>(
    readInitialTaskId,
  );
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [detailDrawer, setDetailDrawer] =
    useState<DetailDrawerSelection | null>(null);

  const isMobile = useIsMobile();
  const deferredSearch = useDeferredValue(search.trim());
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;

  // The live-data layer (status/tasks/detail/timeline + fetch / poll / SSE /
  // mutation) lives in useOrchestratorData; this component owns the UI state
  // (selection, filters, drawers) and feeds it in.
  const {
    status,
    tasks,
    detail,
    messages,
    events,
    timelineCursor,
    loading,
    mutating,
    loadError,
    backendAbsent,
    actionError,
    runMutation,
    loadOlderTimeline,
  } = useOrchestratorData({
    selectedId,
    showArchived,
    statusFilter,
    deferredSearch,
    t,
  });

  // The conversation sticks to the newest entry, but only while the reader is
  // already near the bottom — scrolling up to read history is never yanked by
  // a streaming update.
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const handleListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Reset transient per-task UI (mobile inspector drawer, add-agent form, the
  // detail drawer) and re-pin to bottom whenever the selection changes, so a
  // freshly opened task starts clean. The room itself is loaded by the data
  // layer (useOrchestratorData) reacting to the same selectedId.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on selection change
  useEffect(() => {
    setInspectorOpen(false);
    setAddAgentOpen(false);
    setDetailDrawer(null);
    stickToBottomRef.current = true;
  }, [selectedId]);

  // Stop every still-running coding agent on the open task — the prominent
  // in-conversation interrupt (parity with Claude Code / Codex / opencode),
  // also bound to Esc below.
  const handleStopActive = useCallback(() => {
    const current = detail;
    if (!current) return;
    const targets = current.sessions.filter(
      (session) =>
        session.sessionId &&
        session.stoppedAt == null &&
        session.status !== "completed",
    );
    if (targets.length === 0) return;
    void runMutation(async () => {
      for (const session of targets) {
        await client.stopOrchestratorAgent(current.id, session.sessionId);
      }
    });
  }, [detail, runMutation]);

  // Esc closes an open modal/drawer first; only when nothing is open does it
  // interrupt the running turn. A ref keeps the document listener stable while
  // always seeing the latest state (otherwise Esc-to-stop would trap an open
  // dialog, blocking the whole UI).
  const escStateRef = useRef({
    addAgentOpen,
    inspectorOpen,
    detailDrawer,
    stop: handleStopActive,
  });
  escStateRef.current = {
    addAgentOpen,
    inspectorOpen,
    detailDrawer,
    stop: handleStopActive,
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const s = escStateRef.current;
      if (s.addAgentOpen) {
        setAddAgentOpen(false);
        return;
      }
      if (s.inspectorOpen) {
        setInspectorOpen(false);
        return;
      }
      if (s.detailDrawer) {
        setDetailDrawer(null);
        return;
      }
      s.stop();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const handleCopyLink = useCallback(() => {
    const current = selectedIdRef.current;
    if (!current || !copyToClipboard || typeof window === "undefined") return;
    const url = `${window.location.origin}/orchestrator?task=${encodeURIComponent(current)}`;
    void copyToClipboard(url);
  }, [copyToClipboard]);

  const sessionLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of detail?.sessions ?? []) {
      const label = session.label?.trim();
      if (session.sessionId && label) map.set(session.sessionId, label);
    }
    return map;
  }, [detail?.sessions]);

  const finishedSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of detail?.sessions ?? []) {
      if (
        session.sessionId &&
        (session.stoppedAt != null || session.status === "completed")
      ) {
        ids.add(session.sessionId);
      }
    }
    return ids;
  }, [detail?.sessions]);

  const conversation = useMemo(
    () =>
      buildConversation(
        messages,
        events,
        (message) =>
          resolveSenderName(message, sessionLabelById, mainAgentName, t),
        finishedSessionIds,
      ),
    [messages, events, sessionLabelById, mainAgentName, finishedSessionIds, t],
  );
  const selectedBlock = useMemo(() => {
    if (detailDrawer?.kind !== "block") return null;
    return (
      conversation.find((block) =>
        blockMatchesSelection(block, detailDrawer),
      ) ?? null
    );
  }, [conversation, detailDrawer]);
  const selectedSession = useMemo(() => {
    if (detailDrawer?.kind !== "session" || !detail) return null;
    return (
      detail.sessions.find(
        (session) => session.sessionId === detailDrawer.sessionId,
      ) ?? null
    );
  }, [detail, detailDrawer]);
  const selectedBlockEvents = useMemo(() => {
    if (!detailDrawer) return [];
    if (detailDrawer.kind === "session") {
      return events.filter(
        (event) => event.sessionId === detailDrawer.sessionId,
      );
    }
    const ids = new Set(detailDrawer.eventIds);
    return events.filter((event) => ids.has(event.id));
  }, [detailDrawer, events]);
  const selectedBlockMessages = useMemo(() => {
    if (!detailDrawer) return [];
    if (detailDrawer.kind === "session") {
      return messages.filter(
        (message) => message.sessionId === detailDrawer.sessionId,
      );
    }
    const ids = new Set(detailDrawer.messageIds);
    return messages.filter((message) => ids.has(message.id));
  }, [detailDrawer, messages]);
  const handleSelectBlock = useCallback(
    (block: ConversationBlock) => {
      setDetailDrawer(blockSelection(block));
      if (isMobile) setInspectorOpen(true);
    },
    [isMobile],
  );
  const handleInspectSession = useCallback(
    (sessionId: string) => {
      setDetailDrawer({ kind: "session", sessionId });
      if (isMobile) setInspectorOpen(true);
    },
    [isMobile],
  );

  // Re-pin to the newest entry whenever the conversation grows (subject to the
  // near-bottom guard); `conversation` is the change trigger, not read here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [conversation]);

  const viewState = JSON.stringify({
    selectedId,
    taskCount: status?.taskCount ?? tasks.length,
    activeTaskCount: status?.activeTaskCount ?? 0,
    statusFilter,
    showArchived,
  });

  const searchLabel = t("orchestrator.searchPlaceholder", {
    defaultValue: "Search tasks",
  });
  const showArchivedLabel = t("orchestrator.showArchived", {
    defaultValue: "Show archived",
  });
  const loadOlderLabel = t("orchestrator.loadOlder", {
    defaultValue: "Load older",
  });
  const stopLabel = t("orchestrator.action.stop", { defaultValue: "Stop" });
  const { ref: searchRef, agentProps: searchAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "rail-search",
      role: "text-input",
      label: searchLabel,
      group: "orchestrator-rail",
      description: "Filter the task list by title or request text",
      getValue: () => search,
      onFill: (value) => setSearch(value),
    });
  const { ref: showArchivedRef, agentProps: showArchivedAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "rail-show-archived",
      role: "toggle",
      label: showArchivedLabel,
      group: "orchestrator-rail",
      status: showArchived ? "active" : "inactive",
      description: "Toggle showing archived tasks in the list",
      onActivate: () => setShowArchived((value) => !value),
    });
  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col bg-bg text-txt"
      data-testid="orchestrator-workbench"
    >
      <span data-view-state={viewState} hidden />
      <WorkbenchHeader
        status={status}
        busy={mutating}
        isMobile={isMobile}
        onPauseAll={() => runMutation(() => client.pauseAllOrchestratorTasks())}
        onResumeAll={() =>
          runMutation(() => client.resumeAllOrchestratorTasks())
        }
        accountsOpen={accountsOpen}
        onToggleAccounts={() => setAccountsOpen((prev) => !prev)}
        t={t}
        locale={locale}
      />

      {accountsOpen ? (
        <div className="border-b border-border/40 px-4 py-2">
          <OrchestratorAccountHealthPanel
            t={t}
            onConnect={() => setTab?.("settings")}
          />
        </div>
      ) : null}

      {backendAbsent ? (
        <div className="px-4 py-1.5 text-2xs text-muted">
          {t("orchestrator.backendAbsent", {
            defaultValue: "Connect a cloud or desktop agent to run tasks.",
          })}
        </div>
      ) : null}
      {loadError ? (
        <div className="bg-danger/10 px-3 py-1.5 text-xs text-danger">
          {loadError}
        </div>
      ) : null}
      {actionError ? (
        <div className="bg-danger/10 px-3 py-1.5 text-xs text-danger">
          {actionError}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Single-pane landing: visual task card list. Hidden once a task room
            is open so the workbench is never a side-by-side list+detail. */}
        {!selectedId ? (
          <div
            className="relative flex flex-1 flex-col gap-3 px-4 pb-28 pt-4"
            data-testid="orchestrator-rail"
          >
            {tasks.length > 0 || loading ? (
              <div className="flex flex-wrap items-center gap-2">
                <TaskSearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder={searchLabel}
                  inputRef={searchRef}
                  testId="orchestrator-search"
                  className="min-w-[12rem] flex-1"
                  agentProps={searchAgentProps}
                />
                <div className="flex items-center gap-2">
                  <div className="w-40">
                    <FilterSelect
                      status={status}
                      active={statusFilter}
                      onSelect={setStatusFilter}
                      t={t}
                    />
                  </div>
                  <Button
                    unstyled
                    ref={showArchivedRef}
                    type="button"
                    onClick={() => setShowArchived((value) => !value)}
                    aria-pressed={showArchived}
                    className={`inline-flex h-9 items-center gap-2 px-2 text-xs font-medium transition-colors ${
                      showArchived ? "text-accent" : "text-muted hover:text-txt"
                    }`}
                    data-testid="orchestrator-show-archived"
                    {...showArchivedAgentProps}
                  >
                    <Archive className="h-3.5 w-3.5" />
                    {showArchivedLabel}
                  </Button>
                </div>
              </div>
            ) : null}

            {tasks.length === 0 ? (
              loading ? (
                <p className="p-2 text-sm text-muted">
                  {t("orchestrator.loadingTasks", {
                    defaultValue: "Loading",
                  })}
                </p>
              ) : (
                <TaskEmptyState
                  title={
                    backendAbsent
                      ? t("orchestrator.empty.setupTitle", {
                          defaultValue:
                            "Connect a cloud or desktop agent to run tasks here.",
                        })
                      : t("orchestrator.empty.title", {
                          defaultValue: "No tasks yet.",
                        })
                  }
                  hint={t("orchestrator.empty.hint", {
                    defaultValue: "Tasks you start appear here.",
                  })}
                />
              )
            ) : (
              <>
                <div className="flex flex-col gap-2.5">
                  {tasks.map((thread) => (
                    <TaskCard
                      key={thread.id}
                      id={thread.id}
                      title={thread.title}
                      subtitle={thread.summary || thread.originalRequest}
                      status={thread.status}
                      chips={orchestratorTaskChips(thread, t, locale)}
                      onOpen={(id) => setSelectedId(id)}
                      t={t}
                    />
                  ))}
                </div>
                {tasks.length < 4 ? <SparseWatermark icon={Layers} /> : null}
              </>
            )}
          </div>
        ) : null}

        {/* Task room — full-pane detail, entered by clicking a card. */}
        <main
          className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg"
          data-testid="orchestrator-timeline"
          // Keep a real minimum height in the one-column desktop layout: stacked
          // below the (often tall) inspector, a basis-0 flex-1 timeline would
          // otherwise collapse toward zero and bleed its header over the
          // inspector's controls. A definite floor makes the outer container
          // scroll through both panels instead. Inline (the view bundle ships no
          // CSS of its own). Hidden entirely until a task room is open.
          style={selectedId ? { minHeight: "20rem" } : HIDDEN_STYLE}
        >
          {detail ? (
            <>
              <TimelineHeader
                detail={detail}
                isMobile={isMobile}
                onBack={() => setSelectedId(null)}
                onOpenInspector={() => {
                  setDetailDrawer(null);
                  setInspectorOpen(true);
                }}
                t={t}
              />
              <div
                ref={listRef}
                onScroll={handleListScroll}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
                data-testid="orchestrator-message-list"
              >
                {timelineCursor ? (
                  <div className="flex justify-center">
                    <TimelineLoadOlderButton
                      label={loadOlderLabel}
                      onLoad={() => void loadOlderTimeline()}
                    />
                  </div>
                ) : null}
                {conversation.length === 0 ? (
                  <p className="p-4 text-center text-xs text-muted">
                    {t("orchestrator.noMessages", {
                      defaultValue: "No messages yet.",
                    })}
                  </p>
                ) : (
                  conversation.map((block) => {
                    const selected =
                      detailDrawer?.kind === "block" &&
                      blockMatchesSelection(block, detailDrawer);
                    return (
                      <div
                        key={block.key}
                        className={`group flex gap-1.5 transition-colors ${
                          selected ? "text-accent" : "hover:bg-bg-hover/30"
                        }`}
                        data-testid="orchestrator-conversation-block"
                      >
                        <TimelineInspectButton
                          block={block}
                          label={t("orchestrator.action.inspectBlock", {
                            defaultValue: `Inspect ${blockTitle(block, t)}`,
                          })}
                          onInspect={handleSelectBlock}
                        />
                        <div className="min-w-0 flex-1">
                          <ConversationBlockView
                            block={block}
                            locale={locale}
                            onInspect={() => handleSelectBlock(block)}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              {detail.activeSessionCount > 0 ? (
                <div
                  className="flex items-center justify-between gap-2 bg-warn/5 px-3 py-1.5"
                  data-testid="orchestrator-running-bar"
                >
                  <span className="flex items-center gap-1.5 text-2xs font-medium text-warn">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
                    {t("orchestrator.agentsWorking", {
                      defaultValue: "Agent working…",
                    })}
                  </span>
                  <Button
                    unstyled
                    type="button"
                    onClick={handleStopActive}
                    disabled={mutating}
                    className="flex items-center gap-1 px-1 py-0.5 text-2xs text-txt transition-colors hover:text-danger disabled:opacity-50"
                    data-testid="orchestrator-stop-active"
                    aria-label={stopLabel}
                    data-agent-authority="human"
                    data-agent-human-id="timeline-stop-active"
                  >
                    <CircleStop className="h-3 w-3" />
                    {stopLabel}
                    <kbd className="ml-0.5 px-1 text-[0.9em] text-muted">
                      Esc
                    </kbd>
                  </Button>
                </div>
              ) : null}
              <div className="pb-24" />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2.5 px-4 py-2.5">
                <BackChip
                  label={t("orchestrator.action.backToList", {
                    defaultValue: "Tasks",
                  })}
                  onClick={() => setSelectedId(null)}
                  testId="orchestrator-back-loading"
                />
                <span className="text-sm font-medium text-muted">
                  {t("orchestrator.loadingTask", {
                    defaultValue: "Loading task…",
                  })}
                </span>
              </div>
              <div className="flex flex-1 items-center justify-center p-6">
                <p className="text-xs text-muted">
                  {t("orchestrator.loadingTask", {
                    defaultValue: "Loading task…",
                  })}
                </p>
              </div>
            </>
          )}
        </main>

        {/* Inspector — stacked below activity so the registered view stays one-column. */}
        {detail && isMobile && inspectorOpen ? (
          <InspectorBackdrop
            label={t("orchestrator.action.closeDetails", {
              defaultValue: "Close details",
            })}
            onClose={() => {
              setInspectorOpen(false);
              setDetailDrawer(null);
            }}
          />
        ) : null}
        {detail && detailDrawer ? (
          <OperatorDetailDrawer
            key={blockSelectionKey(detailDrawer)}
            selection={detailDrawer}
            block={selectedBlock}
            session={selectedSession}
            events={selectedBlockEvents}
            messages={selectedBlockMessages}
            taskUsage={detail.usage}
            busy={mutating}
            className="flex"
            style={
              isMobile
                ? inspectorOpen
                  ? INSPECTOR_DRAWER_STYLE
                  : HIDDEN_STYLE
                : undefined
            }
            onClose={() => {
              setDetailDrawer(null);
              if (isMobile) setInspectorOpen(false);
            }}
            onRetry={(input) =>
              runMutation(() =>
                client.retryOrchestratorTaskTurn(detail.id, input),
              )
            }
            onRerun={(input) =>
              runMutation(() =>
                client.rerunOrchestratorTaskFromEvent(detail.id, input),
              )
            }
            t={t}
            locale={locale}
          />
        ) : detail ? (
          <TaskInspector
            detail={detail}
            className="flex"
            style={
              isMobile
                ? inspectorOpen
                  ? INSPECTOR_DRAWER_STYLE
                  : HIDDEN_STYLE
                : undefined
            }
            onClose={isMobile ? () => setInspectorOpen(false) : undefined}
            busy={mutating}
            addAgentOpen={addAgentOpen}
            onPause={() =>
              runMutation(() => client.pauseOrchestratorTask(detail.id))
            }
            onResume={() =>
              runMutation(() => client.resumeOrchestratorTask(detail.id))
            }
            onArchive={() =>
              runMutation(async () => {
                await client.archiveCodingAgentTaskThread(detail.id);
                if (!showArchived) setSelectedId(null);
              })
            }
            onReopen={() =>
              runMutation(() => client.reopenCodingAgentTaskThread(detail.id))
            }
            onDelete={() =>
              runMutation(async () => {
                await client.deleteOrchestratorTask(detail.id);
                setSelectedId(null);
              })
            }
            onFork={() =>
              runMutation(async () => {
                const forked = await client.forkOrchestratorTask(detail.id);
                if (forked) setSelectedId(forked.id);
              })
            }
            onRestart={() => {
              const confirmed =
                typeof window === "undefined" ||
                window.confirm(
                  t("orchestrator.confirmRestart", {
                    defaultValue:
                      "Restart this task with a fresh worker? Active agents will be stopped first.",
                  }),
                );
              if (!confirmed) return;
              runMutation(() =>
                client.restartOrchestratorTask(detail.id, { stopActive: true }),
              );
            }}
            onRestartWithEditedPlan={(input) =>
              runMutation(() =>
                client.restartOrchestratorTaskWithEditedPlan(detail.id, input),
              )
            }
            onValidate={(passed) =>
              runMutation(() =>
                client.validateOrchestratorTask(detail.id, {
                  passed,
                  humanOverride: true,
                }),
              )
            }
            onSetPriority={(priority) =>
              runMutation(() =>
                client.updateOrchestratorTask(detail.id, { priority }),
              )
            }
            onToggleAddAgent={() => setAddAgentOpen((prev) => !prev)}
            onAddAgent={(input) =>
              runMutation(async () => {
                await client.addOrchestratorAgent(detail.id, input);
                setAddAgentOpen(false);
              })
            }
            onInspectSession={handleInspectSession}
            onStopAgent={(sessionId) =>
              runMutation(() =>
                client.stopOrchestratorAgent(detail.id, sessionId),
              )
            }
            onCopyLink={handleCopyLink}
            t={t}
            locale={locale}
          />
        ) : null}
      </div>
    </div>
  );
}
