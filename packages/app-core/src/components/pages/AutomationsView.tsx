/**
 * AutomationsView — unified list/detail UI for coordinator and workflow automations.
 */

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  FieldLabel,
  Input,
  PageLayout,
  PagePanel,
  Sidebar,
  SidebarCollapsedActionButton,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
  StatusBadge,
  Textarea,
  TooltipHint,
} from "@elizaos/ui";
import {
  Calendar,
  CheckCircle2,
  Circle,
  Clock3,
  FileText,
  GitBranch,
  Grid3x3,
  type LucideIcon,
  Mail,
  Plus,
  Rss,
  Settings,
  Share2,
  Signal,
  SquareTerminal,
  Workflow,
  Zap,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api";
import type {
  AutomationListResponse,
  AutomationNodeDescriptor,
  AutomationItem as CatalogAutomationItem,
  Conversation,
  N8nStatusResponse,
  TriggerSummary,
  WorkbenchTask,
} from "../../api/client";
import { useApp } from "../../state";
import { confirmDesktopAction } from "../../utils";
import { formatDateTime, formatDurationMs } from "../../utils/format";
import { WidgetHost } from "../../widgets";
import { AutomationRoomChatPane } from "./AutomationRoomChatPane";
import {
  buildAutomationResponseRoutingMetadata,
  buildCoordinatorConversationMetadata,
  buildCoordinatorTriggerConversationMetadata,
  buildWorkflowConversationMetadata,
  buildWorkflowDraftConversationMetadata,
  getAutomationBridgeConversationId,
  resolveAutomationConversation,
} from "./automation-conversations";
import { HeartbeatForm } from "./HeartbeatForm";
import {
  buildCreateRequest,
  buildUpdateRequest,
  emptyForm,
  formFromTrigger,
  type HeartbeatTemplate,
  loadUserTemplates,
  localizedExecutionStatus,
  railMonogram,
  saveUserTemplates,
  scheduleLabel,
  type TriggerFormState,
  toneForLastStatus,
  validateForm,
} from "./heartbeat-utils";

type AutomationFilter = "all" | "coordinator" | "workflows" | "scheduled";
type AutomationSubpage = "list" | "node-catalog";
type SelectionKind = "trigger" | "task" | "workflow" | null;
type AutomationItem = CatalogAutomationItem;

const WORKFLOW_DRAFT_TITLE = "New Workflow Draft";
const WORKFLOW_SYSTEM_ADDENDUM =
  "You are in a workflow-specific automation room. Focus only on this " +
  "workflow. Use the linked terminal conversation only when it directly " +
  "informs the workflow. Request keys and connector setup when needed, and " +
  "prefer owner-scoped LifeOps integrations for personal services.";
const COORDINATOR_SYSTEM_ADDENDUM =
  "You are in a workflow-specific automation room for a coordinator " +
  "automation. Focus only on this automation. Use the linked terminal " +
  "conversation only when it directly informs the automation.";
const NODE_CLASS_ORDER = [
  "agent",
  "action",
  "context",
  "integration",
  "trigger",
  "flow-control",
] as const;

function createWorkflowDraftId(): string {
  return globalThis.crypto.randomUUID();
}

function getNavigationPathFromWindow(): string {
  if (typeof window === "undefined") return "/";
  return window.location.protocol === "file:"
    ? window.location.hash.replace(/^#/, "") || "/"
    : window.location.pathname || "/";
}

function normalizeAutomationPath(pathname: string): string {
  if (!pathname) return "/";
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function getAutomationSubpageFromPath(pathname: string): AutomationSubpage {
  const normalized = normalizeAutomationPath(pathname);
  if (
    normalized === "/node-catalog" ||
    normalized === "/automations/node-catalog"
  ) {
    return "node-catalog";
  }
  return "list";
}

function getPathForAutomationSubpage(subpage: AutomationSubpage): string {
  return subpage === "node-catalog"
    ? "/automations/node-catalog"
    : "/automations";
}

function syncAutomationSubpagePath(
  subpage: AutomationSubpage,
  mode: "push" | "replace" = "push",
): void {
  if (typeof window === "undefined") return;
  const nextPath = getPathForAutomationSubpage(subpage);
  const currentPath = normalizeAutomationPath(getNavigationPathFromWindow());
  if (currentPath === nextPath) return;

  if (window.location.protocol === "file:") {
    window.location.hash = nextPath;
    return;
  }

  window.history[mode === "replace" ? "replaceState" : "pushState"](
    null,
    "",
    nextPath,
  );
}

function getSelectionKind(item: AutomationItem | null): SelectionKind {
  if (!item) return null;
  if (item.type === "n8n_workflow") return "workflow";
  if (item.task) return "task";
  if (item.trigger) return "trigger";
  return null;
}

function getAutomationSearchText(item: AutomationItem): string {
  return [item.title, item.description]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .join("\n");
}

function getAutomationBridgeIdForItem(
  item: AutomationItem | null | undefined,
  activeConversationId: string | null | undefined,
  conversations: Conversation[],
): string | undefined {
  return (
    item?.room?.terminalBridgeConversationId ??
    item?.room?.sourceConversationId ??
    getAutomationBridgeConversationId(activeConversationId, conversations)
  );
}

function getWorkflowNodeCount(item: AutomationItem): number {
  return item.workflow?.nodeCount ?? item.workflow?.nodes?.length ?? 0;
}

function getAutomationIndicatorTone(
  item: AutomationItem,
): "accent" | undefined {
  if (item.type === "n8n_workflow") {
    return item.enabled ? "accent" : undefined;
  }
  if (item.task) {
    return item.task.isCompleted ? undefined : "accent";
  }
  if (item.trigger) {
    return item.trigger.enabled ? "accent" : undefined;
  }
  return undefined;
}

function buildTriggerSchedulePrompt(trigger: TriggerSummary): string {
  if (trigger.triggerType === "interval") {
    return `Schedule: interval every ${trigger.intervalMs ?? 0}ms.`;
  }
  if (trigger.triggerType === "once") {
    return `Schedule: run once at ${trigger.scheduledAtIso ?? "an unspecified time"}.`;
  }
  if (trigger.triggerType === "cron") {
    return `Schedule: cron ${trigger.cronExpression ?? ""}.`;
  }
  return `Schedule type: ${trigger.triggerType}.`;
}

function buildWorkflowCompilationPrompt(item: AutomationItem): string {
  const lines = [
    "Compile this coordinator automation into an n8n workflow.",
    `Automation title: ${item.title}`,
    `Description: ${item.description || "No additional description provided."}`,
    "Keep the workflow in this dedicated automation room.",
    "Use runtime actions and providers as workflow nodes when they fit the job.",
    "Use owner-scoped LifeOps nodes for Gmail, Calendar, Signal, Telegram, Discord, and GitHub when they are set up. If not, request the required setup or keys.",
  ];

  if (item.task) {
    lines.push(
      `Task description: ${item.task.description || "No task description."}`,
    );
  }

  if (item.trigger) {
    lines.push(`Coordinator instructions: ${item.trigger.instructions}`);
    lines.push(buildTriggerSchedulePrompt(item.trigger));
  }

  if (item.schedules.length > 0) {
    lines.push("Existing schedules:");
    for (const schedule of item.schedules) {
      lines.push(`- ${buildTriggerSchedulePrompt(schedule)}`);
    }
  }

  lines.push(
    "Ask follow-up questions only when workflow intent is genuinely ambiguous.",
  );
  return lines.join("\n");
}

function getNodeClassLabel(
  className: AutomationNodeDescriptor["class"],
): string {
  switch (className) {
    case "agent":
      return "Agent";
    case "action":
      return "Actions";
    case "context":
      return "Context";
    case "integration":
      return "Integrations";
    case "trigger":
      return "Triggers";
    case "flow-control":
      return "Flow Control";
    default:
      return className;
  }
}

function getNodeIcon(node: AutomationNodeDescriptor) {
  if (node.source === "lifeops_event") {
    return <Zap className="h-3.5 w-3.5" />;
  }
  if (node.source === "lifeops") {
    if (node.id === "lifeops:gmail") return <Mail className="h-3.5 w-3.5" />;
    if (node.id === "lifeops:signal") return <Signal className="h-3.5 w-3.5" />;
    if (node.id === "lifeops:github") {
      return <GitBranch className="h-3.5 w-3.5" />;
    }
  }
  if (node.class === "agent") {
    return <SquareTerminal className="h-3.5 w-3.5" />;
  }
  if (node.class === "integration") {
    return <Workflow className="h-3.5 w-3.5" />;
  }
  if (node.class === "context") {
    return <Settings className="h-3.5 w-3.5" />;
  }
  if (node.class === "trigger") {
    return <Clock3 className="h-3.5 w-3.5" />;
  }
  return <Zap className="h-3.5 w-3.5" />;
}

function useAutomationsViewController() {
  const {
    triggers = [],
    triggersLoaded = false,
    triggersLoading = false,
    triggersSaving = false,
    triggerRunsById = {},
    triggerError = null,
    loadTriggers = async () => {},
    createTrigger = async () => null,
    updateTrigger = async () => null,
    deleteTrigger = async () => true,
    runTriggerNow = async () => true,
    loadTriggerRuns = async () => {},
    loadTriggerHealth = async () => {},
    ensureTriggersLoaded = async () => {
      await loadTriggers(triggersLoaded ? { silent: true } : undefined);
    },
    t,
    uiLanguage,
  } = useApp();

  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskSaving, setTaskSaving] = useState(false);
  const [form, setForm] = useState<TriggerFormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedItemKind, setSelectedItemKind] = useState<SelectionKind>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"trigger" | "task">("trigger");
  const [userTemplates, setUserTemplates] =
    useState<HeartbeatTemplate[]>(loadUserTemplates);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  const [taskFormName, setTaskFormName] = useState("");
  const [taskFormDescription, setTaskFormDescription] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [filter, setFilter] = useState<AutomationFilter>("all");
  const [automationItems, setAutomationItems] = useState<AutomationItem[]>([]);
  const [automationNodes, setAutomationNodes] = useState<
    AutomationNodeDescriptor[]
  >([]);
  const [automationsLoading, setAutomationsLoading] = useState(false);
  const [automationsLoaded, setAutomationsLoaded] = useState(false);
  const [automationsError, setAutomationsError] = useState<string | null>(null);
  const [n8nStatus, setN8nStatus] = useState<N8nStatusResponse | null>(null);
  const [workflowFetchError, setWorkflowFetchError] = useState<string | null>(
    null,
  );
  const didBootstrapDataRef = useRef(false);
  const lastSelectedIdRef = useRef<string | null>(null);

  const refreshAutomations =
    useCallback(async (): Promise<AutomationListResponse | null> => {
      setAutomationsLoading(true);
      try {
        const [automationData, nodeCatalog] = await Promise.all([
          client.listAutomations(),
          client.getAutomationNodeCatalog(),
        ]);
        setAutomationItems(automationData.automations ?? []);
        setAutomationNodes(nodeCatalog.nodes ?? []);
        setN8nStatus(automationData.n8nStatus ?? null);
        setWorkflowFetchError(automationData.workflowFetchError ?? null);
        setAutomationsError(null);
        return automationData;
      } catch (error) {
        setAutomationsError(
          error instanceof Error ? error.message : "Failed to load automations",
        );
        return null;
      } finally {
        setAutomationsLoaded(true);
        setAutomationsLoading(false);
      }
    }, []);

  const createWorkbenchTask = useCallback(
    async (data: {
      name: string;
      description: string;
      tags?: string[];
    }): Promise<WorkbenchTask | null> => {
      setTaskSaving(true);
      try {
        const res = await client.createWorkbenchTask(data);
        setTaskError(null);
        await refreshAutomations();
        return res.task;
      } catch (error) {
        setTaskError(
          error instanceof Error ? error.message : "Failed to create task",
        );
        return null;
      } finally {
        setTaskSaving(false);
      }
    },
    [refreshAutomations],
  );

  const updateWorkbenchTask = useCallback(
    async (
      id: string,
      data: Partial<{
        name: string;
        description: string;
        isCompleted: boolean;
      }>,
    ): Promise<WorkbenchTask | null> => {
      setTaskSaving(true);
      try {
        const res = await client.updateWorkbenchTask(id, data);
        setTaskError(null);
        await refreshAutomations();
        return res.task;
      } catch (error) {
        setTaskError(
          error instanceof Error ? error.message : "Failed to update task",
        );
        return null;
      } finally {
        setTaskSaving(false);
      }
    },
    [refreshAutomations],
  );

  const deleteWorkbenchTask = useCallback(
    async (id: string): Promise<boolean> => {
      setTaskSaving(true);
      try {
        await client.deleteWorkbenchTask(id);
        setTaskError(null);
        await refreshAutomations();
        return true;
      } catch (error) {
        setTaskError(
          error instanceof Error ? error.message : "Failed to delete task",
        );
        return false;
      } finally {
        setTaskSaving(false);
      }
    },
    [refreshAutomations],
  );

  const saveFormAsTemplate = useCallback(() => {
    const name = form.displayName.trim();
    if (!name) return;
    const template: HeartbeatTemplate = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      instructions: form.instructions.trim(),
      interval: form.durationValue || "1",
      unit: form.durationUnit,
    };
    setUserTemplates((previous) => {
      const next = [...previous, template];
      saveUserTemplates(next);
      return next;
    });
  }, [form]);

  const deleteUserTemplate = useCallback((id: string) => {
    setUserTemplates((previous) => {
      const next = previous.filter((template) => template.id !== id);
      saveUserTemplates(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (didBootstrapDataRef.current) return;
    didBootstrapDataRef.current = true;
    void loadTriggerHealth();
    void ensureTriggersLoaded();
    void refreshAutomations();
  }, [ensureTriggersLoaded, loadTriggerHealth, refreshAutomations]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ filter: AutomationFilter }>)
        .detail;
      if (detail?.filter) {
        setFilter(detail.filter);
      }
    };
    window.addEventListener("milady:automations:setFilter", handler);
    return () =>
      window.removeEventListener("milady:automations:setFilter", handler);
  }, []);

  const allItems = automationItems;
  const filteredItems = useMemo(() => {
    switch (filter) {
      case "coordinator":
        return allItems.filter((item) => item.type === "coordinator_text");
      case "workflows":
        return allItems.filter((item) => item.type === "n8n_workflow");
      case "scheduled":
        return allItems.filter((item) => item.schedules.length > 0);
      default:
        return allItems;
    }
  }, [allItems, filter]);

  useEffect(() => {
    if (!selectedItemId) return;
    if (!allItems.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(null);
      setSelectedItemKind(null);
    }
  }, [allItems, selectedItemId]);

  useEffect(() => {
    if (selectedItemId) {
      lastSelectedIdRef.current = selectedItemId;
    }
  }, [selectedItemId]);

  useEffect(() => {
    if (
      editorOpen ||
      editingId ||
      editingTaskId ||
      selectedItemId ||
      allItems.length === 0
    ) {
      return;
    }

    const preferred = lastSelectedIdRef.current;
    const next =
      preferred && allItems.some((item) => item.id === preferred)
        ? preferred
        : (allItems[0]?.id ?? null);
    if (!next) return;
    const item = allItems.find((candidate) => candidate.id === next) ?? null;
    setSelectedItemId(next);
    setSelectedItemKind(getSelectionKind(item));
  }, [allItems, editingId, editingTaskId, editorOpen, selectedItemId]);

  useEffect(() => {
    if (!editorOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setEditorOpen(false);
        setEditingId(null);
        setEditingTaskId(null);
        setForm(emptyForm);
        setFormError(null);
        setTaskFormName("");
        setTaskFormDescription("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editorOpen]);

  const resetEditor = () => {
    setForm(emptyForm);
    setEditingId(null);
    setEditingTaskId(null);
    setFormError(null);
    setTaskFormName("");
    setTaskFormDescription("");
  };

  const closeEditor = () => {
    setEditorOpen(false);
    resetEditor();
  };

  const openCreateTrigger = () => {
    resetEditor();
    setEditorMode("trigger");
    setEditorOpen(true);
  };

  const openCreateTask = () => {
    resetEditor();
    setEditorMode("task");
    setEditorOpen(true);
  };

  const openEditTrigger = (trigger: TriggerSummary) => {
    setEditingId(trigger.id);
    setForm(formFromTrigger(trigger));
    setFormError(null);
    setSelectedItemId(`trigger:${trigger.id}`);
    setSelectedItemKind("trigger");
    setEditorMode("trigger");
    setEditorOpen(true);
  };

  const openEditTask = (task: WorkbenchTask) => {
    setEditingTaskId(task.id);
    setTaskFormName(task.name);
    setTaskFormDescription(task.description);
    setSelectedItemId(`task:${task.id}`);
    setSelectedItemKind("task");
    setEditorMode("task");
    setEditorOpen(true);
  };

  const setField = <K extends keyof TriggerFormState>(
    key: K,
    value: TriggerFormState[K],
  ) => setForm((previous) => ({ ...previous, [key]: value }));

  const onSubmitTrigger = async () => {
    const error = validateForm(form, t);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError(null);

    if (editingId) {
      const updated = await updateTrigger(editingId, buildUpdateRequest(form));
      if (updated) {
        setSelectedItemId(`trigger:${updated.id}`);
        setSelectedItemKind("trigger");
        await refreshAutomations();
        closeEditor();
      }
      return;
    }

    const created = await createTrigger(buildCreateRequest(form));
    if (created) {
      setSelectedItemId(`trigger:${created.id}`);
      setSelectedItemKind("trigger");
      void loadTriggerRuns(created.id);
      await refreshAutomations();
      closeEditor();
    }
  };

  const onSubmitTask = async () => {
    const name = taskFormName.trim();
    if (!name) {
      setFormError("Name is required");
      return;
    }
    setFormError(null);

    if (editingTaskId) {
      const updated = await updateWorkbenchTask(editingTaskId, {
        name,
        description: taskFormDescription.trim(),
      });
      if (updated) {
        setSelectedItemId(`task:${updated.id}`);
        setSelectedItemKind("task");
        closeEditor();
      }
      return;
    }

    const created = await createWorkbenchTask({
      name,
      description: taskFormDescription.trim(),
    });
    if (created) {
      setSelectedItemId(`task:${created.id}`);
      setSelectedItemKind("task");
      closeEditor();
    }
  };

  const onDeleteTrigger = async () => {
    if (!editingId) return;
    const confirmed = await confirmDesktopAction({
      title: t("heartbeatsview.deleteTitle"),
      message: t("heartbeatsview.deleteMessage", { name: form.displayName }),
      confirmLabel: t("triggersview.Delete"),
      cancelLabel: t("common.cancel"),
      type: "warning",
    });
    if (!confirmed) return;

    const deleted = await deleteTrigger(editingId);
    if (!deleted) return;

    if (selectedItemId === `trigger:${editingId}`) {
      setSelectedItemId(null);
      setSelectedItemKind(null);
    }
    await refreshAutomations();
    closeEditor();
  };

  const onDeleteTask = async (taskId: string) => {
    const confirmed = await confirmDesktopAction({
      title: "Delete Task",
      message: "Are you sure you want to delete this task?",
      confirmLabel: t("triggersview.Delete"),
      cancelLabel: t("common.cancel"),
      type: "warning",
    });
    if (!confirmed) return;
    const deleted = await deleteWorkbenchTask(taskId);
    if (!deleted) return;
    if (selectedItemId === `task:${taskId}`) {
      setSelectedItemId(null);
      setSelectedItemKind(null);
    }
    if (editingTaskId === taskId) {
      closeEditor();
    }
  };

  const onRunSelectedTrigger = async (triggerId: string) => {
    setSelectedItemId(`trigger:${triggerId}`);
    setSelectedItemKind("trigger");
    await runTriggerNow(triggerId);
    await loadTriggerRuns(triggerId);
    await refreshAutomations();
  };

  const onToggleTriggerEnabled = async (
    triggerId: string,
    currentlyEnabled: boolean,
  ) => {
    const updated = await updateTrigger(triggerId, {
      enabled: !currentlyEnabled,
    });
    if (updated && editingId === updated.id) {
      setForm(formFromTrigger(updated));
    }
    await refreshAutomations();
  };

  const onToggleTaskCompleted = async (
    taskId: string,
    currentlyCompleted: boolean,
  ) => {
    await updateWorkbenchTask(taskId, {
      isCompleted: !currentlyCompleted,
    });
  };

  const resolvedSelectedItem = useMemo(() => {
    if (editorOpen || editingId || editingTaskId) return null;
    if (selectedItemId) {
      return allItems.find((item) => item.id === selectedItemId) ?? null;
    }
    return allItems[0] ?? null;
  }, [allItems, editingId, editingTaskId, editorOpen, selectedItemId]);

  const modalTitle =
    editorMode === "trigger"
      ? editingId
        ? t("heartbeatsview.editTitle", {
            name: form.displayName.trim() || "Task",
            defaultValue: "Edit {{name}}",
          })
        : "New Schedule"
      : editingTaskId
        ? "Edit Coordinator"
        : "New Coordinator";

  const editorEnabled =
    editingId != null
      ? (triggers.find((trigger) => trigger.id === editingId)?.enabled ??
        form.enabled)
      : form.enabled;

  const hasItems = allItems.length > 0;
  const isLoading = triggersLoading || automationsLoading;
  const combinedError = automationsError || triggerError || taskError;
  const showFirstRunEmptyState = !isLoading && !combinedError && !hasItems;
  const showDetailPane = Boolean(
    editorOpen || editingId || editingTaskId || resolvedSelectedItem,
  );

  return {
    filter,
    setFilter,
    allItems,
    filteredItems,
    selectedItemId,
    selectedItemKind,
    setSelectedItemId,
    setSelectedItemKind,
    resolvedSelectedItem,
    form,
    setForm,
    setField,
    editingId,
    setEditingId,
    editorOpen,
    setEditorOpen,
    editorMode,
    formError,
    setFormError,
    editorEnabled,
    modalTitle,
    templateNotice,
    setTemplateNotice,
    userTemplates,
    taskFormName,
    setTaskFormName,
    taskFormDescription,
    setTaskFormDescription,
    editingTaskId,
    setEditingTaskId,
    taskSaving,
    closeEditor,
    openCreateTrigger,
    openCreateTask,
    openEditTrigger,
    openEditTask,
    onSubmitTrigger,
    onSubmitTask,
    onDeleteTrigger,
    onDeleteTask,
    onRunSelectedTrigger,
    onToggleTriggerEnabled,
    onToggleTaskCompleted,
    saveFormAsTemplate,
    deleteUserTemplate,
    loadTriggerRuns,
    refreshAutomations,
    automationNodes,
    automationsLoading,
    automationsLoaded,
    automationsError,
    n8nStatus,
    workflowFetchError,
    triggers,
    triggerRunsById,
    triggersSaving,
    triggersLoading,
    triggerError,
    taskError,
    hasItems,
    isLoading,
    combinedError,
    showFirstRunEmptyState,
    showDetailPane,
    t,
    uiLanguage,
  };
}

type AutomationsViewController = ReturnType<
  typeof useAutomationsViewController
>;

const AutomationsViewContext = createContext<AutomationsViewController | null>(
  null,
);

function useAutomationsViewContext(): AutomationsViewController {
  const context = useContext(AutomationsViewContext);
  if (!context) {
    throw new Error("Automations view context is unavailable.");
  }
  return context;
}

function FilterTabs() {
  const { filter, setFilter, allItems, t } = useAutomationsViewContext();

  const filters: Array<{
    key: AutomationFilter;
    label: string;
    count: number;
  }> = [
    { key: "all", label: "All", count: allItems.length },
    {
      key: "coordinator",
      label: "Coordinator",
      count: allItems.filter((item) => item.type === "coordinator_text").length,
    },
    {
      key: "workflows",
      label: "Workflows",
      count: allItems.filter((item) => item.type === "n8n_workflow").length,
    },
    {
      key: "scheduled",
      label: "Scheduled",
      count: allItems.filter((item) => item.schedules.length > 0).length,
    },
  ];

  return (
    <div
      role="tablist"
      aria-label={t("automations.filterTabsLabel", {
        defaultValue: "Filter automations",
      })}
      className="flex gap-1 px-1 pb-2"
    >
      {filters.map(({ key, label, count }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={filter === key}
          onClick={() => setFilter(key)}
          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
            filter === key
              ? "bg-accent/15 text-accent"
              : "text-muted hover:bg-bg/50 hover:text-txt"
          }`}
        >
          {label}{" "}
          <span className={filter === key ? "text-accent/80" : "text-muted/70"}>
            {count}
          </span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflow Templates Modal (Item 4)
// ---------------------------------------------------------------------------

interface WorkflowTemplate {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  seedPrompt: string;
}

function getWorkflowTemplates(
  t: (key: string, options?: { defaultValue?: string }) => string,
): WorkflowTemplate[] {
  return [
    {
      id: "daily-email-digest",
      icon: Mail,
      title: t("automations.templates.emailDigest.title", {
        defaultValue: "Daily Email Digest",
      }),
      description: t("automations.templates.emailDigest.desc", {
        defaultValue: "Summarize your inbox each morning and post to Slack.",
      }),
      seedPrompt: t("automations.templates.emailDigest.prompt", {
        defaultValue:
          "Every weekday at 9am, read my Gmail inbox from the last 24 hours, summarize the important messages, and post the summary to my #daily channel in Slack.",
      }),
    },
    {
      id: "slack-discord-bridge",
      icon: Share2,
      title: "Slack \u2194 Discord Bridge",
      description: "Cross-post messages between Slack and Discord channels.",
      seedPrompt:
        "Whenever a message is posted in the #announcements channel in Slack, forward it to the #general channel in Discord.",
    },
    {
      id: "rss-to-summary",
      icon: Rss,
      title: "RSS to Summary",
      description: "Poll an RSS feed and summarize new articles via email.",
      seedPrompt:
        "Check my RSS feed https://example.com/feed.xml every hour. For each new article, generate a 3-sentence summary and email it to me.",
    },
    {
      id: "calendar-to-slack",
      icon: Calendar,
      title: "Calendar to Slack",
      description: "Post your day's agenda to Slack each morning.",
      seedPrompt:
        "Every weekday at 8am, read today's events from my Google Calendar and post a formatted agenda to my #daily-standup channel in Slack.",
    },
    {
      id: "github-issue-triage",
      icon: GitBranch,
      title: "GitHub Issue Triage",
      description: "Auto-classify and label new GitHub issues.",
      seedPrompt:
        "When a new issue is opened on my GitHub repo, classify it (bug/feature/question/docs), add the matching label, and post a welcoming comment.",
    },
    {
      id: "email-to-notion",
      icon: FileText,
      title: "Email \u2192 Notion",
      description: "Turn tagged emails into Notion pages.",
      seedPrompt:
        "When I receive a Gmail message labeled 'Task', extract the key details and create a new page in my Notion 'Inbox' database with the subject as the title and body as content.",
    },
  ];
}

function WorkflowTemplatesModal({
  open,
  onOpenChange,
  onSelectTemplate,
  onSelectCustom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectTemplate: (seedPrompt: string) => void;
  onSelectCustom: () => void;
}) {
  const { t } = useAutomationsViewContext();
  const templates = getWorkflowTemplates(t);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100vw-1.5rem),56rem)] max-w-none">
        <DialogHeader>
          <DialogTitle>
            {t("automations.templatesModalTitle", {
              defaultValue: "Start with a template",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("automations.templatesModalSubtitle", {
              defaultValue: "Pick a workflow to customize, or start blank.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2 overflow-y-auto max-h-[min(32rem,calc(100dvh-12rem))] pr-1">
          {templates.map((template) => {
            const Icon = template.icon;
            return (
              <div
                key={template.id}
                className="flex flex-col gap-3 rounded-xl border border-border/40 bg-bg/30 p-4 hover:border-accent/30 hover:bg-accent/5 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-lg bg-accent/10 p-2 text-accent shrink-0">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-sm font-semibold text-txt">
                      {template.title}
                    </div>
                    <p className="text-sm text-muted leading-snug">
                      {template.description}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="self-end h-7 px-3 text-xs"
                  onClick={() => onSelectTemplate(template.seedPrompt)}
                >
                  {t("automations.templateUseButton", {
                    defaultValue: "Use template",
                  })}
                </Button>
              </div>
            );
          })}

          {/* 7th card: Custom / Start from scratch */}
          <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border/40 bg-transparent p-4 hover:border-accent/30 hover:bg-accent/5 transition-colors">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-lg bg-muted/10 p-2 text-muted shrink-0">
                <Plus className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-sm font-semibold text-txt">
                  {t("automations.templateCustom.title", {
                    defaultValue: "Custom",
                  })}
                </div>
                <p className="text-sm text-muted leading-snug">
                  {t("automations.templateCustom.desc", {
                    defaultValue: "Describe your own workflow in chat.",
                  })}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="self-end h-7 px-3 text-xs"
              onClick={onSelectCustom}
            >
              {t("automations.templateUseButton", {
                defaultValue: "Use template",
              })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Zero-state onboarding CTA (Item 9)
// ---------------------------------------------------------------------------

function AutomationsZeroState({
  onBrowseTemplates,
  onNewTrigger,
  onNewTask,
}: {
  onBrowseTemplates: () => void;
  onNewTrigger: () => void;
  onNewTask: () => void;
}) {
  const { t } = useAutomationsViewContext();

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-12">
      <PagePanel
        variant="padded"
        className="w-full max-w-lg text-center space-y-5"
      >
        <div className="flex justify-center">
          <div className="rounded-2xl bg-accent/10 p-4 text-accent">
            <Zap className="h-8 w-8" />
          </div>
        </div>
        <div className="space-y-2">
          <h3 className="text-xl font-semibold text-txt">
            {t("automations.zeroState.title", {
              defaultValue: "What would you like your agent to do?",
            })}
          </h3>
          <p className="text-sm text-muted leading-relaxed">
            {t("automations.zeroState.subtitle", {
              defaultValue:
                "I can build workflows for you, run prompts on a schedule, or keep a checklist of tasks.",
            })}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          <Button
            variant="default"
            size="sm"
            className="h-8 gap-1.5 px-4 text-sm"
            onClick={onBrowseTemplates}
          >
            {t("automations.zeroState.browseTemplates", {
              defaultValue: "Browse templates \u2192",
            })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-3 text-sm"
            onClick={onNewTrigger}
          >
            <Clock3 className="h-3.5 w-3.5" />
            {t("automations.newTriggerButton", {
              defaultValue: "+ New trigger",
            })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-3 text-sm"
            onClick={onNewTask}
          >
            <SquareTerminal className="h-3.5 w-3.5" />
            {t("automations.newTaskButton", { defaultValue: "+ New task" })}
          </Button>
        </div>
      </PagePanel>
    </div>
  );
}

function TaskForm() {
  const {
    taskFormName,
    setTaskFormName,
    taskFormDescription,
    setTaskFormDescription,
    editingTaskId,
    formError,
    taskSaving,
    onSubmitTask,
    onDeleteTask,
    closeEditor,
    modalTitle,
    t,
  } = useAutomationsViewContext();

  return (
    <PagePanel variant="padded" className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-txt">{modalTitle}</h3>
        <Button variant="ghost" size="sm" onClick={closeEditor}>
          {t("common.cancel")}
        </Button>
      </div>

      {formError && (
        <div className="rounded-lg border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
          {formError}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <FieldLabel>Name</FieldLabel>
          <Input
            value={taskFormName}
            onChange={(event) => setTaskFormName(event.target.value)}
            placeholder="Coordinator automation name..."
            autoFocus
          />
        </div>
        <div>
          <FieldLabel>Description</FieldLabel>
          <Textarea
            value={taskFormDescription}
            onChange={(event) => setTaskFormDescription(event.target.value)}
            placeholder="What should the coordinator do..."
            rows={4}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="default"
          size="sm"
          disabled={taskSaving || !taskFormName.trim()}
          onClick={() => void onSubmitTask()}
        >
          {editingTaskId ? "Save Coordinator" : "Create Coordinator"}
        </Button>
        {editingTaskId && (
          <Button
            variant="outline"
            size="sm"
            className="border-danger/30 text-danger hover:bg-danger/10"
            onClick={() => void onDeleteTask(editingTaskId)}
          >
            {t("triggersview.Delete")}
          </Button>
        )}
      </div>
    </PagePanel>
  );
}

function WorkflowRuntimeNotice({
  status,
  workflowFetchError,
  busy,
  onRefresh,
  onStartLocal,
}: {
  status: N8nStatusResponse | null;
  workflowFetchError: string | null;
  busy: boolean;
  onRefresh: () => void;
  onStartLocal: () => void;
}) {
  if (!status && !workflowFetchError) {
    return null;
  }

  if (status?.mode === "disabled") {
    return (
      <PagePanel
        variant="padded"
        className="mb-4 border border-border/30 bg-bg/30"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-txt">
              Workflow execution needs n8n.
            </div>
            <p className="text-sm text-muted">
              Coordinator automations stay usable without n8n. Workflow
              automations become deployable once Eliza Cloud or local n8n is
              available.
            </p>
          </div>
          {status.platform !== "mobile" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onStartLocal}
            >
              Enable Local n8n
            </Button>
          )}
        </div>
      </PagePanel>
    );
  }

  if (workflowFetchError) {
    return (
      <PagePanel
        variant="padded"
        className="mb-4 border border-danger/20 bg-danger/5"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-danger">
              Workflow backend unavailable
            </div>
            <p className="text-sm text-danger/90">{workflowFetchError}</p>
          </div>
          <div className="flex items-center gap-2">
            {status?.mode === "local" && status.status !== "ready" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={onStartLocal}
              >
                Start Local n8n
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onRefresh}
            >
              Refresh
            </Button>
          </div>
        </div>
      </PagePanel>
    );
  }

  if (status?.mode === "local" && status.status !== "ready") {
    return (
      <PagePanel
        variant="padded"
        className="mb-4 border border-warning/20 bg-warning/5"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-warning">
              Local n8n is {status.status}.
            </div>
            <p className="text-sm text-muted">
              Draft rooms still work. Workflow deploy, activate, and delete
              operations resume when local n8n is ready.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onStartLocal}
            >
              Start Local n8n
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onRefresh}
            >
              Refresh
            </Button>
          </div>
        </div>
      </PagePanel>
    );
  }

  if (status?.mode === "cloud" && status.cloudHealth === "degraded") {
    return (
      <PagePanel
        variant="padded"
        className="mb-4 border border-warning/20 bg-warning/5"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="text-sm font-semibold text-warning">
              Eliza Cloud workflow gateway is degraded.
            </div>
            <p className="text-sm text-muted">
              Chat rooms remain usable while workflow execution and sync may be
              delayed.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        </div>
      </PagePanel>
    );
  }

  return null;
}

function AutomationNodePalette({
  nodes,
  title,
  subtitle,
}: {
  nodes: AutomationNodeDescriptor[];
  title: string;
  subtitle: string;
}) {
  const groupedNodes = useMemo(
    () =>
      NODE_CLASS_ORDER.map((className) => ({
        className,
        nodes: nodes.filter((node) => node.class === className),
      })).filter((group) => group.nodes.length > 0),
    [nodes],
  );

  return (
    <PagePanel variant="padded" className="space-y-4">
      <div className="space-y-1">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted">
          {title}
        </div>
        <p className="text-sm text-muted">{subtitle}</p>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-bg/40 px-2.5 py-1 text-muted">
          {nodes.length} total
        </span>
        <span className="rounded-full bg-ok/10 px-2.5 py-1 text-ok">
          {nodes.filter((node) => node.availability === "enabled").length}{" "}
          enabled
        </span>
        <span className="rounded-full bg-warning/10 px-2.5 py-1 text-warning">
          {nodes.filter((node) => node.availability === "disabled").length}{" "}
          setup required
        </span>
      </div>

      <div className="space-y-4">
        {groupedNodes.map((group) => (
          <div key={group.className} className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">
              {getNodeClassLabel(group.className)}
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              {group.nodes.map((node) => (
                <div
                  key={node.id}
                  className={`rounded-xl border px-4 py-3 ${
                    node.availability === "enabled"
                      ? "border-border/30 bg-bg/25"
                      : "border-warning/20 bg-warning/5"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`mt-0.5 rounded-lg p-2 ${
                        node.availability === "enabled"
                          ? "bg-accent/10 text-accent"
                          : "bg-warning/10 text-warning"
                      }`}
                    >
                      {getNodeIcon(node)}
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-semibold text-txt">
                          {node.label}
                        </div>
                        <StatusBadge
                          label={
                            node.availability === "enabled" ? "Ready" : "Setup"
                          }
                          variant={
                            node.availability === "enabled"
                              ? "success"
                              : "warning"
                          }
                          withDot
                        />
                        {node.ownerScoped && (
                          <span className="rounded-full bg-bg/40 px-2 py-0.5 text-[11px] text-muted">
                            Owner scoped
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-muted">{node.description}</p>
                      {node.disabledReason && (
                        <p className="text-xs text-warning">
                          {node.disabledReason}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </PagePanel>
  );
}

function AutomationNodeCatalogPane({
  nodes,
}: {
  nodes: AutomationNodeDescriptor[];
}) {
  return (
    <AutomationNodePalette
      nodes={nodes}
      title="Workflow Node Catalog"
      subtitle="Runtime actions, providers, code-agent nodes, and owner-scoped LifeOps integrations are available here as workflow building blocks."
    />
  );
}

function TaskAutomationDetailPane({
  automation,
  nodes,
  onAutomationMutated,
  onPromoteToWorkflow,
}: {
  automation: AutomationItem;
  nodes: AutomationNodeDescriptor[];
  onAutomationMutated: () => void;
  onPromoteToWorkflow: (item: AutomationItem) => Promise<void>;
}) {
  const { activeConversationId, conversations } = useApp();
  const { openEditTask, onDeleteTask, onToggleTaskCompleted, t } =
    useAutomationsViewContext();
  const task = automation.task;
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  if (!task) {
    return null;
  }

  const bridgeConversationId = getAutomationBridgeIdForItem(
    automation,
    activeConversationId,
    conversations,
  );
  const metadata = buildCoordinatorConversationMetadata(
    task.id,
    bridgeConversationId,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <FieldLabel variant="kicker">
              {automation.system ? (
                <>
                  <Settings className="mr-1.5 inline h-3.5 w-3.5" />
                  System Automation
                </>
              ) : (
                <>
                  <SquareTerminal className="mr-1.5 inline h-3.5 w-3.5" />
                  Coordinator Automation
                </>
              )}
            </FieldLabel>
            <StatusBadge
              label={
                automation.system
                  ? "System"
                  : task.isCompleted
                    ? "Completed"
                    : "Active"
              }
              variant={
                automation.system
                  ? "muted"
                  : task.isCompleted
                    ? "muted"
                    : "success"
              }
              withDot
            />
          </div>
          <h2 className="text-2xl font-semibold text-txt sm:text-[2rem]">
            {automation.title}
          </h2>
          {automation.description && (
            <p className="text-sm leading-relaxed text-muted">
              {automation.description}
            </p>
          )}
          {task.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {task.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md bg-bg/50 px-2 py-0.5 text-xs text-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {!automation.system && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
            <Button
              variant="outline"
              size="sm"
              className={`h-8 px-3 text-xs ${
                task.isCompleted
                  ? "border-ok/30 text-ok hover:bg-ok/10"
                  : "border-accent/30 text-accent hover:bg-accent/10"
              }`}
              onClick={() =>
                void onToggleTaskCompleted(task.id, task.isCompleted)
              }
            >
              {task.isCompleted ? "Reopen" : "Complete"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs"
              onClick={() => void onPromoteToWorkflow(automation)}
            >
              <GitBranch className="mr-1.5 h-3.5 w-3.5" />
              Compile to Workflow
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs"
              onClick={() => openEditTask(task)}
            >
              {t("triggersview.Edit")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs border-danger/30 text-danger hover:bg-danger/10"
              onClick={() => void onDeleteTask(task.id)}
            >
              {t("triggersview.Delete")}
            </Button>
          </div>
        )}
      </div>

      {!automation.system && (
        <AutomationRoomChatPane
          assistantLabel={t("automations.chat.assistantLabel")}
          collapsed={chatCollapsed}
          composerRef={composerRef}
          metadata={metadata}
          onAutomationMutated={onAutomationMutated}
          onToggleCollapse={() => setChatCollapsed((value) => !value)}
          placeholder="Ask the coordinator to plan or execute this automation."
          systemAddendum={COORDINATOR_SYSTEM_ADDENDUM}
          title={automation.title}
        />
      )}

      <AutomationNodePalette
        nodes={nodes}
        title="Available Automation Nodes"
        subtitle="These are the runtime capabilities the coordinator can reference while building or converting this automation."
      />
    </div>
  );
}

function TriggerAutomationDetailPane({
  automation,
  nodes,
  onAutomationMutated,
  onPromoteToWorkflow,
}: {
  automation: AutomationItem;
  nodes: AutomationNodeDescriptor[];
  onAutomationMutated: () => void;
  onPromoteToWorkflow: (item: AutomationItem) => Promise<void>;
}) {
  const { activeConversationId, conversations } = useApp();
  const {
    t,
    uiLanguage,
    openEditTrigger,
    onRunSelectedTrigger,
    onToggleTriggerEnabled,
    loadTriggerRuns,
    triggerRunsById,
    setForm,
    setEditorOpen,
    setEditingId,
    setSelectedItemId,
    setSelectedItemKind,
  } = useAutomationsViewContext();
  const trigger = automation.trigger;
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const triggerId = trigger?.id;
  const selectedRuns = triggerId ? (triggerRunsById[triggerId] ?? []) : [];
  const hasLoadedRuns = triggerId
    ? Object.hasOwn(triggerRunsById, triggerId)
    : false;

  useEffect(() => {
    if (triggerId && !hasLoadedRuns) {
      void loadTriggerRuns(triggerId);
    }
  }, [hasLoadedRuns, loadTriggerRuns, triggerId]);

  if (!trigger) {
    return null;
  }

  const bridgeConversationId = getAutomationBridgeIdForItem(
    automation,
    activeConversationId,
    conversations,
  );
  const metadata = buildCoordinatorTriggerConversationMetadata(
    trigger.id,
    bridgeConversationId,
  );

  const { failureCount, successCount } = selectedRuns.reduce(
    (counts, run) => {
      const tone = toneForLastStatus(run.status);
      if (tone === "success") counts.successCount += 1;
      else if (tone === "danger") counts.failureCount += 1;
      return counts;
    },
    { failureCount: 0, successCount: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <FieldLabel variant="kicker">
              <Clock3 className="mr-1.5 inline h-3.5 w-3.5" />
              Scheduled Coordinator Automation
            </FieldLabel>
            <StatusBadge
              label={trigger.enabled ? "Active" : "Paused"}
              variant={trigger.enabled ? "success" : "muted"}
              withDot
            />
          </div>
          <h2 className="text-2xl font-semibold text-txt sm:text-[2rem]">
            {automation.title}
          </h2>
          <p className="text-sm leading-relaxed text-muted">
            {automation.description}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
          <Button
            variant="outline"
            size="sm"
            className={`h-8 px-3 text-xs ${
              trigger.enabled
                ? "border-warning/30 text-warning hover:bg-warning/10"
                : "border-ok/30 text-ok hover:bg-ok/10"
            }`}
            onClick={() =>
              void onToggleTriggerEnabled(trigger.id, trigger.enabled)
            }
          >
            {trigger.enabled ? "Pause" : "Resume"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => void onPromoteToWorkflow(automation)}
          >
            <GitBranch className="mr-1.5 h-3.5 w-3.5" />
            Compile to Workflow
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => openEditTrigger(trigger)}
          >
            {t("triggersview.Edit")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => {
              setForm({
                ...formFromTrigger(trigger),
                displayName: `${trigger.displayName} (copy)`,
              });
              setEditorOpen(true);
              setEditingId(null);
              setSelectedItemId(null);
              setSelectedItemKind(null);
            }}
          >
            {t("heartbeatsview.duplicate")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => void onRunSelectedTrigger(trigger.id)}
          >
            {t("triggersview.RunNow")}
          </Button>
        </div>
      </div>

      <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
            Schedule
          </dt>
          <dd className="mt-1 font-medium text-txt">
            {scheduleLabel(trigger, t, uiLanguage)}
          </dd>
        </PagePanel.SummaryCard>
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
            Last Run
          </dt>
          <dd className="mt-1 font-medium text-txt">
            {formatDateTime(trigger.lastRunAtIso, {
              fallback: "Not yet run",
              locale: uiLanguage,
            })}
          </dd>
        </PagePanel.SummaryCard>
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
            Next Run
          </dt>
          <dd className="mt-1 font-medium text-txt">
            {formatDateTime(trigger.nextRunAtMs, {
              fallback: "Not scheduled",
              locale: uiLanguage,
            })}
          </dd>
        </PagePanel.SummaryCard>
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
            Runs
          </dt>
          <dd className="mt-1 flex items-center gap-2 text-sm font-medium">
            <span className="text-txt">{selectedRuns.length}</span>
            {successCount > 0 && (
              <span className="text-ok">{successCount} ✓</span>
            )}
            {failureCount > 0 && (
              <span className="text-danger">{failureCount} ✗</span>
            )}
          </dd>
        </PagePanel.SummaryCard>
      </dl>

      <PagePanel variant="padded" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted">
            Run History
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs-tight"
            onClick={() => void loadTriggerRuns(trigger.id)}
          >
            {t("common.refresh")}
          </Button>
        </div>

        {!hasLoadedRuns ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted/70">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" />
            {t("databaseview.Loading")}
          </div>
        ) : selectedRuns.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted/60">
            {t("heartbeatsview.noRunsYetMessage")}
          </div>
        ) : (
          <div className="space-y-2">
            {selectedRuns.map((run) => (
              <div
                key={run.triggerRunId}
                className="rounded-lg border border-border/30 bg-bg/30 px-4 py-3"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <StatusBadge
                    label={localizedExecutionStatus(run.status, t)}
                    variant={toneForLastStatus(run.status)}
                  />
                  <span className="font-mono text-xs-tight text-muted/70">
                    {formatDateTime(run.startedAt, { locale: uiLanguage })}
                  </span>
                </div>
                <div className="text-xs-tight text-muted/80">
                  {formatDurationMs(run.latencyMs, { t })} &middot;{" "}
                  <span className="rounded bg-bg/40 px-1 py-0.5 font-mono text-muted/60">
                    {run.source}
                  </span>
                </div>
                {run.error && (
                  <div className="mt-2 whitespace-pre-wrap rounded-lg border border-danger/20 bg-danger/10 p-2 font-mono text-xs text-danger/90">
                    {run.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </PagePanel>

      <AutomationRoomChatPane
        assistantLabel={t("automations.chat.assistantLabel")}
        collapsed={chatCollapsed}
        composerRef={composerRef}
        metadata={metadata}
        onAutomationMutated={onAutomationMutated}
        onToggleCollapse={() => setChatCollapsed((value) => !value)}
        placeholder="Ask the coordinator to refine or convert this scheduled automation."
        systemAddendum={COORDINATOR_SYSTEM_ADDENDUM}
        title={automation.title}
      />

      <AutomationNodePalette
        nodes={nodes}
        title="Available Automation Nodes"
        subtitle="These nodes stay visible even when setup is missing so you can design the workflow shape before connecting services."
      />
    </div>
  );
}

function WorkflowAutomationDetailPane({
  automation,
  nodes,
  n8nStatus,
  workflowFetchError,
  workflowBusyId,
  workflowOpsBusy,
  onConversationResolved,
  onDeleteWorkflow,
  onRefreshWorkflows,
  onStartLocalN8n,
  onToggleWorkflowActive,
  onWorkflowMutated,
}: {
  automation: AutomationItem;
  nodes: AutomationNodeDescriptor[];
  n8nStatus: N8nStatusResponse | null;
  workflowFetchError: string | null;
  workflowBusyId: string | null;
  workflowOpsBusy: boolean;
  onConversationResolved: (conversation: Conversation) => void;
  onDeleteWorkflow: (item: AutomationItem) => Promise<void>;
  onRefreshWorkflows: () => Promise<void>;
  onStartLocalN8n: () => Promise<void>;
  onToggleWorkflowActive: (item: AutomationItem) => Promise<void>;
  onWorkflowMutated: () => void;
}) {
  const { activeConversationId, conversations, t, uiLanguage } = useApp();
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const bridgeConversationId = getAutomationBridgeIdForItem(
    automation,
    activeConversationId,
    conversations,
  );
  const metadata =
    automation.workflowId && !automation.isDraft
      ? buildWorkflowConversationMetadata(
          automation.workflowId,
          automation.title,
          bridgeConversationId,
        )
      : buildWorkflowDraftConversationMetadata(
          automation.draftId ?? createWorkflowDraftId(),
          bridgeConversationId,
        );
  const nodeCount = getWorkflowNodeCount(automation);
  const busy =
    workflowOpsBusy ||
    (automation.workflowId != null && workflowBusyId === automation.workflowId);

  return (
    <div className="space-y-6">
      <WorkflowRuntimeNotice
        status={n8nStatus}
        workflowFetchError={workflowFetchError}
        busy={busy}
        onRefresh={() => void onRefreshWorkflows()}
        onStartLocal={() => void onStartLocalN8n()}
      />

      <AutomationRoomChatPane
        assistantLabel={t("automations.chat.assistantLabel")}
        collapsed={chatCollapsed}
        composerRef={composerRef}
        metadata={metadata}
        onConversationResolved={onConversationResolved}
        onAutomationMutated={onWorkflowMutated}
        onToggleCollapse={() => setChatCollapsed((value) => !value)}
        placeholder={
          automation.isDraft
            ? "Describe the workflow you want to build."
            : "Refine or debug this workflow with the automation agent."
        }
        systemAddendum={WORKFLOW_SYSTEM_ADDENDUM}
        title={automation.title || WORKFLOW_DRAFT_TITLE}
      />

      <PagePanel variant="padded" className="space-y-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <FieldLabel variant="kicker">
                <Workflow className="mr-1.5 inline h-3.5 w-3.5" />
                {automation.isDraft ? "Workflow Draft" : "Workflow Automation"}
              </FieldLabel>
              <StatusBadge
                label={
                  automation.isDraft
                    ? "Draft"
                    : automation.enabled
                      ? "Active"
                      : "Paused"
                }
                variant={
                  automation.isDraft
                    ? "warning"
                    : automation.enabled
                      ? "success"
                      : "muted"
                }
                withDot
              />
              {automation.hasBackingWorkflow ? (
                <span className="rounded-full bg-ok/10 px-2 py-0.5 text-[11px] text-ok">
                  Backed by n8n
                </span>
              ) : (
                <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] text-warning">
                  Room only
                </span>
              )}
            </div>
            <h2 className="text-2xl font-semibold text-txt sm:text-[2rem]">
              {automation.title}
            </h2>
            <p className="text-sm leading-relaxed text-muted">
              {automation.description ||
                (automation.isDraft
                  ? "Develop this workflow in chat, then have the agent create and deploy the backing n8n workflow."
                  : "Workflow automation.")}
            </p>
          </div>

          {automation.workflow && automation.workflowId && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
              <Button
                variant="outline"
                size="sm"
                className={`h-8 px-3 text-xs ${
                  automation.workflow.active
                    ? "border-warning/30 text-warning hover:bg-warning/10"
                    : "border-ok/30 text-ok hover:bg-ok/10"
                }`}
                disabled={busy}
                onClick={() => void onToggleWorkflowActive(automation)}
              >
                {automation.workflow.active ? "Deactivate" : "Activate"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-3 text-xs border-danger/30 text-danger hover:bg-danger/10"
                disabled={busy}
                onClick={() => void onDeleteWorkflow(automation)}
              >
                Delete Workflow
              </Button>
            </div>
          )}
        </div>

        <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <PagePanel.SummaryCard className="px-4 py-4">
            <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
              Workflow ID
            </dt>
            <dd className="mt-1 break-all font-mono text-xs text-txt">
              {automation.workflowId ?? automation.draftId ?? "Pending"}
            </dd>
          </PagePanel.SummaryCard>
          <PagePanel.SummaryCard className="px-4 py-4">
            <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
              Nodes
            </dt>
            <dd className="mt-1 font-medium text-txt">{nodeCount}</dd>
          </PagePanel.SummaryCard>
          <PagePanel.SummaryCard className="px-4 py-4">
            <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
              Attached Schedules
            </dt>
            <dd className="mt-1 font-medium text-txt">
              {automation.schedules.length}
            </dd>
          </PagePanel.SummaryCard>
          <PagePanel.SummaryCard className="px-4 py-4">
            <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
              Updated
            </dt>
            <dd className="mt-1 font-medium text-txt">
              {formatDateTime(automation.updatedAt, {
                fallback: "Unknown",
                locale: uiLanguage,
              })}
            </dd>
          </PagePanel.SummaryCard>
        </dl>

        {automation.schedules.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">
              Workflow Schedules
            </div>
            <div className="space-y-2">
              {automation.schedules.map((schedule) => (
                <div
                  key={schedule.id}
                  className="rounded-lg border border-border/30 bg-bg/20 px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-medium text-txt">
                      {schedule.displayName}
                    </div>
                    <StatusBadge
                      label={schedule.enabled ? "Active" : "Paused"}
                      variant={schedule.enabled ? "success" : "muted"}
                      withDot
                    />
                  </div>
                  <div className="mt-1 text-sm text-muted">
                    {scheduleLabel(schedule, t, uiLanguage)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {automation.workflow?.nodes && automation.workflow.nodes.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">
              Backing Workflow Graph
            </div>
            <div className="space-y-2">
              {automation.workflow.nodes.map((node) => (
                <div
                  key={node.id ?? `${node.name}-${node.type}`}
                  className="flex items-center justify-between rounded-lg border border-border/30 bg-bg/20 px-4 py-3 text-sm"
                >
                  <span className="font-medium text-txt">
                    {node.name ?? "Unnamed node"}
                  </span>
                  <span className="font-mono text-xs text-muted">
                    {node.type?.split(".").pop() ?? "node"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </PagePanel>

      <AutomationNodePalette
        nodes={nodes}
        title="Workflow Node Catalog"
        subtitle="Runtime actions, providers, code-agent nodes, and owner-scoped LifeOps integrations are available here as workflow building blocks."
      />
    </div>
  );
}

function AutomationSidebarItem({
  item,
  selected,
  onClick,
  onDoubleClick,
}: {
  item: AutomationItem;
  selected: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
}) {
  const { t, uiLanguage } = useAutomationsViewContext();

  if (item.type === "n8n_workflow") {
    const nodeCount = getWorkflowNodeCount(item);
    return (
      <SidebarContent.Item
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        active={selected}
        className="h-auto"
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-1.5 truncate">
              <Workflow className="h-3 w-3 shrink-0 text-muted/60" />
              <span className="truncate text-sm font-semibold text-txt">
                {item.title}
              </span>
            </div>
            <StatusBadge
              label={
                item.isDraft ? "Draft" : item.enabled ? "Active" : "Paused"
              }
              variant={
                item.isDraft ? "warning" : item.enabled ? "success" : "muted"
              }
              withDot
            />
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2 text-xs-tight text-muted">
            <span className="truncate">
              {item.hasBackingWorkflow
                ? `${nodeCount} workflow nodes`
                : "Room draft or workflow shadow"}
            </span>
            {item.schedules.length > 0 && (
              <span>{item.schedules.length} schedule(s)</span>
            )}
          </div>
        </div>
      </SidebarContent.Item>
    );
  }

  if (item.trigger) {
    const trigger = item.trigger;
    return (
      <SidebarContent.Item
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        active={selected}
        className="h-auto"
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-1.5 truncate">
              <Clock3 className="h-3 w-3 shrink-0 text-muted/60" />
              <span className="truncate text-sm font-semibold text-txt">
                {item.title}
              </span>
            </div>
            <StatusBadge
              label={trigger.enabled ? "Active" : "Paused"}
              variant={trigger.enabled ? "success" : "muted"}
              withDot
            />
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2 text-xs-tight text-muted">
            <span className="truncate">
              {scheduleLabel(trigger, t, uiLanguage)}
            </span>
            {trigger.lastStatus && (
              <StatusBadge
                label={localizedExecutionStatus(trigger.lastStatus, t)}
                variant={toneForLastStatus(trigger.lastStatus)}
              />
            )}
          </div>
        </div>
      </SidebarContent.Item>
    );
  }

  if (item.task) {
    const task = item.task;
    return (
      <SidebarContent.Item
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        active={selected}
        className={`h-auto ${item.system ? "opacity-60" : ""}`}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-1.5 truncate">
              {item.system ? (
                <Settings className="h-3 w-3 shrink-0 text-muted/50" />
              ) : task.isCompleted ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-ok/60" />
              ) : (
                <Circle className="h-3 w-3 shrink-0 text-muted/60" />
              )}
              <span
                className={`truncate text-sm font-semibold ${
                  item.system
                    ? "text-muted"
                    : task.isCompleted
                      ? "text-muted line-through"
                      : "text-txt"
                }`}
              >
                {item.title}
              </span>
            </div>
            <StatusBadge
              label={
                item.system ? "System" : task.isCompleted ? "Done" : "Active"
              }
              variant={
                item.system ? "muted" : task.isCompleted ? "muted" : "success"
              }
              withDot
            />
          </div>
          {item.description && (
            <div className="mt-0.5 truncate text-xs-tight text-muted">
              {item.description}
            </div>
          )}
        </div>
      </SidebarContent.Item>
    );
  }

  return null;
}

function AutomationsLayout() {
  const { activeConversationId, conversations } = useApp();
  const ctx = useAutomationsViewContext();
  const {
    closeEditor,
    editorEnabled,
    editingId,
    editingTaskId,
    editorOpen,
    editorMode,
    form,
    formError,
    loadTriggerRuns,
    modalTitle,
    onDeleteTrigger,
    onRunSelectedTrigger,
    onSubmitTrigger,
    onToggleTriggerEnabled,
    openCreateTrigger,
    openCreateTask,
    saveFormAsTemplate,
    selectedItemId,
    setEditingId,
    setEditorOpen,
    setField,
    setFilter,
    setForm,
    setFormError,
    setSelectedItemId,
    setSelectedItemKind,
    showDetailPane,
    showFirstRunEmptyState,
    resolvedSelectedItem,
    t,
    templateNotice,
    triggers,
    filteredItems,
    triggerRunsById,
    triggersSaving,
    automationNodes,
    combinedError,
    isLoading,
    n8nStatus,
    workflowFetchError,
  } = ctx;
  const workflowComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [pageNotice, setPageNotice] = useState<string | null>(null);
  const [workflowBusyId, setWorkflowBusyId] = useState<string | null>(null);
  const [workflowOpsBusy, setWorkflowOpsBusy] = useState(false);
  const [activeWorkflowConversation, setActiveWorkflowConversation] =
    useState<Conversation | null>(null);
  const [templatesModalOpen, setTemplatesModalOpen] = useState(false);
  const [activeSubpage, setActiveSubpage] = useState<AutomationSubpage>(() =>
    getAutomationSubpageFromPath(getNavigationPathFromWindow()),
  );
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();

  const visibleItems = useMemo(() => {
    if (!normalizedSearchQuery) return filteredItems;
    return filteredItems.filter((item) =>
      getAutomationSearchText(item).includes(normalizedSearchQuery),
    );
  }, [filteredItems, normalizedSearchQuery]);

  const syncSubpageFromLocation = useCallback(() => {
    const pathname = getNavigationPathFromWindow();
    const nextSubpage = getAutomationSubpageFromPath(pathname);
    setActiveSubpage((previous) =>
      previous === nextSubpage ? previous : nextSubpage,
    );

    if (normalizeAutomationPath(pathname) === "/node-catalog") {
      syncAutomationSubpagePath("node-catalog", "replace");
    }
  }, []);

  useEffect(() => {
    syncSubpageFromLocation();
    window.addEventListener("popstate", syncSubpageFromLocation);
    window.addEventListener("hashchange", syncSubpageFromLocation);
    return () => {
      window.removeEventListener("popstate", syncSubpageFromLocation);
      window.removeEventListener("hashchange", syncSubpageFromLocation);
    };
  }, [syncSubpageFromLocation]);

  const showAutomationsList = useCallback(
    (mode: "push" | "replace" = "push") => {
      setActiveSubpage("list");
      syncAutomationSubpagePath("list", mode);
    },
    [],
  );

  const showNodeCatalog = useCallback(
    (mode: "push" | "replace" = "push") => {
      setEditorOpen(false);
      setEditingId(null);
      ctx.setEditingTaskId(null);
      setActiveSubpage("node-catalog");
      syncAutomationSubpagePath("node-catalog", mode);
    },
    [ctx, setEditingId, setEditorOpen],
  );

  const mobileSidebarLabel =
    activeSubpage === "node-catalog"
      ? "Node Catalog"
      : editorOpen || editingId || editingTaskId
        ? modalTitle
        : (resolvedSelectedItem?.title ?? "Automations");

  const selectItem = useCallback(
    (item: AutomationItem) => {
      showAutomationsList();
      setSelectedItemId(item.id);
      setSelectedItemKind(getSelectionKind(item));
      setEditorOpen(false);
      setEditingId(null);
      ctx.setEditingTaskId(null);
      if (item.trigger) {
        void loadTriggerRuns(item.trigger.id);
      }
    },
    [
      ctx,
      loadTriggerRuns,
      setEditingId,
      setEditorOpen,
      setSelectedItemId,
      setSelectedItemKind,
      showAutomationsList,
    ],
  );

  const findAutomationForConversation = useCallback(
    (
      data: AutomationListResponse | null,
      conversationId: string,
    ): AutomationItem | null =>
      data?.automations.find(
        (item) => item.room?.conversationId === conversationId,
      ) ?? null,
    [],
  );

  const refreshAutomationsWithDraftBinding = useCallback(
    async (
      draftConversation?: Conversation | null,
    ): Promise<AutomationListResponse | null> => {
      const previousWorkflowIds = new Set(
        ctx.allItems
          .filter(
            (item) =>
              item.type === "n8n_workflow" &&
              item.workflowId != null &&
              !item.isDraft,
          )
          .map((item) => item.workflowId as string),
      );

      const data = await ctx.refreshAutomations();
      if (
        !draftConversation ||
        draftConversation.metadata?.scope !== "automation-workflow-draft" ||
        draftConversation.metadata.automationType !== "n8n_workflow"
      ) {
        return data;
      }

      const createdWorkflows =
        data?.automations.filter(
          (item) =>
            item.type === "n8n_workflow" &&
            item.workflowId != null &&
            !item.isDraft &&
            !previousWorkflowIds.has(item.workflowId),
        ) ?? [];

      if (createdWorkflows.length !== 1) {
        return data;
      }

      const createdWorkflow = createdWorkflows[0];
      const reboundMetadata = buildWorkflowConversationMetadata(
        createdWorkflow.workflowId as string,
        createdWorkflow.title,
        draftConversation.metadata.terminalBridgeConversationId,
      );
      const { conversation } = await client.updateConversation(
        draftConversation.id,
        {
          title: createdWorkflow.title,
          metadata: reboundMetadata,
        },
      );
      setActiveWorkflowConversation(conversation);
      return await ctx.refreshAutomations();
    },
    [ctx],
  );

  const createWorkflowDraft = useCallback(
    async (options?: { initialPrompt?: string; title?: string }) => {
      setPageNotice(null);
      showAutomationsList();
      const draftId = createWorkflowDraftId();
      const bridgeConversationId = getAutomationBridgeIdForItem(
        resolvedSelectedItem,
        activeConversationId,
        conversations,
      );
      const metadata = buildWorkflowDraftConversationMetadata(
        draftId,
        bridgeConversationId,
      );

      try {
        const conversation = await resolveAutomationConversation({
          title: options?.title?.trim() || WORKFLOW_DRAFT_TITLE,
          metadata,
        });
        setActiveWorkflowConversation(conversation);

        if (options?.initialPrompt?.trim()) {
          await client.sendConversationMessage(
            conversation.id,
            `[SYSTEM]${WORKFLOW_SYSTEM_ADDENDUM}[/SYSTEM]\n\n${options.initialPrompt.trim()}`,
            "DM",
            undefined,
            undefined,
            buildAutomationResponseRoutingMetadata(metadata),
          );
        }

        const data = options?.initialPrompt
          ? await refreshAutomationsWithDraftBinding(conversation)
          : await ctx.refreshAutomations();
        const resolvedItem = findAutomationForConversation(
          data,
          conversation.id,
        );

        setFilter("workflows");
        setSelectedItemId(resolvedItem?.id ?? `workflow-draft:${draftId}`);
        setSelectedItemKind("workflow");
        setEditorOpen(false);
        setEditingId(null);
        ctx.setEditingTaskId(null);

        window.requestAnimationFrame(() => {
          workflowComposerRef.current?.focus();
        });
      } catch (error) {
        setPageNotice(
          error instanceof Error
            ? error.message
            : "Failed to create the workflow draft room.",
        );
      }
    },
    [
      activeConversationId,
      conversations,
      ctx,
      findAutomationForConversation,
      refreshAutomationsWithDraftBinding,
      resolvedSelectedItem,
      setEditingId,
      setEditorOpen,
      setFilter,
      setSelectedItemId,
      setSelectedItemKind,
      showAutomationsList,
    ],
  );

  const promoteAutomationToWorkflow = useCallback(
    async (item: AutomationItem) => {
      await createWorkflowDraft({
        title: `${item.title} Workflow`,
        initialPrompt: buildWorkflowCompilationPrompt(item),
      });
    },
    [createWorkflowDraft],
  );

  // Open a workflow draft and seed the composer with a template prompt.
  const handleTemplateSelected = useCallback(
    async (seedPrompt: string) => {
      setTemplatesModalOpen(false);
      // Create the draft room (no initialPrompt — user will refine it).
      await createWorkflowDraft();
      // Emit the seed-composer event so the ChatPane can prefill the textarea.
      window.dispatchEvent(
        new CustomEvent("milady:automations:seed-composer", {
          detail: { text: seedPrompt, select: true },
        }),
      );
    },
    [createWorkflowDraft],
  );

  // Open templates modal — disabled when n8n is not configured.
  const handleNewWorkflowCTA = useCallback(() => {
    showAutomationsList();
    setTemplatesModalOpen(true);
  }, [showAutomationsList]);

  // Zero-state: open trigger or task forms, switching filter first.
  const handleZeroStateNewTrigger = useCallback(() => {
    showAutomationsList();
    setFilter("scheduled");
    openCreateTrigger();
  }, [openCreateTrigger, setFilter, showAutomationsList]);

  const handleZeroStateNewTask = useCallback(() => {
    showAutomationsList();
    setFilter("coordinator");
    openCreateTask();
  }, [openCreateTask, setFilter, showAutomationsList]);

  const handleOpenCreateTask = useCallback(() => {
    showAutomationsList();
    openCreateTask();
  }, [openCreateTask, showAutomationsList]);

  const handleOpenCreateTrigger = useCallback(() => {
    showAutomationsList();
    openCreateTrigger();
  }, [openCreateTrigger, showAutomationsList]);

  const handleWorkflowMutated = useCallback(() => {
    void refreshAutomationsWithDraftBinding(activeWorkflowConversation);
  }, [activeWorkflowConversation, refreshAutomationsWithDraftBinding]);

  const handleRefreshWorkflows = useCallback(async () => {
    setPageNotice(null);
    const data = await refreshAutomationsWithDraftBinding(
      activeWorkflowConversation,
    );
    if (!data && ctx.automationsError) {
      setPageNotice(ctx.automationsError);
    }
  }, [
    activeWorkflowConversation,
    ctx.automationsError,
    refreshAutomationsWithDraftBinding,
  ]);

  const handleStartLocalN8n = useCallback(async () => {
    setWorkflowOpsBusy(true);
    setPageNotice(null);
    try {
      await client.startN8nSidecar();
      await ctx.refreshAutomations();
    } catch (error) {
      setPageNotice(
        error instanceof Error ? error.message : "Failed to start local n8n.",
      );
    } finally {
      setWorkflowOpsBusy(false);
    }
  }, [ctx]);

  const handleToggleWorkflowActive = useCallback(
    async (item: AutomationItem) => {
      if (!item.workflowId || !item.workflow) {
        return;
      }
      setWorkflowBusyId(item.workflowId);
      setPageNotice(null);
      try {
        if (item.workflow.active) {
          await client.deactivateN8nWorkflow(item.workflowId);
        } else {
          await client.activateN8nWorkflow(item.workflowId);
        }
        await ctx.refreshAutomations();
      } catch (error) {
        setPageNotice(
          error instanceof Error
            ? error.message
            : "Failed to update workflow state.",
        );
      } finally {
        setWorkflowBusyId(null);
      }
    },
    [ctx],
  );

  const handleDeleteWorkflow = useCallback(
    async (item: AutomationItem) => {
      if (!item.workflowId) {
        return;
      }
      const confirmed = await confirmDesktopAction({
        title: "Delete Workflow",
        message: `Delete ${item.title}?`,
        confirmLabel: "Delete Workflow",
        cancelLabel: t("common.cancel"),
        type: "warning",
      });
      if (!confirmed) return;

      setWorkflowBusyId(item.workflowId);
      setPageNotice(null);
      try {
        await client.deleteN8nWorkflow(item.workflowId);
        await ctx.refreshAutomations();
      } catch (error) {
        setPageNotice(
          error instanceof Error ? error.message : "Failed to delete workflow.",
        );
      } finally {
        setWorkflowBusyId(null);
      }
    },
    [ctx, t],
  );

  const automationsSidebar = (
    <Sidebar
      testId="automations-sidebar"
      collapsible
      contentIdentity="automations"
      collapseButtonTestId="automations-sidebar-collapse-toggle"
      expandButtonTestId="automations-sidebar-expand-toggle"
      collapseButtonAriaLabel="Collapse automations"
      expandButtonAriaLabel="Expand automations"
      header={null}
      collapsedRailAction={
        <SidebarCollapsedActionButton
          aria-label="New coordinator automation"
          onClick={handleOpenCreateTask}
        >
          <Plus className="h-4 w-4" />
        </SidebarCollapsedActionButton>
      }
      collapsedRailItems={visibleItems.map((item) => (
        <SidebarContent.RailItem
          key={item.id}
          aria-label={item.title}
          title={item.title}
          active={item.id === selectedItemId}
          indicatorTone={getAutomationIndicatorTone(item)}
          onClick={() => selectItem(item)}
        >
          {railMonogram(item.title)}
        </SidebarContent.RailItem>
      ))}
    >
      <SidebarScrollRegion>
        <SidebarPanel>
          <div className="mb-3 space-y-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search automations"
              aria-label="Search automations"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-border/30 bg-bg/30 px-3 py-1.5 text-sm text-txt placeholder:text-muted/50 focus:border-accent/40 focus:outline-none"
            />

            {/* Primary CTA: New Workflow */}
            {n8nStatus?.mode === "disabled" ? (
              <TooltipHint
                content={t("automations.newWorkflowDisabled", {
                  defaultValue:
                    "Enable Automations in Settings to create workflows",
                })}
                side="right"
              >
                <Button
                  variant="default"
                  size="sm"
                  className="w-full h-8 gap-1.5 px-3 text-xs font-medium opacity-50 cursor-not-allowed"
                  disabled
                >
                  <Workflow className="h-3.5 w-3.5" />
                  {t("automations.newWorkflowCTA", {
                    defaultValue: "+ New Workflow",
                  })}
                </Button>
              </TooltipHint>
            ) : (
              <Button
                variant="default"
                size="sm"
                className="w-full h-8 gap-1.5 px-3 text-xs font-medium"
                onClick={handleNewWorkflowCTA}
              >
                <Workflow className="h-3.5 w-3.5" />
                {t("automations.newWorkflowCTA", {
                  defaultValue: "+ New Workflow",
                })}
              </Button>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 px-3 text-xs font-medium"
                onClick={handleOpenCreateTask}
              >
                <SquareTerminal className="h-3.5 w-3.5" />
                Coordinator
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1 px-3 text-xs font-medium"
                onClick={handleOpenCreateTrigger}
              >
                <Clock3 className="h-3.5 w-3.5" />
                Schedule
              </Button>
              <Button
                variant={
                  activeSubpage === "node-catalog" ? "default" : "outline"
                }
                size="sm"
                className="h-8 gap-1 px-3 text-xs font-medium"
                onClick={() => showNodeCatalog()}
              >
                <Grid3x3 className="h-3.5 w-3.5" />
                Node Catalog
              </Button>
            </div>
          </div>

          <FilterTabs />

          {isLoading && (
            <SidebarContent.Notice
              icon={
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" />
              }
            >
              {t("common.loading")}
            </SidebarContent.Notice>
          )}

          {!isLoading && normalizedSearchQuery && visibleItems.length === 0 ? (
            <SidebarContent.EmptyState className="px-4 py-6">
              No matching automations
            </SidebarContent.EmptyState>
          ) : (
            visibleItems.map((item) => (
              <AutomationSidebarItem
                key={item.id}
                item={item}
                selected={selectedItemId === item.id}
                onClick={() => selectItem(item)}
                onDoubleClick={
                  item.task && !item.system
                    ? () => {
                        showAutomationsList();
                        ctx.openEditTask(item.task as WorkbenchTask);
                      }
                    : item.trigger
                      ? () => {
                          showAutomationsList();
                          ctx.openEditTrigger(item.trigger as TriggerSummary);
                          void loadTriggerRuns(
                            (item.trigger as TriggerSummary).id,
                          );
                        }
                      : undefined
                }
              />
            ))
          )}
        </SidebarPanel>
      </SidebarScrollRegion>
    </Sidebar>
  );

  return (
    <PageLayout
      className="h-full bg-transparent"
      data-testid="automations-shell"
      sidebar={automationsSidebar}
      contentInnerClassName="mx-auto w-full max-w-[96rem]"
      footer={<WidgetHost slot="automations" className="py-3" />}
      mobileSidebarLabel={mobileSidebarLabel}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {activeSubpage === "node-catalog" || showDetailPane ? (
          <button
            type="button"
            className="mb-3 flex items-center gap-2 rounded-2xl border border-border/30 bg-bg/25 px-4 py-3 text-base font-medium text-muted hover:text-txt md:hidden"
            onClick={() => {
              if (activeSubpage === "node-catalog") {
                showAutomationsList();
                return;
              }
              setSelectedItemId(null);
              setSelectedItemKind(null);
              setEditorOpen(false);
              setEditingId(null);
              ctx.setEditingTaskId(null);
            }}
          >
            ← Back
          </button>
        ) : null}

        {(pageNotice || combinedError) && (
          <PagePanel
            variant="padded"
            className="mb-4 border border-danger/20 bg-danger/5"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-danger">
                {pageNotice ?? combinedError}
              </p>
              {pageNotice && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:bg-danger/10"
                  onClick={() => setPageNotice(null)}
                >
                  Dismiss
                </Button>
              )}
            </div>
          </PagePanel>
        )}

        {editorOpen || editingId || editingTaskId ? (
          editorMode === "task" || editingTaskId ? (
            <TaskForm />
          ) : (
            <HeartbeatForm
              form={form}
              editingId={editingId}
              editorEnabled={editorEnabled}
              modalTitle={modalTitle}
              formError={formError}
              triggersSaving={triggersSaving}
              templateNotice={templateNotice}
              triggers={triggers}
              triggerRunsById={triggerRunsById}
              t={t}
              selectedTriggerId={editingId}
              setField={setField}
              setForm={setForm}
              setFormError={setFormError}
              closeEditor={closeEditor}
              onSubmit={onSubmitTrigger}
              onDelete={onDeleteTrigger}
              onRunSelectedTrigger={onRunSelectedTrigger}
              onToggleTriggerEnabled={onToggleTriggerEnabled}
              saveFormAsTemplate={saveFormAsTemplate}
              loadTriggerRuns={loadTriggerRuns}
            />
          )
        ) : activeSubpage === "node-catalog" ? (
          <AutomationNodeCatalogPane nodes={automationNodes} />
        ) : resolvedSelectedItem?.type === "n8n_workflow" ? (
          <WorkflowAutomationDetailPane
            key={resolvedSelectedItem.id}
            automation={resolvedSelectedItem}
            nodes={automationNodes}
            n8nStatus={n8nStatus}
            workflowFetchError={workflowFetchError}
            workflowBusyId={workflowBusyId}
            workflowOpsBusy={workflowOpsBusy}
            onConversationResolved={setActiveWorkflowConversation}
            onDeleteWorkflow={handleDeleteWorkflow}
            onRefreshWorkflows={handleRefreshWorkflows}
            onStartLocalN8n={handleStartLocalN8n}
            onToggleWorkflowActive={handleToggleWorkflowActive}
            onWorkflowMutated={handleWorkflowMutated}
          />
        ) : resolvedSelectedItem?.trigger ? (
          <TriggerAutomationDetailPane
            key={resolvedSelectedItem.id}
            automation={resolvedSelectedItem}
            nodes={automationNodes}
            onAutomationMutated={() => {
              void ctx.refreshAutomations();
            }}
            onPromoteToWorkflow={promoteAutomationToWorkflow}
          />
        ) : resolvedSelectedItem?.task ? (
          <TaskAutomationDetailPane
            key={resolvedSelectedItem.id}
            automation={resolvedSelectedItem}
            nodes={automationNodes}
            onAutomationMutated={() => {
              void ctx.refreshAutomations();
            }}
            onPromoteToWorkflow={promoteAutomationToWorkflow}
          />
        ) : showFirstRunEmptyState ? (
          <AutomationsZeroState
            onBrowseTemplates={() => setTemplatesModalOpen(true)}
            onNewTrigger={handleZeroStateNewTrigger}
            onNewTask={handleZeroStateNewTask}
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10 text-center">
            <div className="space-y-3">
              <h3 className="text-lg font-semibold text-txt-strong">
                Select an automation
              </h3>
            </div>
          </div>
        )}
      </div>

      <WorkflowTemplatesModal
        open={templatesModalOpen}
        onOpenChange={setTemplatesModalOpen}
        onSelectTemplate={(seedPrompt) =>
          void handleTemplateSelected(seedPrompt)
        }
        onSelectCustom={() => {
          setTemplatesModalOpen(false);
          void createWorkflowDraft();
        }}
      />
    </PageLayout>
  );
}

export function AutomationsView() {
  const controller = useAutomationsViewController();
  return (
    <AutomationsViewContext.Provider value={controller}>
      <AutomationsLayout />
    </AutomationsViewContext.Provider>
  );
}

export function AutomationsDesktopShell() {
  return <AutomationsView />;
}
