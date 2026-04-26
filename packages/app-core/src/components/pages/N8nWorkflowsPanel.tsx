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

import { Button, FieldLabel, StatusBadge } from "@elizaos/ui";
import { RefreshCw, Workflow, X, Zap } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { client } from "../../api";
import type {
  Conversation,
  N8nMode,
  N8nSidecarStatus,
  N8nStatusResponse,
  N8nWorkflow,
} from "../../api/client-types";
import { useApp } from "../../state";
import { confirmDesktopAction } from "../../utils";
import { AutomationRoomChatPane } from "./AutomationRoomChatPane";
import {
  buildWorkflowConversationMetadata,
  buildWorkflowDraftConversationMetadata,
  getAutomationBridgeConversationId,
} from "./automation-conversations";

// ---------------------------------------------------------------------------
// System addendum constant
// ---------------------------------------------------------------------------

const WORKFLOW_SYSTEM_ADDENDUM =
  "You are in the Automations assistant. When the user asks to automate, " +
  "schedule, trigger, or connect apps, use the n8n workflow actions " +
  "(CREATE_N8N_WORKFLOW, ACTIVATE_N8N_WORKFLOW, DEACTIVATE_N8N_WORKFLOW, " +
  "DELETE_N8N_WORKFLOW, GET_N8N_EXECUTIONS). Confirm workflow drafts with the " +
  "user before deploying.";

function createWorkflowDraftId(): string {
  return globalThis.crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// N8nStatusBanner
// ---------------------------------------------------------------------------

interface N8nStatusBannerProps {
  status: N8nStatusResponse | null;
  loading: boolean;
  onRetry: () => void;
  onStartLocal: () => void;
  onDismiss: () => void;
  dismissed: boolean;
  retrying: boolean;
}

function N8nStatusBanner({
  status,
  loading,
  onRetry,
  onStartLocal,
  onDismiss,
  dismissed,
  retrying,
}: N8nStatusBannerProps) {
  const { t, setTab, setState } = useApp();

  if (loading || !status) return null;

  const mode: N8nMode = status.mode;
  const sidecarStatus: N8nSidecarStatus = status.status;
  const platform = status.platform ?? "desktop";
  const cloudHealth = status.cloudHealth ?? "ok";

  // ── CTA block for disabled mode ─────────────────────────────────────────
  if (mode === "disabled") {
    const headingId = "n8n-cta-heading";
    if (platform === "mobile") {
      return (
        <section
          aria-labelledby={headingId}
          className="rounded-xl border border-border/30 bg-bg/30 px-4 py-5 mb-3 space-y-3"
        >
          <h3 id={headingId} className="text-sm font-semibold text-txt-strong">
            {t("automations.n8n.ctaHeadingMobile")}
          </h3>
          <p className="text-xs text-muted">
            {t("automations.n8n.ctaBodyMobile")}
          </p>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-8 px-4 text-xs"
            onClick={() => {
              setState("cloudDashboardView", "overview");
              setTab("settings");
            }}
          >
            {t("startupshell.CloudLogin")}
          </Button>
        </section>
      );
    }

    // desktop: cloud (recommended) + local secondary
    return (
      <section
        aria-labelledby={headingId}
        className="rounded-xl border border-border/30 bg-bg/30 px-4 py-5 mb-3 space-y-3"
      >
        <h3 id={headingId} className="text-sm font-semibold text-txt-strong">
          {t("automations.n8n.ctaHeadingDesktop")}
        </h3>
        <p className="text-xs text-muted">
          {t("automations.n8n.ctaBodyDesktop")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-8 px-4 text-xs"
            onClick={() => {
              setState("cloudDashboardView", "overview");
              setTab("settings");
            }}
          >
            {t("startupshell.CloudLogin")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-4 text-xs"
            onClick={onStartLocal}
          >
            {t("automations.n8n.ctaEnableLocal")}
          </Button>
        </div>
      </section>
    );
  }

  // ── Cloud-health degraded banner ─────────────────────────────────────────
  if (mode === "cloud" && cloudHealth === "degraded") {
    return (
      <div
        role="status"
        className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-3 text-xs mb-3"
      >
        <div className="flex-1 space-y-1">
          <div className="font-semibold text-warning">
            {t("automations.n8n.cloudDegradedHeading")}
          </div>
          <div className="text-muted">
            {t("automations.n8n.cloudDegradedBody")}
          </div>
        </div>
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-busy={retrying}
          className="shrink-0 h-auto w-auto p-0 text-xs text-warning"
          onClick={onRetry}
          disabled={retrying}
        >
          {t("common.retry")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("common.dismiss")}
          onClick={onDismiss}
          className="shrink-0 h-5 w-5 text-muted hover:text-txt"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  if (dismissed) return null;

  // ── Mode pill ────────────────────────────────────────────────────────────
  let pillLabel: string;
  let pillVariant: "success" | "warning" | "danger" | "muted";
  let pillAria: string;

  if (mode === "cloud") {
    // cloudHealth is "ok" or "unknown" here (degraded handled above)
    pillLabel = t("automations.n8n.pillCloudHealthy");
    pillVariant = "success";
    pillAria = t("automations.n8n.pillAriaCloudHealthy");
  } else if (mode === "local" && sidecarStatus === "ready") {
    pillLabel = t("automations.n8n.pillLocalReady");
    pillVariant = "success";
    pillAria = t("automations.n8n.pillAriaLocalReady");
  } else if (mode === "local" && sidecarStatus === "error") {
    pillLabel = t("automations.n8n.bannerLocalError");
    pillVariant = "danger";
    pillAria = t("automations.n8n.bannerLocalError");
  } else {
    // local + starting or stopped
    pillLabel = t("automations.n8n.pillLocalStarting");
    pillVariant = "warning";
    pillAria = t("automations.n8n.pillAriaLocalStarting");
  }

  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-lg border border-border/20 bg-bg/20 px-3 py-2 text-xs mb-3"
    >
      <StatusBadge
        label={pillLabel}
        variant={pillVariant}
        withDot
        aria-label={pillAria}
      />
      <span className="flex-1" />
      {mode === "local" && sidecarStatus === "error" && (
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-busy={retrying}
          className="h-auto w-auto p-0 text-xs text-danger"
          onClick={onRetry}
          disabled={retrying}
        >
          {t("common.retry")}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("common.dismiss")}
        onClick={onDismiss}
        className="h-5 w-5 text-muted hover:text-txt"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
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
        label={workflow.active ? t("common.active") : t("common.paused")}
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
  conversationTitle,
  conversationMetadata,
  busy,
  onToggleActive,
  onDelete,
  composerRef,
  onConversationResolved,
  onWorkflowMutated,
}: {
  workflow: N8nWorkflow | null;
  conversationTitle: string;
  conversationMetadata:
    | ReturnType<typeof buildWorkflowConversationMetadata>
    | ReturnType<typeof buildWorkflowDraftConversationMetadata>;
  busy: string | null;
  onToggleActive: (wf: N8nWorkflow) => void;
  onDelete: (wf: N8nWorkflow) => void;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  onConversationResolved: (conversation: Conversation) => void;
  onWorkflowMutated: () => void;
}) {
  const { t } = useApp();
  const [chatCollapsed, setChatCollapsed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: expand chat when selection changes
  useEffect(() => {
    setChatCollapsed(false);
  }, [workflow?.id]);

  if (!workflow) {
    // Session 20 item 3: empty-state chat pane removed. The hero compose
    // (AutomationsView dashboard tab) is the canonical workflow-create
    // surface; the per-workflow chat pane below renders only after a
    // workflow is selected, where the planner-routed conversational flow
    // is the right tool for edit/refine.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted">
        <Workflow className="h-6 w-6 text-muted/40" />
        <div className="text-txt-strong font-semibold">
          No workflow selected
        </div>
        <div className="text-xs text-muted/80 max-w-xs">
          Select a workflow from the sidebar to view its details, or switch to
          the dashboard to create a new one.
        </div>
      </div>
    );
  }

  const nodes = workflow.nodes ?? [];
  const nodeCount = workflow.nodeCount ?? nodes.length;

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto">
      {/* Scoped chat — collapsible above workflow detail */}
      <AutomationRoomChatPane
        assistantLabel={t("automations.chat.assistantLabel")}
        collapsed={chatCollapsed}
        metadata={conversationMetadata}
        onToggleCollapse={() => setChatCollapsed((v) => !v)}
        composerRef={composerRef}
        onConversationResolved={onConversationResolved}
        onAutomationMutated={onWorkflowMutated}
        placeholder={t("automations.chat.placeholder")}
        systemAddendum={WORKFLOW_SYSTEM_ADDENDUM}
        title={conversationTitle}
      />

      {/* Workflow detail card */}
      <div className="rounded-xl border border-border/40 bg-card/50 p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <FieldLabel variant="kicker">
                <Workflow className="mr-1.5 inline h-3.5 w-3.5" />
                {t("automations.workflow.workflowKicker")}
              </FieldLabel>
              <StatusBadge
                label={
                  workflow.active ? t("common.active") : t("common.paused")
                }
                variant={workflow.active ? "success" : "muted"}
                withDot
              />
            </div>
            <h2 className="text-2xl font-semibold text-txt break-words">
              {workflow.name}
            </h2>
            {workflow.description && (
              <p className="text-sm text-muted mt-1 break-words">
                {workflow.description}
              </p>
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
            aria-busy={busy === workflow.id}
            disabled={busy === workflow.id}
            onClick={() => onToggleActive(workflow)}
          >
            {busy === workflow.id
              ? t("common.updating")
              : workflow.active
                ? t("automations.n8n.deactivate")
                : t("automations.n8n.activate")}
          </Button>
        </div>
      </div>

      {/* Node list */}
      {nodeCount > 0 && nodes.length > 0 && (
        <div className="rounded-xl border border-border/40 bg-card/50 p-4 space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t("automations.n8n.nodeCount", { count: nodeCount })}
          </div>
          <div className="space-y-1">
            {nodes.map((node) => (
              <div
                key={node.id}
                className="text-sm text-txt flex items-center gap-2 py-1 border-b border-border/20 last:border-b-0"
              >
                <span className="flex-1 min-w-0 truncate">{node.name}</span>
                <span className="shrink-0 text-xs text-muted font-mono">
                  {node.type.split(".").pop()}
                </span>
              </div>
            ))}
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
          aria-busy={busy === workflow.id}
          disabled={busy === workflow.id}
          onClick={() => onDelete(workflow)}
        >
          {busy === workflow.id
            ? t("common.updating")
            : t("automations.n8n.deleteWorkflow")}
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
  draftToken: number;
}

export function N8nWorkflowsPanel({
  composerRef,
  draftToken,
}: N8nWorkflowsPanelProps) {
  const { t, activeConversationId, conversations } = useApp();

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
  const [retrying, setRetrying] = useState(false);
  const [draftId, setDraftId] = useState(() => createWorkflowDraftId());
  const [activeAutomationConversation, setActiveAutomationConversation] =
    useState<Conversation | null>(null);
  const didAutoStart = useRef(false);
  const previousDraftTokenRef = useRef(draftToken);
  const workflowsRef = useRef<N8nWorkflow[]>([]);

  useEffect(() => {
    workflowsRef.current = workflows;
  }, [workflows]);

  useEffect(() => {
    if (previousDraftTokenRef.current === draftToken) {
      return;
    }
    previousDraftTokenRef.current = draftToken;
    setDraftId(createWorkflowDraftId());
    setSelectedId(null);
  }, [draftToken]);

  const selectedWorkflow = workflows.find((wf) => wf.id === selectedId) ?? null;
  const bridgeConversationId = getAutomationBridgeConversationId(
    activeConversationId,
    conversations,
  );
  const conversationTitle =
    selectedWorkflow?.name ?? t("automations.workflow.draftTitle");
  const conversationMetadata = selectedWorkflow
    ? buildWorkflowConversationMetadata(
        selectedWorkflow.id,
        selectedWorkflow.name,
        bridgeConversationId,
      )
    : buildWorkflowDraftConversationMetadata(draftId, bridgeConversationId);

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

  const loadWorkflows = useCallback(
    async (options?: { bindDraftConversation?: Conversation | null }) => {
      setWorkflowsLoading(true);
      try {
        const previousWorkflowIds = new Set(
          workflowsRef.current.map((wf) => wf.id),
        );
        const list = await client.listN8nWorkflows();
        setWorkflows(list);
        setErrors([]);

        const draftConversation = options?.bindDraftConversation;
        if (
          draftConversation?.metadata?.scope === "automation-workflow-draft" &&
          draftConversation.metadata.automationType === "n8n_workflow"
        ) {
          const createdWorkflows = list.filter(
            (workflow) => !previousWorkflowIds.has(workflow.id),
          );
          if (createdWorkflows.length === 1) {
            const createdWorkflow = createdWorkflows[0];
            const reboundMetadata = buildWorkflowConversationMetadata(
              createdWorkflow.id,
              createdWorkflow.name,
              draftConversation.metadata.terminalBridgeConversationId,
            );
            const { conversation } = await client.updateConversation(
              draftConversation.id,
              {
                title: createdWorkflow.name,
                metadata: reboundMetadata,
              },
            );
            setActiveAutomationConversation(conversation);
            setSelectedId(createdWorkflow.id);
            return;
          }
        }

        setSelectedId((currentSelectedId) =>
          currentSelectedId &&
          list.some((workflow) => workflow.id === currentSelectedId)
            ? currentSelectedId
            : null,
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
    },
    [pushError, t],
  );

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
      void loadWorkflows({
        bindDraftConversation: activeAutomationConversation,
      });
    }
  }, [activeAutomationConversation, n8nStatus, loadWorkflows]);

  const handleRefresh = useCallback(() => {
    void loadStatus();
    void loadWorkflows();
  }, [loadStatus, loadWorkflows]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      try {
        await client.startN8nSidecar();
      } catch (err) {
        pushError(
          t("automations.n8n.errorStartSidecar", {
            message: err instanceof Error ? err.message : "start failed",
          }),
        );
      }
      await loadStatus();
    } finally {
      setRetrying(false);
    }
  }, [loadStatus, pushError, t]);

  // User-initiated local sidecar start (from the CTA block on desktop disabled mode).
  const handleStartLocal = useCallback(async () => {
    setRetrying(true);
    try {
      try {
        await client.startN8nSidecar();
      } catch (err) {
        pushError(
          t("automations.n8n.errorStartSidecar", {
            message: err instanceof Error ? err.message : "start failed",
          }),
        );
      }
      await loadStatus();
    } finally {
      setRetrying(false);
    }
  }, [loadStatus, pushError, t]);

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
            onClick={() => setSelectedId(wf.id)}
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
            onRetry={() => void handleRetry()}
            onStartLocal={() => void handleStartLocal()}
            onDismiss={() => setBannerDismissed(true)}
            dismissed={bannerDismissed}
            retrying={retrying}
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
          aria-label={t("common.refresh")}
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
            conversationTitle={conversationTitle}
            conversationMetadata={conversationMetadata}
            busy={busy}
            onToggleActive={(wf) => void handleToggleActive(wf)}
            onDelete={(wf) => void handleDelete(wf)}
            composerRef={composerRef}
            onConversationResolved={setActiveAutomationConversation}
            onWorkflowMutated={handleWorkflowMutated}
          />
        </div>
      </div>
    </div>
  );
}
