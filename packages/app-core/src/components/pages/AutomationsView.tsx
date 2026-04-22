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
} from "@elizaos/ui";
import {
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Copy,
  Edit as EditIcon,
  FileText,
  GitBranch,
  Grid3x3,
  LayoutDashboard,
  type LucideIcon,
  Mail,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rss,
  Settings,
  Share2,
  Signal,
  SquareTerminal,
  Trash2,
  Workflow,
  Zap,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
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
import { AppWorkspaceChrome } from "../workspace/AppWorkspaceChrome";
import {
  buildAutomationDraftConversationMetadata,
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
import {
  VISUALIZE_WORKFLOW_EVENT,
  type VisualizeWorkflowEventDetail,
} from "./workflow-graph-events";

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

const AUTOMATION_DRAFT_TITLE = "New automation";
const AUTOMATION_DRAFT_SYSTEM_ADDENDUM =
  "You are in an automation-creation room. The user wants to create one " +
  "automation. Decide the right shape based on their description and call " +
  "the matching action exactly once:\n" +
  '- Recurring prompt or schedule, for example "every morning summarize my inbox": ' +
  "CREATE_TRIGGER_TASK with a clear displayName, instructions, and schedule.\n" +
  '- Goal to work toward until done, for example "figure out the onboarding refactor": ' +
  "CREATE_TASK with name and description.\n" +
  '- Deterministic pipeline of integration steps, for example "when a Slack message matches X, post to Discord": ' +
  "create an n8n workflow via the n8n actions.\n" +
  "Ask one short clarifying question only if the shape is genuinely " +
  "ambiguous; otherwise create immediately. After creation, briefly " +
  "confirm what you made and how to run it.";

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
          error instanceof Error
            ? error.message
            : t("automations.loadFailed", {
                defaultValue: "Failed to load automations.",
              }),
        );
        return null;
      } finally {
        setAutomationsLoaded(true);
        setAutomationsLoading(false);
      }
    }, [t]);

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
          error instanceof Error
            ? error.message
            : t("automations.taskCreateFailed", {
                defaultValue: "Failed to create task.",
              }),
        );
        return null;
      } finally {
        setTaskSaving(false);
      }
    },
    [refreshAutomations, t],
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
          error instanceof Error
            ? error.message
            : t("automations.taskUpdateFailed", {
                defaultValue: "Failed to update task.",
              }),
        );
        return null;
      } finally {
        setTaskSaving(false);
      }
    },
    [refreshAutomations, t],
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
          error instanceof Error
            ? error.message
            : t("automations.taskDeleteFailed", {
                defaultValue: "Failed to delete task.",
              }),
        );
        return false;
      } finally {
        setTaskSaving(false);
      }
    },
    [refreshAutomations, t],
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
    if (!preferred) return;
    const item = allItems.find((candidate) => candidate.id === preferred);
    if (!item) return;
    setSelectedItemId(preferred);
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
      setFormError(
        t("automations.nameRequired", {
          defaultValue: "Name is required.",
        }),
      );
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
      title: t("automations.taskDeleteTitle", {
        defaultValue: "Delete task",
      }),
      message: t("automations.taskDeleteMessage", {
        defaultValue: "Are you sure you want to delete this task?",
      }),
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
            name:
              form.displayName.trim() ||
              t("automations.taskLabel", {
                defaultValue: "Task",
              }),
            defaultValue: "Edit {{name}}",
          })
        : t("automations.newSchedule", {
            defaultValue: "New schedule",
          })
      : editingTaskId
        ? t("automations.editCoordinator", {
            defaultValue: "Edit coordinator",
          })
        : t("automations.newCoordinator", {
            defaultValue: "New coordinator",
          });

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

function AutomationCollapsibleSection({
  sectionKey,
  label,
  icon,
  count,
  collapsed,
  onToggleCollapsed,
  onAdd,
  addLabel,
  emptyLabel,
  children,
}: {
  sectionKey: string;
  label: string;
  icon: ReactNode;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: (key: string) => void;
  onAdd?: () => void;
  addLabel?: string;
  emptyLabel: string;
  children: ReactNode;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section
      data-testid={`automation-section-${sectionKey}`}
      className="group/section space-y-0"
    >
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={() => onToggleCollapsed(sectionKey)}
          aria-expanded={!collapsed}
          className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] bg-transparent px-1.5 py-1 text-left text-2xs font-semibold uppercase tracking-[0.16em] text-muted transition-colors hover:text-txt"
        >
          <span className="inline-flex shrink-0 items-center justify-center text-muted">
            {icon}
          </span>
          <span className="truncate">{label}</span>
          <span className="ml-0.5 text-muted/60 tabular-nums">{count}</span>
          <Chevron aria-hidden className="ml-auto h-3 w-3 shrink-0 text-muted opacity-0 transition-opacity group-hover/section:opacity-100 focus-visible:opacity-100" />
        </button>
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            aria-label={addLabel ?? "Add"}
            title={addLabel}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {collapsed ? null : count === 0 ? (
        <div className="px-3 py-1 text-2xs text-muted/70">{emptyLabel}</div>
      ) : (
        <div className="space-y-0">{children}</div>
      )}
    </section>
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
          <FieldLabel>{t("common.name", { defaultValue: "Name" })}</FieldLabel>
          <Input
            value={taskFormName}
            onChange={(event) => setTaskFormName(event.target.value)}
            placeholder={t("automations.coordinatorNamePlaceholder", {
              defaultValue: "Coordinator automation name...",
            })}
            autoFocus
          />
        </div>
        <div>
          <FieldLabel>
            {t("common.description", { defaultValue: "Description" })}
          </FieldLabel>
          <Textarea
            value={taskFormDescription}
            onChange={(event) => setTaskFormDescription(event.target.value)}
            placeholder={t("automations.coordinatorDescriptionPlaceholder", {
              defaultValue: "What should the coordinator do...",
            })}
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
          {editingTaskId
            ? t("automations.saveCoordinator", {
                defaultValue: "Save coordinator",
              })
            : t("automations.createCoordinator", {
                defaultValue: "Create coordinator",
              })}
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
  // Auto-start kicks the local sidecar at runtime boot. While it is
  // starting (or briefly stopped before the first tick), suppress the
  // alarm UI — the fetch error is expected and resolves itself.
  const isAutoStarting =
    status?.mode === "local" &&
    (status.status === "starting" || status.status === "stopped");

  if (!status && !workflowFetchError) {
    return null;
  }

  if (status?.mode === "disabled") {
    return (
      <div className="mb-2 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border/25 bg-bg/30 px-3 py-1.5 text-xs-tight">
        <span className="text-muted">
          Workflow deploy requires n8n. Coordinator automations still work.
        </span>
        {status.platform !== "mobile" && (
          <button
            type="button"
            disabled={busy}
            onClick={onStartLocal}
            className="text-2xs font-semibold uppercase tracking-[0.12em] text-accent hover:text-accent/80 disabled:opacity-50"
          >
            Enable
          </button>
        )}
      </div>
    );
  }

  if (isAutoStarting) {
    return (
      <div className="mb-2 flex items-center gap-2 px-3 py-1 text-2xs text-muted/70">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
        <span>Starting local n8n…</span>
      </div>
    );
  }

  if (workflowFetchError) {
    return (
      <div className="mb-2 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-danger/25 bg-danger/5 px-3 py-1.5 text-xs-tight">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
          <span className="truncate text-danger/90">{workflowFetchError}</span>
        </div>
        <div className="flex items-center gap-3">
          {status?.mode === "local" && status.status !== "ready" && (
            <button
              type="button"
              disabled={busy}
              onClick={onStartLocal}
              className="text-2xs font-semibold uppercase tracking-[0.12em] text-danger hover:text-danger/80 disabled:opacity-50"
            >
              Restart
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onRefresh}
            className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted hover:text-txt disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  if (status?.mode === "local" && status.status === "error") {
    return (
      <div className="mb-2 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-danger/25 bg-danger/5 px-3 py-1.5 text-xs-tight">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
          <span className="text-danger/90">Local n8n failed to start.</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onStartLocal}
            className="text-2xs font-semibold uppercase tracking-[0.12em] text-danger hover:text-danger/80 disabled:opacity-50"
          >
            Retry
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onRefresh}
            className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted hover:text-txt disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  if (status?.mode === "cloud" && status.cloudHealth === "degraded") {
    return (
      <div className="mb-2 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-warning/25 bg-warning/5 px-3 py-1.5 text-xs-tight">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
          <span className="text-warning">
            Eliza Cloud workflow gateway is degraded.
          </span>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={onRefresh}
          className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted hover:text-txt disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
    );
  }

  return null;
}

function AutomationNodePalette({
  nodes,
  title,
}: {
  nodes: AutomationNodeDescriptor[];
  title: string;
}) {
  const groupedNodes = useMemo(
    () =>
      NODE_CLASS_ORDER.map((className) => ({
        className,
        nodes: nodes.filter((node) => node.class === className),
      })).filter((group) => group.nodes.length > 0),
    [nodes],
  );

  const enabledCount = nodes.filter((n) => n.availability === "enabled").length;
  const disabledCount = nodes.filter((n) => n.availability === "disabled").length;

  return (
    <section className="rounded-[var(--radius-sm)] border border-border/25 bg-bg/20">
      <div className="flex items-center justify-between gap-2 border-b border-border/20 px-3 py-1.5">
        <div className="flex items-center gap-2 text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
          <span>{title}</span>
          <span className="text-muted/50">{nodes.length}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] tabular-nums">
          <span className="text-ok">{enabledCount}</span>
          <span className="text-muted/40">·</span>
          <span className="text-warning">{disabledCount}</span>
        </div>
      </div>

      <div className="space-y-2 px-2 py-2">
        {groupedNodes.map((group) => (
          <div key={group.className}>
            <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted/60">
              {getNodeClassLabel(group.className)}
            </div>
            <div className="grid gap-1 sm:grid-cols-2 xl:grid-cols-3">
              {group.nodes.map((node) => (
                <div
                  key={node.id}
                  title={
                    node.disabledReason || node.description || node.label
                  }
                  className={`flex items-center gap-2 rounded-[var(--radius-sm)] border px-2 py-1 text-xs-tight ${
                    node.availability === "enabled"
                      ? "border-border/20 bg-bg/30"
                      : "border-warning/20 bg-warning/5"
                  }`}
                >
                  <span
                    className={
                      node.availability === "enabled"
                        ? "text-accent/80"
                        : "text-warning"
                    }
                  >
                    {getNodeIcon(node)}
                  </span>
                  <span className="truncate text-txt">{node.label}</span>
                  {node.ownerScoped && (
                    <span className="ml-auto text-[9px] uppercase tracking-wider text-muted/60">
                      owner
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AutomationNodeCatalogPane({
  nodes,
}: {
  nodes: AutomationNodeDescriptor[];
}) {
  return <AutomationNodePalette nodes={nodes} title="Node catalog" />;
}

function TaskAutomationDetailPane({
  automation,
  nodes,
  onPromoteToWorkflow,
}: {
  automation: AutomationItem;
  nodes: AutomationNodeDescriptor[];
  onPromoteToWorkflow: (item: AutomationItem) => Promise<void>;
}) {
  const { openEditTask, onDeleteTask, onToggleTaskCompleted, t } =
    useAutomationsViewContext();
  const task = automation.task;

  if (!task) {
    return null;
  }

  const statusLabel = automation.system
    ? "System"
    : task.isCompleted
      ? "Completed"
      : "Active";
  const statusTone: "success" | "warning" | "muted" | "danger" = automation.system
    ? "muted"
    : task.isCompleted
      ? "muted"
      : "success";

  return (
    <div className="space-y-3">
      <DetailHeader
        icon={
          automation.system ? (
            <Settings className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <SquareTerminal className="h-3.5 w-3.5" aria-hidden />
          )
        }
        title={automation.title}
        description={automation.description}
        statusLabel={statusLabel}
        statusTone={statusTone}
        actions={
          !automation.system ? (
            <>
              <IconAction
                label={task.isCompleted ? "Reopen" : "Complete"}
                onClick={() =>
                  void onToggleTaskCompleted(task.id, task.isCompleted)
                }
                icon={
                  task.isCompleted ? (
                    <Circle className="h-3.5 w-3.5" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )
                }
                tone={task.isCompleted ? "ok" : undefined}
              />
              <IconAction
                label="Compile to Workflow"
                onClick={() => void onPromoteToWorkflow(automation)}
                icon={<GitBranch className="h-3.5 w-3.5" />}
              />
              <IconAction
                label={t("triggersview.Edit")}
                onClick={() => openEditTask(task)}
                icon={<EditIcon className="h-3.5 w-3.5" />}
              />
              <IconAction
                label={t("triggersview.Delete")}
                onClick={() => void onDeleteTask(task.id)}
                icon={<Trash2 className="h-3.5 w-3.5" />}
                tone="danger"
              />
            </>
          ) : null
        }
      />
      {task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-1">
          {task.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-bg/50 px-1.5 py-0.5 text-[10px] text-muted"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <AutomationNodePalette nodes={nodes} title="Automation nodes" />
    </div>
  );
}

const AUTOMATION_DRAFT_EXAMPLES: Array<{
  icon: LucideIcon;
  label: string;
  prompt: string;
}> = [
  {
    icon: Mail,
    label: "Daily inbox digest",
    prompt:
      "Every weekday at 9am, summarize my Gmail inbox from the last 24 hours and post the summary to my #daily channel in Slack.",
  },
  {
    icon: Clock3,
    label: "Hourly health check",
    prompt:
      "Every hour, review recent activity, check that nothing is stuck or errored, and notify me if anything needs attention.",
  },
  {
    icon: GitBranch,
    label: "GitHub issue triage",
    prompt:
      "When a new issue is opened on my GitHub repo, classify it (bug / feature / question / docs), add the matching label, and post a welcoming comment.",
  },
  {
    icon: SquareTerminal,
    label: "Goal: ship onboarding",
    prompt:
      "Help me ship the onboarding refactor: track subtasks, surface blockers, and check in with me daily until it's done.",
  },
];

function formatRelativeFuture(
  targetMs: number,
  t?: (key: string, options?: { defaultValue?: string; value?: number }) => string,
): string {
  const delta = targetMs - Date.now();
  if (delta <= 0) return "now";
  return `in ${formatDurationMs(delta, { t })}`;
}

function formatRelativePast(
  iso: string | number | null | undefined,
  t?: (key: string, options?: { defaultValue?: string; value?: number }) => string,
): string {
  if (!iso) return "—";
  const ts = typeof iso === "string" ? Date.parse(iso) : iso;
  if (!Number.isFinite(ts)) return "—";
  const delta = Date.now() - ts;
  if (delta < 0) return "now";
  return `${formatDurationMs(delta, { t })} ago`;
}

function AutomationsDashboard({
  items,
  onSelectItem,
  onCreateDraft,
}: {
  items: AutomationItem[];
  onSelectItem: (item: AutomationItem) => void;
  onCreateDraft: () => void;
}) {
  const { t } = useAutomationsViewContext();
  const now = Date.now();

  const visibleItems = useMemo(
    () => items.filter((item) => !item.system),
    [items],
  );

  const triggerItems = useMemo(
    () => visibleItems.filter((item): item is AutomationItem & { trigger: TriggerSummary } =>
      item.trigger != null,
    ),
    [visibleItems],
  );

  const activeCount = visibleItems.filter(
    (item) => item.enabled && !item.isDraft,
  ).length;
  const failingCount = triggerItems.filter(
    (item) => toneForLastStatus(item.trigger.lastStatus) === "danger",
  ).length;
  const draftCount = visibleItems.filter((item) => item.isDraft).length;
  const totalCount = visibleItems.filter((item) => !item.isDraft).length;

  const upcoming = useMemo(
    () =>
      triggerItems
        .filter(
          (item) =>
            item.trigger.enabled &&
            typeof item.trigger.nextRunAtMs === "number" &&
            item.trigger.nextRunAtMs > now,
        )
        .sort(
          (a, b) =>
            (a.trigger.nextRunAtMs ?? 0) - (b.trigger.nextRunAtMs ?? 0),
        )
        .slice(0, 6),
    [triggerItems, now],
  );

  const recent = useMemo(
    () =>
      triggerItems
        .filter((item) => item.trigger.lastRunAtIso)
        .sort((a, b) => {
          const aTs = a.trigger.lastRunAtIso
            ? Date.parse(a.trigger.lastRunAtIso)
            : 0;
          const bTs = b.trigger.lastRunAtIso
            ? Date.parse(b.trigger.lastRunAtIso)
            : 0;
          return bTs - aTs;
        })
        .slice(0, 6),
    [triggerItems],
  );

  const failures = useMemo(
    () =>
      triggerItems
        .filter(
          (item) => toneForLastStatus(item.trigger.lastStatus) === "danger",
        )
        .slice(0, 5),
    [triggerItems],
  );

  if (totalCount === 0 && draftCount === 0) {
    return (
      <div className="space-y-3 px-2 pt-6 text-center">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-txt">
            No automations yet
          </h2>
          <p className="text-xs-tight text-muted/80">
            Click + to describe one in chat — Eliza picks the right shape.
          </p>
        </div>
        <button
          type="button"
          onClick={onCreateDraft}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-accent/15 px-3 py-1.5 text-xs-tight font-semibold text-accent hover:bg-accent/25"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          New automation
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <DetailStatsRow
        items={[
          { label: "Total", value: totalCount },
          {
            label: "Active",
            value: (
              <span className="text-ok tabular-nums">{activeCount}</span>
            ),
          },
          {
            label: "Failing",
            value:
              failingCount > 0 ? (
                <span className="text-danger tabular-nums">
                  {failingCount}
                </span>
              ) : (
                <span className="text-muted tabular-nums">0</span>
              ),
          },
          {
            label: "Drafts",
            value: <span className="tabular-nums">{draftCount}</span>,
          },
          {
            label: "Next",
            value:
              upcoming.length > 0 && upcoming[0].trigger.nextRunAtMs
                ? formatRelativeFuture(upcoming[0].trigger.nextRunAtMs, t)
                : "—",
          },
        ]}
      />

      {failures.length > 0 && (
        <DetailSection title={`Failing (${failures.length})`}>
          <div className="divide-y divide-border/20">
            {failures.map(({ id, title, trigger }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  const found = items.find((it) => it.id === id);
                  if (found) onSelectItem(found);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs-tight hover:bg-bg-muted/40"
              >
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-hidden />
                <span className="truncate font-medium text-txt">{title}</span>
                <span className="ml-auto text-muted/70 tabular-nums">
                  {formatRelativePast(trigger.lastRunAtIso, t)}
                </span>
                {trigger.lastError ? (
                  <span className="basis-full truncate pl-4 text-[11px] text-danger/80">
                    {trigger.lastError}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </DetailSection>
      )}

      {upcoming.length > 0 && (
        <DetailSection title="Upcoming">
          <div className="divide-y divide-border/20">
            {upcoming.map(({ id, title, trigger }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  const found = items.find((it) => it.id === id);
                  if (found) onSelectItem(found);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs-tight hover:bg-bg-muted/40"
              >
                <Clock3 className="h-3.5 w-3.5 shrink-0 text-muted/60" aria-hidden />
                <span className="truncate text-txt">{title}</span>
                <span className="ml-auto text-muted tabular-nums">
                  {trigger.nextRunAtMs
                    ? formatRelativeFuture(trigger.nextRunAtMs, t)
                    : "—"}
                </span>
              </button>
            ))}
          </div>
        </DetailSection>
      )}

      {recent.length > 0 && (
        <DetailSection title="Recent runs">
          <div className="divide-y divide-border/20">
            {recent.map(({ id, title, trigger }) => {
              const tone = toneForLastStatus(trigger.lastStatus);
              const dotClass =
                tone === "success"
                  ? "bg-ok"
                  : tone === "danger"
                    ? "bg-danger"
                    : tone === "warning"
                      ? "bg-warning"
                      : "bg-muted/50";
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    const found = items.find((it) => it.id === id);
                    if (found) onSelectItem(found);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs-tight hover:bg-bg-muted/40"
                >
                  <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} aria-hidden />
                  <span className="truncate text-txt">{title}</span>
                  <span className="ml-auto text-muted/70 tabular-nums">
                    {formatRelativePast(trigger.lastRunAtIso, t)}
                  </span>
                </button>
              );
            })}
          </div>
        </DetailSection>
      )}

      {totalCount > 0 && upcoming.length === 0 && recent.length === 0 && (
        <div className="px-3 py-4 text-center text-xs-tight text-muted/70">
          No scheduled runs yet. Select an automation to run one manually.
        </div>
      )}
    </div>
  );
}

function AutomationDraftPane({
  automation,
  onPromptSubmit,
  onPromptSent,
}: {
  automation: AutomationItem;
  onPromptSubmit: (prompt: string) => void;
  onPromptSent?: () => void;
}) {
  const conversationId = automation.room?.conversationId ?? null;
  const [sendError, setSendError] = useState<string | null>(null);

  const sendPrompt = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      setSendError(null);
      if (!conversationId) {
        onPromptSubmit(trimmed);
        return;
      }
      try {
        await client.sendConversationMessage(
          conversationId,
          `[SYSTEM]${AUTOMATION_DRAFT_SYSTEM_ADDENDUM}[/SYSTEM]\n\n${trimmed}`,
          "DM",
        );
        onPromptSent?.();
      } catch (error) {
        setSendError(
          error instanceof Error
            ? error.message
            : "Failed to send automation prompt.",
        );
      }
    },
    [conversationId, onPromptSent, onPromptSubmit],
  );

  return (
    <div className="space-y-4 px-4 pt-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-txt">
          What would you like to automate?
        </h2>
        <p className="text-xs-tight text-muted/80">
          Describe it in chat. Eliza will pick the right shape — a recurring
          prompt, a goal-oriented task, or a deterministic workflow — and set
          it up.
        </p>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {AUTOMATION_DRAFT_EXAMPLES.map((example) => {
          const Icon = example.icon;
          return (
            <button
              key={example.label}
              type="button"
              onClick={() => void sendPrompt(example.prompt)}
              className="group flex items-start gap-2 rounded-[var(--radius-sm)] border border-border/25 bg-bg/30 px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-accent/5"
            >
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent/80" aria-hidden />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-xs-tight font-semibold text-txt">
                  {example.label}
                </div>
                <div className="line-clamp-2 text-[11px] leading-snug text-muted/70">
                  {example.prompt}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <p className="px-1 text-[11px] text-muted/60">
        Or describe your own automation in the chat panel on the right.
      </p>
      {sendError ? (
        <div className="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 px-3 py-2 text-xs-tight text-danger">
          {sendError}
        </div>
      ) : null}
    </div>
  );
}

function IconAction({
  icon,
  label,
  onClick,
  tone,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  tone?: "ok" | "warning" | "danger";
  disabled?: boolean;
}) {
  const toneClass =
    tone === "warning"
      ? "text-warning hover:bg-warning/10"
      : tone === "ok"
        ? "text-ok hover:bg-ok/10"
        : tone === "danger"
          ? "text-danger hover:bg-danger/10"
          : "text-muted hover:text-txt hover:bg-bg-muted/50";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClass}`}
    >
      {icon}
    </button>
  );
}

function DetailHeader({
  icon,
  title,
  description,
  statusLabel,
  statusTone,
  actions,
}: {
  icon: ReactNode;
  title: string;
  description?: string | null;
  statusLabel: string;
  statusTone: "success" | "warning" | "muted" | "danger";
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border/20 pb-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5 text-muted">
          {icon}
          <h2 className="truncate text-base font-semibold text-txt">
            {title}
          </h2>
          <StatusBadge label={statusLabel} variant={statusTone} withDot />
        </div>
        {description ? (
          <p className="text-xs-tight leading-snug text-muted/80">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
      ) : null}
    </div>
  );
}

function DetailStatsRow({
  items,
}: {
  items: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 px-1 text-xs-tight">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex items-baseline gap-1.5"
        >
          <dt className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted/70">
            {item.label}
          </dt>
          <dd className="font-medium text-txt">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius-sm)] border border-border/25 bg-bg/20">
      <div className="flex items-center justify-between gap-2 border-b border-border/20 px-3 py-1.5">
        <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">
          {title}
        </div>
        {action}
      </div>
      <div className="py-1">{children}</div>
    </section>
  );
}

function TriggerAutomationDetailPane({
  automation,
  nodes,
  onPromoteToWorkflow,
}: {
  automation: AutomationItem;
  nodes: AutomationNodeDescriptor[];
  onPromoteToWorkflow: (item: AutomationItem) => Promise<void>;
}) {
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
    <div className="space-y-3">
      <DetailHeader
        icon={<Clock3 className="h-3.5 w-3.5" aria-hidden />}
        title={automation.title}
        description={automation.description}
        statusLabel={trigger.enabled ? "Active" : "Paused"}
        statusTone={trigger.enabled ? "success" : "muted"}
        actions={
          <>
            <IconAction
              label={trigger.enabled ? "Pause" : "Resume"}
              onClick={() =>
                void onToggleTriggerEnabled(trigger.id, trigger.enabled)
              }
              icon={
                trigger.enabled ? (
                  <Pause className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )
              }
              tone={trigger.enabled ? "warning" : "ok"}
            />
            <IconAction
              label={t("triggersview.RunNow")}
              onClick={() => void onRunSelectedTrigger(trigger.id)}
              icon={<Zap className="h-3.5 w-3.5" />}
            />
            <IconAction
              label={t("triggersview.Edit")}
              onClick={() => openEditTrigger(trigger)}
              icon={<EditIcon className="h-3.5 w-3.5" />}
            />
            <IconAction
              label={t("heartbeatsview.duplicate")}
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
              icon={<Copy className="h-3.5 w-3.5" />}
            />
            <IconAction
              label="Compile to Workflow"
              onClick={() => void onPromoteToWorkflow(automation)}
              icon={<GitBranch className="h-3.5 w-3.5" />}
            />
          </>
        }
      />

      <DetailStatsRow
        items={[
          {
            label: "Schedule",
            value: scheduleLabel(trigger, t, uiLanguage),
          },
          {
            label: "Last run",
            value: formatDateTime(trigger.lastRunAtIso, {
              fallback: "—",
              locale: uiLanguage,
            }),
          },
          {
            label: "Next run",
            value: formatDateTime(trigger.nextRunAtMs, {
              fallback: "—",
              locale: uiLanguage,
            }),
          },
          {
            label: "Runs",
            value: (
              <span className="inline-flex items-center gap-1.5">
                <span className="text-txt tabular-nums">
                  {selectedRuns.length}
                </span>
                {successCount > 0 && (
                  <span className="text-ok">{successCount}✓</span>
                )}
                {failureCount > 0 && (
                  <span className="text-danger">{failureCount}✗</span>
                )}
              </span>
            ),
          },
        ]}
      />

      <DetailSection
        title="Run history"
        action={
          <IconAction
            label={t("common.refresh")}
            onClick={() => void loadTriggerRuns(trigger.id)}
            icon={<RefreshCw className="h-3.5 w-3.5" />}
          />
        }
      >
        {!hasLoadedRuns ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs-tight text-muted/70">
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" />
            {t("databaseview.Loading")}
          </div>
        ) : selectedRuns.length === 0 ? (
          <div className="px-3 py-2 text-xs-tight text-muted/60">
            {t("heartbeatsview.noRunsYetMessage")}
          </div>
        ) : (
          <div className="divide-y divide-border/20">
            {selectedRuns.map((run) => (
              <div
                key={run.triggerRunId}
                className="flex items-center gap-2 px-3 py-1.5 text-xs-tight"
              >
                <StatusBadge
                  label={localizedExecutionStatus(run.status, t)}
                  variant={toneForLastStatus(run.status)}
                />
                <span className="text-muted/70 tabular-nums">
                  {formatDateTime(run.startedAt, { locale: uiLanguage })}
                </span>
                <span className="text-muted/60">
                  {formatDurationMs(run.latencyMs, { t })}
                </span>
                <span className="ml-auto rounded bg-bg/40 px-1 py-0.5 font-mono text-[10px] text-muted/60">
                  {run.source}
                </span>
                {run.error && (
                  <span className="basis-full whitespace-pre-wrap rounded border border-danger/20 bg-danger/10 px-2 py-1 font-mono text-[11px] text-danger/90">
                    {run.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </DetailSection>

      <AutomationNodePalette
        nodes={nodes}
        title="Automation nodes"
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
  onDeleteWorkflow,
  onRefreshWorkflows,
  onStartLocalN8n,
  onToggleWorkflowActive,
}: {
  automation: AutomationItem;
  nodes: AutomationNodeDescriptor[];
  n8nStatus: N8nStatusResponse | null;
  workflowFetchError: string | null;
  workflowBusyId: string | null;
  workflowOpsBusy: boolean;
  onDeleteWorkflow: (item: AutomationItem) => Promise<void>;
  onRefreshWorkflows: () => Promise<void>;
  onStartLocalN8n: () => Promise<void>;
  onToggleWorkflowActive: (item: AutomationItem) => Promise<void>;
}) {
  const { t, uiLanguage } = useApp();
  const nodeCount = getWorkflowNodeCount(automation);
  const busy =
    workflowOpsBusy ||
    (automation.workflowId != null && workflowBusyId === automation.workflowId);

  return (
    <div className="space-y-3">
      <WorkflowRuntimeNotice
        status={n8nStatus}
        workflowFetchError={workflowFetchError}
        busy={busy}
        onRefresh={() => void onRefreshWorkflows()}
        onStartLocal={() => void onStartLocalN8n()}
      />

      <DetailHeader
        icon={<Workflow className="h-3.5 w-3.5" aria-hidden />}
        title={automation.title}
        description={
          automation.description ||
          (automation.isDraft
            ? "Develop this workflow in chat, then have the agent deploy it."
            : null)
        }
        statusLabel={
          automation.isDraft
            ? "Draft"
            : automation.enabled
              ? "Active"
              : "Paused"
        }
        statusTone={
          automation.isDraft
            ? "warning"
            : automation.enabled
              ? "success"
              : "muted"
        }
        actions={
          automation.workflow && automation.workflowId ? (
            <>
              <IconAction
                label={
                  automation.workflow.active
                    ? t("automations.n8n.deactivate", {
                        defaultValue: "Deactivate",
                      })
                    : t("automations.n8n.activate", {
                        defaultValue: "Activate",
                      })
                }
                onClick={() => void onToggleWorkflowActive(automation)}
                disabled={busy}
                icon={
                  automation.workflow.active ? (
                    <Pause className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )
                }
                tone={automation.workflow.active ? "warning" : "ok"}
              />
              <IconAction
                label={t("automations.n8n.deleteWorkflow", {
                  defaultValue: "Delete workflow",
                })}
                onClick={() => void onDeleteWorkflow(automation)}
                disabled={busy}
                icon={<Trash2 className="h-3.5 w-3.5" />}
                tone="danger"
              />
            </>
          ) : null
        }
      />

      <DetailStatsRow
        items={[
          {
            label: "ID",
            value: (
              <span className="break-all font-mono text-[10px]">
                {automation.workflowId ?? automation.draftId ?? "—"}
              </span>
            ),
          },
          { label: "Nodes", value: nodeCount },
          { label: "Schedules", value: automation.schedules.length },
          {
            label: "Updated",
            value: formatDateTime(automation.updatedAt, {
              fallback: "—",
              locale: uiLanguage,
            }),
          },
          {
            label: "Backing",
            value: automation.hasBackingWorkflow ? (
              <span className="text-ok">n8n</span>
            ) : (
              <span className="text-warning">room</span>
            ),
          },
        ]}
      />

      {automation.schedules.length > 0 && (
        <DetailSection title="Schedules">
          <div className="divide-y divide-border/20">
            {automation.schedules.map((schedule) => (
              <div
                key={schedule.id}
                className="flex items-center gap-2 px-3 py-1.5 text-xs-tight"
              >
                <span className="truncate font-medium text-txt">
                  {schedule.displayName}
                </span>
                <StatusBadge
                  label={schedule.enabled ? "Active" : "Paused"}
                  variant={schedule.enabled ? "success" : "muted"}
                  withDot
                />
                <span className="ml-auto text-muted">
                  {scheduleLabel(schedule, t, uiLanguage)}
                </span>
              </div>
            ))}
          </div>
        </DetailSection>
      )}

      {automation.workflow?.nodes && automation.workflow.nodes.length > 0 && (
        <DetailSection title="Workflow graph">
          <div className="divide-y divide-border/20">
            {automation.workflow.nodes.map((node) => (
              <div
                key={node.id ?? `${node.name}-${node.type}`}
                className="flex items-center justify-between gap-2 px-3 py-1 text-xs-tight"
              >
                <span className="truncate text-txt">
                  {node.name ?? "Unnamed node"}
                </span>
                <span className="font-mono text-[10px] text-muted">
                  {node.type?.split(".").pop() ?? "node"}
                </span>
              </div>
            ))}
          </div>
        </DetailSection>
      )}

      <AutomationNodePalette nodes={nodes} title="Node catalog" />
    </div>
  );
}

function AutomationStatusDot({
  tone,
}: {
  tone: "success" | "warning" | "muted" | "danger";
}) {
  const dotClass =
    tone === "success"
      ? "bg-ok"
      : tone === "warning"
        ? "bg-warning"
        : tone === "danger"
          ? "bg-danger"
          : "bg-muted/50";
  return (
    <span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`}
    />
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
  let Icon: LucideIcon = Zap;
  let tone: "success" | "warning" | "muted" | "danger" = "muted";
  let titleClass = "text-txt";

  if (item.type === "n8n_workflow") {
    Icon = Workflow;
    tone = item.isDraft ? "warning" : item.enabled ? "success" : "muted";
  } else if (item.type === "automation_draft") {
    Icon = FileText;
    tone = "warning";
  } else if (item.trigger) {
    Icon = Clock3;
    tone = item.trigger.enabled ? "success" : "muted";
    if (item.trigger.lastStatus) {
      const lastTone = toneForLastStatus(item.trigger.lastStatus);
      if (lastTone === "danger") tone = "danger";
    }
  } else if (item.task) {
    if (item.system) {
      Icon = Settings;
      tone = "muted";
      titleClass = "text-muted";
    } else if (item.task.isCompleted) {
      Icon = CheckCircle2;
      tone = "muted";
      titleClass = "text-muted line-through";
    } else {
      Icon = Circle;
      tone = "success";
    }
  } else {
    return null;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      aria-current={selected ? "page" : undefined}
      className={`group flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left transition-colors ${
        selected
          ? "bg-accent/15 text-txt"
          : "text-txt hover:bg-bg-muted/50"
      } ${item.system ? "opacity-60" : ""}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted/70" aria-hidden />
      <span className={`truncate text-xs-tight ${titleClass}`}>
        {item.title}
      </span>
      <AutomationStatusDot tone={tone} />
    </button>
  );
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
  const [searchQuery, setSearchQuery] = useState("");
  const [showDashboard, setShowDashboard] = useState(true);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleSectionCollapsed = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
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

  // Event consumer for agent-driven graph focus
  useEffect(() => {
    const handler = (event: Event) => {
      const { workflowId } = (
        event as CustomEvent<VisualizeWorkflowEventDetail>
      ).detail;
      const match = filteredItems.find(
        (item) => item.workflowId === workflowId || item.id === workflowId,
      );
      if (match) {
        selectItem(match);
      }
    };
    window.addEventListener(VISUALIZE_WORKFLOW_EVENT, handler);
    return () => window.removeEventListener(VISUALIZE_WORKFLOW_EVENT, handler);
  }, [filteredItems, selectItem]);

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
      const previousTriggerIds = new Set(
        ctx.allItems
          .filter((item) => item.trigger?.id)
          .map((item) => item.trigger!.id),
      );
      const previousTaskIds = new Set(
        ctx.allItems
          .filter((item) => item.task?.id)
          .map((item) => item.task!.id),
      );

      const data = await ctx.refreshAutomations();
      const draftScope = draftConversation?.metadata?.scope;
      if (!draftConversation || !draftScope) {
        return data;
      }

      const bridgeConversationId =
        draftConversation.metadata?.terminalBridgeConversationId;

      // Workflow-draft scope: rebind on new n8n workflow (existing path).
      if (
        draftScope === "automation-workflow-draft" &&
        draftConversation.metadata?.automationType === "n8n_workflow"
      ) {
        const createdWorkflows =
          data?.automations.filter(
            (item) =>
              item.type === "n8n_workflow" &&
              item.workflowId != null &&
              !item.isDraft &&
              !previousWorkflowIds.has(item.workflowId),
          ) ?? [];
        if (createdWorkflows.length !== 1) return data;
        const created = createdWorkflows[0];
        const reboundMetadata = buildWorkflowConversationMetadata(
          created.workflowId as string,
          created.title,
          bridgeConversationId,
        );
        const { conversation } = await client.updateConversation(
          draftConversation.id,
          { title: created.title, metadata: reboundMetadata },
        );
        setActiveWorkflowConversation(conversation);
        return await ctx.refreshAutomations();
      }

      // Shape-undecided draft: detect what the agent created and rebind.
      if (draftScope === "automation-draft") {
        const createdTriggers =
          data?.automations.filter(
            (item) =>
              item.trigger != null && !previousTriggerIds.has(item.trigger.id),
          ) ?? [];
        const createdTasks =
          data?.automations.filter(
            (item) =>
              item.task != null &&
              !item.system &&
              !previousTaskIds.has(item.task.id),
          ) ?? [];
        const createdWorkflows =
          data?.automations.filter(
            (item) =>
              item.type === "n8n_workflow" &&
              item.workflowId != null &&
              !item.isDraft &&
              !previousWorkflowIds.has(item.workflowId),
          ) ?? [];

        const createdCount =
          createdTriggers.length + createdTasks.length + createdWorkflows.length;
        if (createdCount !== 1) {
          return data;
        }

        const draftItemId = `automation-draft:${draftConversation.metadata?.draftId ?? ""}`;
        const draftWasSelected = selectedItemId === draftItemId;

        const followSelection = (nextItemId: string, kind: SelectionKind) => {
          if (!draftWasSelected) return;
          setSelectedItemId(nextItemId);
          setSelectedItemKind(kind);
        };

        if (createdTriggers.length === 1) {
          const created = createdTriggers[0];
          const trigger = created.trigger!;
          const reboundMetadata = buildCoordinatorTriggerConversationMetadata(
            trigger.id,
            bridgeConversationId,
          );
          await client.updateConversation(draftConversation.id, {
            title: created.title,
            metadata: reboundMetadata,
          });
          followSelection(created.id, "trigger");
          return await ctx.refreshAutomations();
        }

        if (createdTasks.length === 1) {
          const created = createdTasks[0];
          const task = created.task!;
          const reboundMetadata = buildCoordinatorConversationMetadata(
            task.id,
            bridgeConversationId,
          );
          await client.updateConversation(draftConversation.id, {
            title: created.title,
            metadata: reboundMetadata,
          });
          followSelection(created.id, "task");
          return await ctx.refreshAutomations();
        }

        if (createdWorkflows.length === 1) {
          const created = createdWorkflows[0];
          const reboundMetadata = buildWorkflowConversationMetadata(
            created.workflowId as string,
            created.title,
            bridgeConversationId,
          );
          const { conversation } = await client.updateConversation(
            draftConversation.id,
            { title: created.title, metadata: reboundMetadata },
          );
          setActiveWorkflowConversation(conversation);
          followSelection(created.id, "workflow");
          return await ctx.refreshAutomations();
        }
      }

      return data;
    },
    [ctx, selectedItemId, setSelectedItemId, setSelectedItemKind],
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

  const createAutomationDraft = useCallback(
    async (options?: { initialPrompt?: string }) => {
      setPageNotice(null);
      showAutomationsList();
      const draftId = createWorkflowDraftId();
      const bridgeConversationId = getAutomationBridgeIdForItem(
        resolvedSelectedItem,
        activeConversationId,
        conversations,
      );
      const metadata = buildAutomationDraftConversationMetadata(
        draftId,
        bridgeConversationId,
      );

      try {
        const conversation = await resolveAutomationConversation({
          title: AUTOMATION_DRAFT_TITLE,
          metadata,
        });

        if (options?.initialPrompt?.trim()) {
          await client.sendConversationMessage(
            conversation.id,
            `[SYSTEM]${AUTOMATION_DRAFT_SYSTEM_ADDENDUM}[/SYSTEM]\n\n${options.initialPrompt.trim()}`,
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

        setSelectedItemId(resolvedItem?.id ?? `automation-draft:${draftId}`);
        setSelectedItemKind(null);
        setEditorOpen(false);
        setEditingId(null);
        ctx.setEditingTaskId(null);
      } catch (error) {
        setPageNotice(
          error instanceof Error
            ? error.message
            : "Failed to create the automation draft.",
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

  // Open a workflow draft and seed it with the selected template prompt.
  const handleTemplateSelected = useCallback(
    async (seedPrompt: string) => {
      setTemplatesModalOpen(false);
      await createWorkflowDraft({ initialPrompt: seedPrompt });
    },
    [createWorkflowDraft],
  );

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
        error instanceof Error
          ? error.message
          : t("automations.n8n.startFailed", {
              defaultValue: "Failed to start local automations.",
            }),
      );
    } finally {
      setWorkflowOpsBusy(false);
    }
  }, [ctx, t]);

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
            : t("automations.n8n.updateStateFailed", {
                defaultValue: "Failed to update workflow state.",
              }),
        );
      } finally {
        setWorkflowBusyId(null);
      }
    },
    [ctx, t],
  );

  const handleDeleteWorkflow = useCallback(
    async (item: AutomationItem) => {
      if (!item.workflowId) {
        return;
      }
      const confirmed = await confirmDesktopAction({
        title: t("automations.n8n.deleteWorkflow", {
          defaultValue: "Delete workflow",
        }),
        message: t("automations.n8n.deleteConfirmWorkflow", {
          defaultValue: 'Delete "{{name}}"? This cannot be undone.',
          name: item.title,
        }),
        confirmLabel: t("automations.n8n.deleteWorkflow", {
          defaultValue: "Delete workflow",
        }),
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
          error instanceof Error
            ? error.message
            : t("automations.n8n.deleteFailed", {
                defaultValue: "Failed to delete workflow.",
              }),
        );
      } finally {
        setWorkflowBusyId(null);
      }
    },
    [ctx, t],
  );

  const draftItems = useMemo(
    () => visibleItems.filter((item) => item.type === "automation_draft"),
    [visibleItems],
  );
  const workflowItems = useMemo(
    () => visibleItems.filter((item) => item.type === "n8n_workflow"),
    [visibleItems],
  );
  const triggerItems = useMemo(
    () => visibleItems.filter((item) => item.trigger != null),
    [visibleItems],
  );
  const taskItems = useMemo(
    () => visibleItems.filter((item) => item.task != null),
    [visibleItems],
  );

  // Watch active drafts: while any unbound draft exists, poll the
  // automations list and try to rebind it to whatever the agent
  // materialized (trigger / task / workflow). Loop self-terminates as
  // soon as the draft is rebound (it disappears from `allItems`).
  const allDraftItems = useMemo(
    () => ctx.allItems.filter((item) => item.type === "automation_draft"),
    [ctx.allItems],
  );
  useEffect(() => {
    if (allDraftItems.length === 0) return undefined;
    const draftConversations = allDraftItems
      .map((item) => {
        const conversationId = item.room?.conversationId;
        if (!conversationId) return null;
        return conversations.find((c) => c.id === conversationId) ?? null;
      })
      .filter((c): c is Conversation => c != null);
    if (draftConversations.length === 0) return undefined;
    const interval = window.setInterval(() => {
      for (const draftConversation of draftConversations) {
        void refreshAutomationsWithDraftBinding(draftConversation);
      }
    }, 5000);
    return () => window.clearInterval(interval);
  }, [allDraftItems, conversations, refreshAutomationsWithDraftBinding]);

  const renderItem = (item: AutomationItem) => (
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
                void loadTriggerRuns((item.trigger as TriggerSummary).id);
              }
            : undefined
      }
    />
  );

  const newAutomationLabel = "New automation";
  const newAutomationButton = (
    <button
      type="button"
      onClick={() => void createAutomationDraft()}
      aria-label={newAutomationLabel}
      title={newAutomationLabel}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-accent/15 text-accent transition-colors hover:bg-accent/25"
    >
      <Plus className="h-3.5 w-3.5" aria-hidden />
    </button>
  );

  const nodeCatalogActive = activeSubpage === "node-catalog";
  const nodeCatalogLabel = t("automations.nodeCatalog", {
    defaultValue: "Node catalog",
  });

  const automationsSidebar = (
    <Sidebar
      testId="automations-sidebar"
      collapsible
      contentIdentity="automations"
      collapseButtonTestId="automations-sidebar-collapse-toggle"
      expandButtonTestId="automations-sidebar-expand-toggle"
      collapseButtonAriaLabel={t("automations.collapse", {
        defaultValue: "Collapse automations",
      })}
      expandButtonAriaLabel={t("automations.expand", {
        defaultValue: "Expand automations",
      })}
      header={undefined}
      className="!mt-0 !h-full !bg-none !bg-transparent !rounded-none !border-0 !border-r !border-r-border/30 !shadow-none !backdrop-blur-none !ring-0"
      headerClassName="!h-0 !min-h-0 !p-0 !m-0 !overflow-hidden"
      collapseButtonClassName="!h-7 !w-7 !border-0 !bg-transparent !shadow-none hover:!bg-bg-muted/60"
      footer={
        <button
          type="button"
          onClick={() => showNodeCatalog()}
          aria-pressed={nodeCatalogActive}
          title={nodeCatalogLabel}
          className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] bg-transparent px-1.5 text-2xs font-semibold uppercase tracking-[0.12em] transition-colors ${
            nodeCatalogActive ? "text-txt" : "text-muted hover:text-txt"
          }`}
        >
          <Grid3x3 className="h-3.5 w-3.5" aria-hidden />
          <span>{nodeCatalogLabel}</span>
        </button>
      }
      footerClassName="!px-2 !pt-1.5 !pb-1.5 !justify-start"
      collapsedRailAction={
        <SidebarCollapsedActionButton
          aria-label={newAutomationLabel}
          onClick={() => void createAutomationDraft()}
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
      <SidebarScrollRegion className="px-1 pb-2 pt-0">
        <SidebarPanel className="bg-transparent gap-0 p-0 shadow-none">
          <div className="sticky top-0 z-10 flex items-center gap-1 bg-bg/60 px-1 py-1.5 backdrop-blur-sm">
            <div className="relative min-w-0 flex-1">
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("automations.searchPlaceholder", {
                  defaultValue: "Search",
                })}
                aria-label={t("automations.searchPlaceholder", {
                  defaultValue: "Search automations",
                })}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-[var(--radius-sm)] border border-border/30 bg-bg/40 px-2 py-1 text-xs-tight text-txt placeholder:text-muted/50 focus:border-accent/40 focus:outline-none"
              />
            </div>
            {newAutomationButton}
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-2xs text-muted">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" />
              {t("common.loading")}
            </div>
          )}

          {!isLoading &&
          normalizedSearchQuery &&
          visibleItems.length === 0 ? (
            <div className="px-3 py-3 text-2xs text-muted/70">
              No matching automations
            </div>
          ) : (
            <div className="mt-0.5 space-y-1">
              {draftItems.length > 0 && (
                <AutomationCollapsibleSection
                  sectionKey="drafts"
                  label="Drafts"
                  icon={<FileText className="h-3.5 w-3.5" aria-hidden />}
                  count={draftItems.length}
                  collapsed={collapsedSections.has("drafts")}
                  onToggleCollapsed={toggleSectionCollapsed}
                  emptyLabel="No drafts"
                >
                  {draftItems.map(renderItem)}
                </AutomationCollapsibleSection>
              )}

              <AutomationCollapsibleSection
                sectionKey="workflows"
                label="Workflows"
                icon={<Workflow className="h-3.5 w-3.5" aria-hidden />}
                count={workflowItems.length}
                collapsed={collapsedSections.has("workflows")}
                onToggleCollapsed={toggleSectionCollapsed}
                emptyLabel="No workflows"
              >
                {workflowItems.map(renderItem)}
              </AutomationCollapsibleSection>

              <AutomationCollapsibleSection
                sectionKey="coordinator"
                label="Coordinator"
                icon={<SquareTerminal className="h-3.5 w-3.5" aria-hidden />}
                count={taskItems.length}
                collapsed={collapsedSections.has("coordinator")}
                onToggleCollapsed={toggleSectionCollapsed}
                emptyLabel="No coordinators"
              >
                {taskItems.map(renderItem)}
              </AutomationCollapsibleSection>

              <AutomationCollapsibleSection
                sectionKey="scheduled"
                label="Scheduled"
                icon={<Clock3 className="h-3.5 w-3.5" aria-hidden />}
                count={triggerItems.length}
                collapsed={collapsedSections.has("scheduled")}
                onToggleCollapsed={toggleSectionCollapsed}
                emptyLabel="No schedules"
              >
                {triggerItems.map(renderItem)}
              </AutomationCollapsibleSection>
            </div>
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
      contentInnerClassName="w-full"
      footer={<WidgetHost slot="automations" className="py-2" />}
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
        ) : resolvedSelectedItem?.type === "automation_draft" ? (
          <AutomationDraftPane
            automation={resolvedSelectedItem}
            onPromptSubmit={(prompt) =>
              void createAutomationDraft({ initialPrompt: prompt })
            }
            onPromptSent={() => {
              const conversationId =
                resolvedSelectedItem.room?.conversationId ?? null;
              const draftConversation = conversationId
                ? (conversations.find((c) => c.id === conversationId) ?? null)
                : null;
              if (draftConversation) {
                void refreshAutomationsWithDraftBinding(draftConversation);
              } else {
                void ctx.refreshAutomations();
              }
            }}
          />
        ) : resolvedSelectedItem?.type === "n8n_workflow" ? (
          <WorkflowAutomationDetailPane
            automation={resolvedSelectedItem}
            nodes={automationNodes}
            n8nStatus={n8nStatus}
            workflowFetchError={workflowFetchError}
            workflowBusyId={workflowBusyId}
            workflowOpsBusy={workflowOpsBusy}
            onDeleteWorkflow={handleDeleteWorkflow}
            onRefreshWorkflows={handleRefreshWorkflows}
            onStartLocalN8n={handleStartLocalN8n}
            onToggleWorkflowActive={handleToggleWorkflowActive}
          />
        ) : resolvedSelectedItem?.trigger ? (
          <TriggerAutomationDetailPane
            automation={resolvedSelectedItem}
            nodes={automationNodes}
            onPromoteToWorkflow={promoteAutomationToWorkflow}
          />
        ) : resolvedSelectedItem?.task ? (
          <TaskAutomationDetailPane
            automation={resolvedSelectedItem}
            nodes={automationNodes}
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
  return (
    <AppWorkspaceChrome
      testId="automations-workspace"
      main={
        <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
          <AutomationsView />
        </div>
      }
    />
  );
}
