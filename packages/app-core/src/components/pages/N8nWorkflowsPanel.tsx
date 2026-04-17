/**
 * N8nWorkflowsPanel — n8n integration embedded in AutomationsView.
 *
 * Renders when filter === "workflows". Contains:
 *   - N8nStatusBanner (always visible in workflows tab)
 *   - Sidebar workflow list (replaces the normal item list)
 *   - Detail pane: workflow detail + scoped chat (option A: vertical split)
 *
 * This component is self-contained — it owns its own fetch state and does NOT
 * use AutomationsViewContext. It is rendered by AutomationsLayout when
 * filter === "workflows".
 */

import { Button, FieldLabel, StatusBadge, Textarea } from "@elizaos/ui";
import {
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Send,
  Square,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api";
import type {
  ConversationMessage,
  N8nMode,
  N8nSidecarStatus,
  N8nStatusResponse,
  N8nWorkflow,
} from "../../api/client-types";
import { useApp } from "../../state";
import { confirmDesktopAction } from "../../utils";

// ---------------------------------------------------------------------------
// System addendum constant
// ---------------------------------------------------------------------------

const AUTOMATIONS_SYSTEM_ADDENDUM =
  "You are in the Automations assistant. When the user asks to automate, " +
  "schedule, trigger, or connect apps, use the n8n workflow actions " +
  "(CREATE_N8N_WORKFLOW, ACTIVATE_N8N_WORKFLOW, DEACTIVATE_N8N_WORKFLOW, " +
  "DELETE_N8N_WORKFLOW, GET_N8N_EXECUTIONS). Confirm workflow drafts with the " +
  "user before deploying.";

// Action keywords used to detect workflow mutations in assistant replies.
const WORKFLOW_ACTION_KEYWORDS =
  /CREATE_N8N_WORKFLOW|ACTIVATE_N8N_WORKFLOW|DEACTIVATE_N8N_WORKFLOW|DELETE_N8N_WORKFLOW|workflow.*(created|deployed|activated|deactivated|deleted)/i;

// Stable conversation title — same value the reference implementation uses.
const AUTOMATIONS_CONVERSATION_TITLE = "__automations-scope__";

// Module-level cache so re-mounting the tab doesn't re-resolve the conversation.
// M5: guard against concurrent resolves with an in-flight promise.
let _cachedConvId: string | null = null;
let _inflight: Promise<string> | null = null;

async function resolveAutomationsConversation(): Promise<string> {
  if (_cachedConvId) return _cachedConvId;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const { conversations } = await client.listConversations();
      const existing = conversations.find(
        (c) => c.title === AUTOMATIONS_CONVERSATION_TITLE,
      );
      if (existing) {
        _cachedConvId = existing.id;
        return existing.id;
      }
    } catch {
      /* fall through to create */
    }
    const { conversation } = await client.createConversation(
      AUTOMATIONS_CONVERSATION_TITLE,
    );
    _cachedConvId = conversation.id;
    return conversation.id;
  })().finally(() => {
    _inflight = null;
  });
  return _inflight;
}

// ---------------------------------------------------------------------------
// N8nStatusBanner
// ---------------------------------------------------------------------------

interface N8nStatusBannerProps {
  status: N8nStatusResponse | null;
  loading: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  dismissed: boolean;
}

function N8nStatusBanner({
  status,
  loading,
  onRetry,
  onDismiss,
  dismissed,
}: N8nStatusBannerProps) {
  const { t, setTab } = useApp();

  if (dismissed || loading || !status) return null;

  const mode: N8nMode = status.mode;
  const sidecarStatus: N8nSidecarStatus = status.status;

  let dot: "green" | "amber" | "red" | "muted" = "muted";
  let text = "";
  let showRetry = false;
  let showSettings = false;

  if (mode === "cloud") {
    dot = "green";
    text = t("automations.n8n.bannerCloud");
  } else if (mode === "local" && sidecarStatus === "ready") {
    dot = "green";
    text = t("automations.n8n.bannerLocalReady");
  } else if (mode === "local" && sidecarStatus === "starting") {
    dot = "amber";
    text = t("automations.n8n.bannerLocalStarting");
  } else if (mode === "local" && sidecarStatus === "error") {
    dot = "red";
    text = t("automations.n8n.bannerLocalError");
    showRetry = true;
  } else if (mode === "disabled") {
    dot = "muted";
    text = t("automations.n8n.bannerDisabled");
    showSettings = true;
  } else {
    // local + stopped — normal before sidecar is requested
    dot = "amber";
    text = t("automations.n8n.bannerLocalStarting");
  }

  const dotClass =
    dot === "green"
      ? "bg-ok"
      : dot === "amber"
        ? "bg-warning animate-pulse"
        : dot === "red"
          ? "bg-danger"
          : "bg-muted/40";

  const bannerClass =
    dot === "red"
      ? "border-danger/20 bg-danger/5"
      : dot === "green"
        ? "border-ok/20 bg-ok/5"
        : "border-border/30 bg-bg/30";

  return (
    // M6: role="status" so screen readers announce mode transitions
    <div
      role="status"
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs mb-3 ${bannerClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotClass}`} />
      <span className="flex-1 text-txt">{text}</span>
      {showRetry && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-danger underline hover:no-underline h-auto w-auto p-0 text-xs"
          onClick={onRetry}
        >
          {t("automations.n8n.bannerRetry")}
        </Button>
      )}
      {showSettings && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-accent underline hover:no-underline h-auto w-auto p-0 text-xs"
          onClick={() => {
            // B6: use real nav API — setTab from useApp()
            setTab("settings");
          }}
        >
          {t("automations.n8n.settingsLink")}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("automations.n8n.bannerDismiss")}
        onClick={onDismiss}
        className="text-muted hover:text-txt h-5 w-5"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scoped Chat Pane
// ---------------------------------------------------------------------------

interface AutomationsChatPaneProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onWorkflowMutated: () => void;
}

function AutomationsChatPane({
  collapsed,
  onToggleCollapse,
  composerRef,
  onWorkflowMutated,
}: AutomationsChatPaneProps) {
  const { t } = useApp();

  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [firstTokenReceived, setFirstTokenReceived] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Remove unsafe cast — composerRef is already the right type
  const textareaRef = composerRef;

  // Resolve scoped conversation on mount. M4: reset cache on 404.
  useEffect(() => {
    let cancelled = false;
    void resolveAutomationsConversation().then(async (id) => {
      if (cancelled) return;
      setConvId(id);
      try {
        const { messages: msgs } = await client.getConversationMessages(id);
        if (!cancelled) setMessages(msgs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (
          msg.toLowerCase().includes("not found") ||
          msg.includes("404") ||
          (err as { status?: number }).status === 404
        ) {
          // M4: invalidate cache and re-resolve
          _cachedConvId = null;
          if (!cancelled) {
            void resolveAutomationsConversation().then((newId) => {
              if (!cancelled) setConvId(newId);
            });
          }
        }
      }
    });
    return () => {
      cancelled = true;
      // M1: abort in-flight stream on unmount
      abortRef.current?.abort();
    };
  }, []);

  // Auto-scroll to bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll fires on any message/send change
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: dist < 150 ? "auto" : "smooth",
    });
  }, [messages, sending]);

  // Auto-resize textarea.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (!input) {
      ta.style.height = "38px";
      ta.style.overflowY = "hidden";
      return;
    }
    ta.style.height = "auto";
    ta.style.overflowY = "hidden";
    const h = Math.min(ta.scrollHeight, 150);
    ta.style.height = `${h}px`;
    ta.style.overflowY = ta.scrollHeight > 150 ? "auto" : "hidden";
  }, [input, textareaRef]);

  const handleSend = useCallback(async () => {
    const raw = input.trim();
    if (!raw || !convId || sending) return;

    const now = Date.now();
    const userMsgId = `auto-u-${now}`;
    const assistantMsgId = `auto-a-${now}`;

    // B5: Only prepend system addendum on first turn (messages.length === 0).
    // systemAddendum field not yet present in backend streaming endpoint — keep prepend gate.
    const isFirstTurn = messages.length === 0;
    const textToSend = isFirstTurn
      ? `[SYSTEM]${AUTOMATIONS_SYSTEM_ADDENDUM}[/SYSTEM]\n\n${raw}`
      : raw;

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", text: raw, timestamp: now },
      { id: assistantMsgId, role: "assistant", text: "", timestamp: now },
    ]);
    setInput("");
    setSending(true);
    setFirstTokenReceived(false);

    const controller = new AbortController();
    abortRef.current = controller;
    let streamed = "";
    let finalText = "";

    try {
      const data = await client.sendConversationMessageStream(
        convId,
        textToSend,
        (token) => {
          if (!token) return;
          const delta = token.slice(streamed.length);
          if (!delta) return;
          streamed += delta;
          setFirstTokenReceived(true);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, text: m.text + delta } : m,
            ),
          );
        },
        "DM",
        controller.signal,
      );

      finalText = data.text ?? streamed;
      if (data.text && data.text !== streamed) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, text: data.text } : m,
          ),
        );
      }

      // M3: Only trigger workflow refresh if reply mentions workflow actions.
      if (WORKFLOW_ACTION_KEYWORDS.test(finalText)) {
        onWorkflowMutated();
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, text: t("automations.chat.errorGeneric") }
            : m,
        ),
      );
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [input, convId, sending, messages.length, onWorkflowMutated, t]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (sending) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const visibleMsgs = useMemo(
    () =>
      messages.filter(
        (m) =>
          !(
            sending &&
            !firstTokenReceived &&
            m.role === "assistant" &&
            !m.text.trim()
          ),
      ),
    [messages, sending, firstTokenReceived],
  );

  const label = t("automations.chat.assistantLabel");

  if (collapsed) {
    return (
      <div className="border border-border/40 bg-card/60 rounded-xl overflow-hidden">
        <Button
          type="button"
          variant="ghost"
          className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-bg/50 transition-colors text-left h-auto justify-start"
          onClick={onToggleCollapse}
          aria-label={t("automations.chat.expand")}
        >
          <Zap className="w-3.5 h-3.5 text-accent shrink-0" />
          <span className="text-xs font-semibold text-txt-strong flex-1">
            {label}
          </span>
          <ChevronDown className="w-3.5 h-3.5 text-muted" />
        </Button>
      </div>
    );
  }

  return (
    <section
      className="flex flex-col border border-border/40 bg-card/60 rounded-xl overflow-hidden"
      style={{ minHeight: 0 }}
      aria-label={label}
    >
      <Button
        type="button"
        variant="ghost"
        className="w-full flex items-center gap-2 px-4 py-2.5 border-b border-border/30 hover:bg-bg/50 transition-colors text-left h-auto justify-start"
        onClick={onToggleCollapse}
        aria-label={t("automations.chat.collapse")}
      >
        <Zap className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-semibold text-txt-strong flex-1">
          {label}
        </span>
        <ChevronUp className="w-3.5 h-3.5 text-muted" />
      </Button>

      {/* M6: role="log" + aria-live for screen reader announcements of streamed tokens */}
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-atomic="false"
        className="flex-1 overflow-y-auto px-3 py-2 flex flex-col"
        style={{ maxHeight: "240px", minHeight: "80px" }}
      >
        {visibleMsgs.length === 0 && !sending ? (
          <div className="flex-1 flex items-center justify-center text-center px-4 py-5">
            <p className="text-sm text-muted">
              {t("automations.chat.placeholder")}
            </p>
          </div>
        ) : (
          <div className="w-full space-y-1">
            {visibleMsgs.map((msg) => (
              <div
                key={msg.id}
                className={`text-sm leading-relaxed rounded-lg px-3 py-2 ${
                  msg.role === "user"
                    ? "bg-accent/10 text-txt self-end ml-8"
                    : "bg-bg/50 text-txt mr-8"
                }`}
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-0.5">
                  {msg.role === "user"
                    ? t("automations.chat.roleUser")
                    : t("automations.chat.roleAssistant")}
                </div>
                <div className="whitespace-pre-wrap">{msg.text}</div>
              </div>
            ))}
            {sending && !firstTokenReceived && (
              <div className="bg-bg/50 rounded-lg px-3 py-2 mr-8">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-0.5">
                  {t("automations.chat.roleAssistant")}
                </div>
                <div className="flex gap-1 items-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-muted/60 animate-bounce [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-muted/60 animate-bounce [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-muted/60 animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-1.5 items-end border-t border-border/30 px-3 py-2">
        {/* M12: use Textarea primitive; className overrides min-h to match design */}
        <Textarea
          ref={textareaRef}
          variant="default"
          className="flex-1 min-w-0 px-3 py-2 bg-bg/40 border border-border/40 rounded-lg focus:border-accent/40 focus-visible:ring-0 focus:outline-none text-txt text-sm resize-none overflow-y-hidden min-h-[38px] max-h-[150px] placeholder:text-muted/60"
          rows={1}
          aria-label={label}
          placeholder={t("automations.chat.placeholder")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending || !convId}
        />
        {sending ? (
          <Button
            variant="destructive"
            className="h-[38px] shrink-0 px-3 text-sm gap-1.5"
            onClick={handleStop}
            title={t("automations.chat.stop")}
          >
            <Square className="w-3 h-3 fill-current" />
            <span>{t("automations.chat.stop")}</span>
          </Button>
        ) : (
          <Button
            variant="default"
            className="h-[38px] shrink-0 px-4 text-sm gap-1.5"
            onClick={() => void handleSend()}
            disabled={!input.trim() || !convId}
            aria-label={t("automations.chat.send")}
          >
            <Send className="w-4 h-4" />
            <span className="hidden sm:inline">
              {t("automations.chat.send")}
            </span>
          </Button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Workflow sidebar row
// ---------------------------------------------------------------------------

function WorkflowSidebarRow({
  workflow,
  selected,
  onClick,
  onKeyDown,
}: {
  workflow: N8nWorkflow;
  selected: boolean;
  onClick: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useApp();
  const nodeCount = workflow.nodeCount ?? workflow.nodes?.length ?? 0;

  return (
    // M7: aria-pressed for selection toggle
    <button
      type="button"
      onClick={onClick}
      onKeyDown={onKeyDown}
      aria-pressed={selected}
      className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 rounded-lg transition-colors cursor-pointer hover:bg-bg/50 ${
        selected ? "bg-accent/10" : ""
      }`}
    >
      <Workflow className="h-3.5 w-3.5 shrink-0 text-muted/60" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-txt truncate">
          {workflow.name}
        </div>
        {nodeCount > 0 && (
          <div className="text-xs-tight text-muted mt-0.5">
            {t("automations.n8n.nodeCount", { count: nodeCount })}
          </div>
        )}
      </div>
      <StatusBadge
        label={
          workflow.active
            ? t("automations.n8n.workflowActive")
            : t("automations.n8n.workflowInactive")
        }
        variant={workflow.active ? "success" : "muted"}
        withDot
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Workflow detail pane (with embedded chat)
// ---------------------------------------------------------------------------

function WorkflowDetailPane({
  workflow,
  busy,
  onToggleActive,
  onDelete,
  composerRef,
  onWorkflowMutated,
}: {
  workflow: N8nWorkflow | null;
  busy: string | null;
  onToggleActive: (wf: N8nWorkflow) => void;
  onDelete: (wf: N8nWorkflow) => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onWorkflowMutated: () => void;
}) {
  const { t } = useApp();
  const [chatCollapsed, setChatCollapsed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: expand chat when selection changes
  useEffect(() => {
    setChatCollapsed(false);
  }, [workflow?.id]);

  if (!workflow) {
    // No selection: chat fills the pane.
    return (
      <div className="flex flex-col gap-4 p-4 h-full">
        <AutomationsChatPane
          collapsed={false}
          onToggleCollapse={() => {}}
          composerRef={composerRef}
          onWorkflowMutated={onWorkflowMutated}
        />
      </div>
    );
  }

  const nodes = workflow.nodes ?? [];
  const nodeCount = workflow.nodeCount ?? nodes.length;

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto">
      {/* Scoped chat — collapsible above workflow detail */}
      <AutomationsChatPane
        collapsed={chatCollapsed}
        onToggleCollapse={() => setChatCollapsed((v) => !v)}
        composerRef={composerRef}
        onWorkflowMutated={onWorkflowMutated}
      />

      {/* Workflow detail card */}
      <div className="rounded-xl border border-border/40 bg-card/50 p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <FieldLabel variant="kicker">
                <Workflow className="mr-1.5 inline h-3.5 w-3.5" />
                Workflow
              </FieldLabel>
              <StatusBadge
                label={
                  workflow.active
                    ? t("automations.n8n.workflowActive")
                    : t("automations.n8n.workflowInactive")
                }
                variant={workflow.active ? "success" : "muted"}
                withDot
              />
            </div>
            <h2 className="text-2xl font-semibold text-txt">{workflow.name}</h2>
            {workflow.description && (
              <p className="text-sm text-muted mt-1">{workflow.description}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className={`h-8 px-3 text-xs ${
              workflow.active
                ? "border-warning/30 text-warning hover:bg-warning/10"
                : "border-ok/30 text-ok hover:bg-ok/10"
            }`}
            disabled={busy === workflow.id}
            onClick={() => onToggleActive(workflow)}
          >
            {busy === workflow.id
              ? t("automations.n8n.updating")
              : workflow.active
                ? t("automations.n8n.deactivate")
                : t("automations.n8n.activate")}
          </Button>
        </div>
      </div>

      {/* Node list */}
      {nodeCount > 0 && (
        <div className="rounded-xl border border-border/40 bg-card/50 p-4 space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t("automations.n8n.nodeCount", { count: nodeCount })}
          </div>
          <div className="space-y-1">
            {nodes.length > 0
              ? nodes.map((node) => (
                  <div
                    key={node.id}
                    className="text-sm text-txt flex items-center gap-2 py-1 border-b border-border/20 last:border-b-0"
                  >
                    <span className="flex-1">{node.name}</span>
                    <span className="text-xs text-muted font-mono">
                      {node.type.split(".").pop()}
                    </span>
                  </div>
                ))
              : Array.from({ length: nodeCount }, (_, index) => index + 1).map(
                  (nodeNumber) => (
                    <div
                      key={`workflow-node-${nodeNumber}`}
                      className="text-sm text-muted py-1"
                    >
                      Node {nodeNumber}
                    </div>
                  ),
                )}
          </div>
        </div>
      )}

      {/* Danger zone */}
      <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-danger">
          {t("automations.n8n.dangerZone")}
        </div>
        <p className="text-sm text-muted">
          {t("automations.n8n.deleteConfirmMessage")}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="border-danger/40 text-danger hover:bg-danger/10"
          disabled={busy === workflow.id}
          onClick={() => onDelete(workflow)}
        >
          {t("automations.n8n.deleteWorkflow")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export — N8nWorkflowsPanel
// ---------------------------------------------------------------------------

export interface N8nWorkflowsPanelProps {
  /** Forwarded from AutomationsLayout so "New workflow" can focus the composer. */
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function N8nWorkflowsPanel({ composerRef }: N8nWorkflowsPanelProps) {
  const { t } = useApp();

  // ── Status + workflow state ─────────────────────────────────────────────
  const [n8nStatus, setN8nStatus] = useState<N8nStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [workflows, setWorkflows] = useState<N8nWorkflow[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  // M8: error queue instead of single string
  const [errors, setErrors] = useState<{ id: string; message: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const didAutoStart = useRef(false);

  const selectedWorkflow = workflows.find((wf) => wf.id === selectedId) ?? null;

  const pushError = useCallback((message: string) => {
    const id = `err-${Date.now()}-${Math.random()}`;
    setErrors((prev) => {
      const next = [...prev, { id, message }];
      // Cap at 3, drop oldest
      return next.length > 3 ? next.slice(next.length - 3) : next;
    });
  }, []);

  const dismissError = useCallback((id: string) => {
    setErrors((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const s = await client.getN8nStatus();
      setN8nStatus(s);
    } catch (err) {
      pushError(
        t("automations.n8n.errorLoadStatus", {
          message: err instanceof Error ? err.message : "network error",
        }),
      );
    } finally {
      setStatusLoading(false);
    }
  }, [pushError, t]);

  const loadWorkflows = useCallback(async () => {
    setWorkflowsLoading(true);
    try {
      const list = await client.listN8nWorkflows();
      setWorkflows(list);
      // M8: clear errors on successful refresh
      setErrors([]);
      // Minor: rewrite as proper ternary
      setSelectedId((cur) =>
        cur && list.some((wf) => wf.id === cur) ? cur : null,
      );
    } catch (err) {
      pushError(
        t("automations.n8n.errorLoadWorkflows", {
          message: err instanceof Error ? err.message : "network error",
        }),
      );
    } finally {
      setWorkflowsLoading(false);
    }
  }, [pushError, t]);

  // Bootstrap on mount.
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Load workflows once status is known.
  useEffect(() => {
    if (n8nStatus && n8nStatus.mode !== "disabled") {
      void loadWorkflows();
    }
  }, [n8nStatus, loadWorkflows]);

  // B3: Auto-start local sidecar when mode is "local" and status is "stopped".
  useEffect(() => {
    if (didAutoStart.current) return;
    if (!n8nStatus) return;
    if (
      n8nStatus.mode === "local" &&
      n8nStatus.status === "stopped" &&
      n8nStatus.localEnabled !== false &&
      !n8nStatus.cloudConnected
    ) {
      didAutoStart.current = true;
      void client.startN8nSidecar().catch(() => {
        /* ignore — status poll will reflect actual state */
      });
    }
  }, [n8nStatus]);

  // B4: Poll status every 3s while starting; stop once ready/error.
  // M2: Visibility-guarded.
  useEffect(() => {
    if (!n8nStatus || n8nStatus.status !== "starting") return;
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!id) id = setInterval(() => void loadStatus(), 3_000);
    };
    const stop = () => {
      if (id) {
        clearInterval(id);
        id = null;
      }
    };
    if (document.visibilityState === "visible") start();
    const onVis = () =>
      document.visibilityState === "visible" ? start() : stop();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [n8nStatus, loadStatus]);

  // M2: Poll workflows every 10s with visibility guard.
  useEffect(() => {
    if (!n8nStatus || n8nStatus.mode === "disabled") return;
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!id) id = setInterval(() => void loadWorkflows(), 10_000);
    };
    const stop = () => {
      if (id) {
        clearInterval(id);
        id = null;
      }
    };
    if (document.visibilityState === "visible") start();
    const onVis = () =>
      document.visibilityState === "visible" ? start() : stop();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [n8nStatus, loadWorkflows]);

  const handleWorkflowMutated = useCallback(() => {
    if (n8nStatus && n8nStatus.mode !== "disabled") {
      void loadWorkflows();
    }
  }, [n8nStatus, loadWorkflows]);

  const handleRefresh = useCallback(() => {
    void loadStatus();
    void loadWorkflows();
  }, [loadStatus, loadWorkflows]);

  const handleRetry = useCallback(() => {
    void client.startN8nSidecar().catch(() => {});
    void loadStatus();
  }, [loadStatus]);

  const handleToggleActive = useCallback(
    async (wf: N8nWorkflow) => {
      setBusy(wf.id);
      try {
        if (wf.active) {
          await client.deactivateN8nWorkflow(wf.id);
        } else {
          await client.activateN8nWorkflow(wf.id);
        }
        setWorkflows((prev) =>
          prev.map((w) => (w.id === wf.id ? { ...w, active: !wf.active } : w)),
        );
      } catch (err) {
        pushError(
          t("automations.n8n.errorUpdateWorkflow", {
            message: err instanceof Error ? err.message : "error",
          }),
        );
      } finally {
        setBusy(null);
      }
    },
    [pushError, t],
  );

  const handleDelete = useCallback(
    async (wf: N8nWorkflow) => {
      const confirmed = await confirmDesktopAction({
        title: t("automations.n8n.deleteWorkflow"),
        // M9: i18n the delete confirm message with workflow name
        message: t("automations.n8n.deleteConfirmWorkflow", { name: wf.name }),
        confirmLabel: t("automations.n8n.deleteWorkflow"),
        cancelLabel: t("common.cancel"),
        type: "warning",
      });
      if (!confirmed) return;
      setBusy(wf.id);
      try {
        await client.deleteN8nWorkflow(wf.id);
        setWorkflows((prev) => prev.filter((w) => w.id !== wf.id));
        setSelectedId((cur) => (cur === wf.id ? null : cur));
      } catch (err) {
        pushError(
          t("automations.n8n.errorDeleteWorkflow", {
            message: err instanceof Error ? err.message : "error",
          }),
        );
      } finally {
        setBusy(null);
      }
    },
    [t, pushError],
  );

  // M7: Keyboard navigation between workflow rows.
  const handleRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const nextIndex =
          e.key === "ArrowDown"
            ? Math.min(index + 1, workflows.length - 1)
            : Math.max(index - 1, 0);
        // Focus the button at nextIndex — they are siblings in the parent div
        const parent = (e.currentTarget as HTMLButtonElement).parentElement;
        if (!parent) return;
        const buttons = parent.querySelectorAll<HTMLButtonElement>(
          "button[type='button']",
        );
        buttons[nextIndex]?.focus();
      }
    },
    [workflows.length],
  );

  // ── Sidebar workflow list ───────────────────────────────────────────────
  const workflowSidebar = (
    <div className="space-y-1 px-1">
      {workflowsLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted/70 px-3">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" />
          {t("common.loading")}
        </div>
      ) : workflows.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted">
          <Zap className="mx-auto mb-2 h-5 w-5 text-muted/40" />
          <div className="font-semibold text-txt-strong text-xs mb-1">
            {t("automations.n8n.noWorkflowsTitle")}
          </div>
          <div className="text-xs text-muted">
            {t("automations.n8n.noWorkflowsHint")}
          </div>
        </div>
      ) : (
        workflows.map((wf, index) => (
          <WorkflowSidebarRow
            key={wf.id}
            workflow={wf}
            selected={selectedId === wf.id}
            onClick={() =>
              setSelectedId((cur) => (cur === wf.id ? null : wf.id))
            }
            onKeyDown={(e) => handleRowKeyDown(e, index)}
          />
        ))
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Status banner + refresh button row */}
      <div className="flex items-center gap-2 mb-1">
        <div className="flex-1 min-w-0">
          <N8nStatusBanner
            status={n8nStatus}
            loading={statusLoading}
            onRetry={handleRetry}
            onDismiss={() => setBannerDismissed(true)}
            dismissed={bannerDismissed}
          />
        </div>
        {/* M12: use Button primitive for refresh */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 flex items-center gap-1 text-muted hover:text-txt text-xs px-2 py-1 rounded-lg hover:bg-bg/50 transition-colors mb-3 h-7 w-7"
          onClick={handleRefresh}
          disabled={workflowsLoading}
          aria-label={t("actions.refresh")}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${workflowsLoading ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      {/* M8: Error queue — stacked, each dismissible, capped at 3 */}
      {errors.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {errors.map((err) => (
            <div
              key={err.id}
              className="flex items-center justify-between rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              <span>{err.message}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-2 text-danger/60 hover:text-danger h-5 w-5"
                onClick={() => dismissError(err.id)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Two-pane: sidebar list + detail */}
      <div className="flex flex-1 min-h-0 gap-4">
        {/* M7: use <nav> with aria-label for workflow list */}
        <nav
          aria-label={t("automations.n8n.workflowListLabel")}
          className="w-56 shrink-0 overflow-y-auto"
        >
          {workflowSidebar}
        </nav>

        {/* Right: detail pane */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <WorkflowDetailPane
            workflow={selectedWorkflow}
            busy={busy}
            onToggleActive={(wf) => void handleToggleActive(wf)}
            onDelete={(wf) => void handleDelete(wf)}
            composerRef={composerRef}
            onWorkflowMutated={handleWorkflowMutated}
          />
        </div>
      </div>
    </div>
  );
}
