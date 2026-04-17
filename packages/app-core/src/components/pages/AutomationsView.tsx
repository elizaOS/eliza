/**
 * AutomationsView — unified view for tasks and scheduled automations.
 *
 * Combines the previous "Heartbeats" (triggers) and "Tasks" views into a
 * single /automations route with filter tabs.
 */

import {
  Button,
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
  CheckCircle2,
  Circle,
  Clock3,
  ListTodo,
  Plus,
  Settings,
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
import type { TriggerSummary, WorkbenchTask } from "../../api/client";
import { useApp } from "../../state";
import { confirmDesktopAction } from "../../utils";
import { formatDateTime, formatDurationMs } from "../../utils/format";
import { WidgetHost } from "../../widgets";
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
import { N8nWorkflowsPanel } from "./N8nWorkflowsPanel";

// ── Filter types ──────────────────────────────────────────────────

type AutomationFilter =
  | "all"
  | "my-tasks"
  | "scheduled"
  | "system"
  | "workflows";

// ── System task detection ─────────────────────────────────────────

/** Runtime-internal task names that are not user-created. */
const SYSTEM_TASK_NAMES = new Set([
  "EMBEDDING_DRAIN",
  "PROACTIVE_AGENT",
  "LIFEOPS_SCHEDULER",
  "TRIGGER_DISPATCH",
  "heartbeat",
]);

function isSystemTask(task: WorkbenchTask): boolean {
  if (SYSTEM_TASK_NAMES.has(task.name)) return true;
  // Tasks with queue+repeat tags are runtime-internal
  const tags = new Set(task.tags ?? []);
  if (tags.has("queue") && tags.has("repeat")) return true;
  return false;
}

/**
 * Deduplicate system tasks by name — keep only one per name,
 * preferring the one with a description.
 */
function deduplicateSystemTasks(tasks: WorkbenchTask[]): WorkbenchTask[] {
  const byName = new Map<string, WorkbenchTask>();
  for (const task of tasks) {
    const existing = byName.get(task.name);
    if (!existing || (task.description && !existing.description)) {
      byName.set(task.name, task);
    }
  }
  return [...byName.values()];
}

// ── Item union ────────────────────────────────────────────────────

interface AutomationItemTrigger {
  kind: "trigger";
  id: string;
  name: string;
  trigger: TriggerSummary;
}

interface AutomationItemTask {
  kind: "task";
  id: string;
  name: string;
  task: WorkbenchTask;
  system: boolean;
}

type AutomationItem = AutomationItemTrigger | AutomationItemTask;

// ── View controller hook ──────────────────────────────────────────

function useAutomationsViewController() {
  const {
    triggers = [],
    triggersLoaded = false,
    triggersLoading = false,
    triggersSaving = false,
    triggerRunsById = {},
    triggerHealth: _triggerHealth = null,
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

  // ── Workbench tasks state ───────────────────────────────────────
  const [workbenchTasks, setWorkbenchTasks] = useState<WorkbenchTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [_tasksLoaded, setTasksLoaded] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskSaving, setTaskSaving] = useState(false);

  const loadWorkbenchTasks = useCallback(async () => {
    setTasksLoading(true);
    try {
      const data = await client.listWorkbenchTasks();
      setWorkbenchTasks(data.tasks ?? []);
      setTaskError(null);
    } catch (err) {
      setTaskError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      setTasksLoaded(true);
      setTasksLoading(false);
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
        const created = res.task;
        setWorkbenchTasks((prev) => [...prev, created]);
        setTaskError(null);
        return created;
      } catch (err) {
        setTaskError(
          err instanceof Error ? err.message : "Failed to create task",
        );
        return null;
      } finally {
        setTaskSaving(false);
      }
    },
    [],
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
        const updated = res.task;
        setWorkbenchTasks((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item)),
        );
        setTaskError(null);
        return updated;
      } catch (err) {
        setTaskError(
          err instanceof Error ? err.message : "Failed to update task",
        );
        return null;
      } finally {
        setTaskSaving(false);
      }
    },
    [],
  );

  const deleteWorkbenchTask = useCallback(
    async (id: string): Promise<boolean> => {
      setTaskSaving(true);
      try {
        await client.deleteWorkbenchTask(id);
        setWorkbenchTasks((prev) => prev.filter((item) => item.id !== id));
        setTaskError(null);
        return true;
      } catch (err) {
        setTaskError(
          err instanceof Error ? err.message : "Failed to delete task",
        );
        return false;
      } finally {
        setTaskSaving(false);
      }
    },
    [],
  );

  // ── Trigger form state (reused from HeartbeatsView) ─────────────
  const [form, setForm] = useState<TriggerFormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedItemKind, setSelectedItemKind] = useState<
    "trigger" | "task" | null
  >(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"trigger" | "task">("trigger");
  const lastSelectedIdRef = useRef<string | null>(null);
  const [userTemplates, setUserTemplates] =
    useState<HeartbeatTemplate[]>(loadUserTemplates);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  const didBootstrapDataRef = useRef(false);

  // ── Task create form state ──────────────────────────────────────
  const [taskFormName, setTaskFormName] = useState("");
  const [taskFormDescription, setTaskFormDescription] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);

  // ── Filter state ────────────────────────────────────────────────
  const [filter, setFilter] = useState<AutomationFilter>("all");

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
    setUserTemplates((prev) => {
      const next = [...prev, template];
      saveUserTemplates(next);
      return next;
    });
  }, [form]);

  const deleteUserTemplate = useCallback((id: string) => {
    setUserTemplates((prev) => {
      const next = prev.filter((t) => t.id !== id);
      saveUserTemplates(next);
      return next;
    });
  }, []);

  // ── Bootstrap data ──────────────────────────────────────────────
  useEffect(() => {
    if (didBootstrapDataRef.current) return;
    didBootstrapDataRef.current = true;
    void loadTriggerHealth();
    void ensureTriggersLoaded();
    void loadWorkbenchTasks();
  }, [ensureTriggersLoaded, loadTriggerHealth, loadWorkbenchTasks]);

  // ── Build unified items list ────────────────────────────────────
  const allItems: AutomationItem[] = useMemo(() => {
    const items: AutomationItem[] = [];
    for (const trigger of triggers) {
      items.push({
        kind: "trigger",
        id: `trigger:${trigger.id}`,
        name: trigger.displayName,
        trigger,
      });
    }

    // Separate user tasks from system tasks
    const userTasks: WorkbenchTask[] = [];
    const systemTasks: WorkbenchTask[] = [];
    for (const task of workbenchTasks) {
      if (isSystemTask(task)) {
        systemTasks.push(task);
      } else {
        userTasks.push(task);
      }
    }

    // Add user-created tasks
    for (const task of userTasks) {
      items.push({
        kind: "task",
        id: `task:${task.id}`,
        name: task.name,
        task,
        system: false,
      });
    }

    // Add deduplicated system tasks
    for (const task of deduplicateSystemTasks(systemTasks)) {
      items.push({
        kind: "task",
        id: `task:${task.id}`,
        name: task.name,
        task,
        system: true,
      });
    }

    return items;
  }, [triggers, workbenchTasks]);

  const filteredItems = useMemo(() => {
    switch (filter) {
      case "scheduled":
        return allItems.filter((item) => item.kind === "trigger");
      case "my-tasks":
        return allItems.filter((item) => item.kind === "task" && !item.system);
      case "system":
        return allItems.filter(
          (item) =>
            (item.kind === "task" && item.system) || item.kind === "trigger",
        );
      default:
        return allItems;
    }
  }, [allItems, filter]);

  // Clear stale selection
  useEffect(() => {
    if (!selectedItemId) return;
    if (!allItems.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(null);
      setSelectedItemKind(null);
    }
  }, [selectedItemId, allItems]);

  useEffect(() => {
    if (selectedItemId) {
      lastSelectedIdRef.current = selectedItemId;
    }
  }, [selectedItemId]);

  // Auto-select first item
  useEffect(() => {
    if (
      editorOpen ||
      editingId ||
      editingTaskId ||
      selectedItemId ||
      allItems.length === 0
    )
      return;

    const preferred = lastSelectedIdRef.current;
    const next =
      preferred && allItems.some((item) => item.id === preferred)
        ? preferred
        : (allItems[0]?.id ?? null);

    if (next) {
      const item = allItems.find((i) => i.id === next);
      setSelectedItemId(next);
      setSelectedItemKind(item?.kind ?? null);
    }
  }, [editorOpen, editingId, editingTaskId, selectedItemId, allItems]);

  // Escape key
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

  // ── Editor helpers ──────────────────────────────────────────────
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
        closeEditor();
      }
      return;
    }

    const created = await createTrigger(buildCreateRequest(form));
    if (created) {
      setSelectedItemId(`trigger:${created.id}`);
      setSelectedItemKind("trigger");
      void loadTriggerRuns(created.id);
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
  };

  const onToggleTaskCompleted = async (
    taskId: string,
    currentlyCompleted: boolean,
  ) => {
    await updateWorkbenchTask(taskId, { isCompleted: !currentlyCompleted });
  };

  // ── Resolved selection ──────────────────────────────────────────
  const resolvedSelectedItem = useMemo(() => {
    if (editorOpen || editingId || editingTaskId) return null;
    if (selectedItemId) {
      return allItems.find((item) => item.id === selectedItemId) ?? null;
    }
    return allItems[0] ?? null;
  }, [editorOpen, editingId, editingTaskId, selectedItemId, allItems]);

  const modalTitle =
    editorMode === "trigger"
      ? editingId
        ? t("heartbeatsview.editTitle", {
            name: form.displayName.trim() || "Task",
            defaultValue: "Edit {{name}}",
          })
        : "New Task"
      : editingTaskId
        ? "Edit Task"
        : "New Task";

  const editorEnabled =
    editingId != null
      ? (triggers.find((trigger) => trigger.id === editingId)?.enabled ??
        form.enabled)
      : form.enabled;

  const hasItems = allItems.length > 0;
  const isLoading = triggersLoading || tasksLoading;
  const combinedError = triggerError || taskError;
  const showFirstRunEmptyState = !isLoading && !combinedError && !hasItems;
  const showDetailPane = Boolean(
    editorOpen || editingId || editingTaskId || resolvedSelectedItem,
  );

  return {
    // Filter
    filter,
    setFilter,
    // Items
    allItems,
    filteredItems,
    // Selection
    selectedItemId,
    selectedItemKind,
    setSelectedItemId,
    setSelectedItemKind,
    resolvedSelectedItem,
    // Trigger editor
    form,
    setForm,
    setField,
    editingId,
    setEditingId,
    editorOpen,
    setEditorOpen,
    editorMode,
    setEditorMode,
    formError,
    setFormError,
    editorEnabled,
    modalTitle,
    templateNotice,
    setTemplateNotice,
    userTemplates,
    // Task editor
    taskFormName,
    setTaskFormName,
    taskFormDescription,
    setTaskFormDescription,
    editingTaskId,
    setEditingTaskId,
    taskSaving,
    // Actions
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
    // Data
    triggers,
    workbenchTasks,
    triggerRunsById,
    triggersSaving,
    triggersLoading,
    tasksLoading,
    triggerError,
    taskError,
    hasItems,
    isLoading,
    combinedError,
    showFirstRunEmptyState,
    showDetailPane,
    // I18n
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

// ── Filter tabs ───────────────────────────────────────────────────

function FilterTabs() {
  const { filter, setFilter, allItems } = useAutomationsViewContext();

  const triggerCount = allItems.filter((i) => i.kind === "trigger").length;
  const _userTaskCount = allItems.filter(
    (i) => i.kind === "task" && !i.system,
  ).length;
  const _systemCount =
    allItems.filter((i) => i.kind === "task" && i.system).length + triggerCount;

  const filters: { key: AutomationFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "scheduled", label: "Scheduled" },
    { key: "system", label: "System" },
    { key: "workflows", label: "Workflows" },
  ];

  return (
    <div className="flex gap-1 px-1 pb-2">
      {filters.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          onClick={() => setFilter(key)}
          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
            filter === key
              ? "bg-accent/15 text-accent"
              : "text-muted hover:text-txt hover:bg-bg/50"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Task form (inline in editor) ──────────────────────────────────

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
            onChange={(e) => setTaskFormName(e.target.value)}
            placeholder="Task name..."
            autoFocus
          />
        </div>
        <div>
          <FieldLabel>Description</FieldLabel>
          <Textarea
            value={taskFormDescription}
            onChange={(e) => setTaskFormDescription(e.target.value)}
            placeholder="What should be done..."
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
            ? t("triggersview.Save", { defaultValue: "Save" })
            : "Create Task"}
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

// ── Trigger detail pane (read-only view) ──────────────────────────

function TriggerDetailPane({ trigger }: { trigger: TriggerSummary }) {
  const {
    openEditTrigger,
    onRunSelectedTrigger,
    onToggleTriggerEnabled,
    loadTriggerRuns,
    triggerRunsById,
    t,
    uiLanguage,
    setForm,
    setEditorOpen,
    setEditingId,
    setSelectedItemId,
    setSelectedItemKind,
  } = useAutomationsViewContext();

  const selectedRuns = triggerRunsById[trigger.id] ?? [];
  const hasLoadedRuns = Object.hasOwn(triggerRunsById, trigger.id);

  useEffect(() => {
    if (!hasLoadedRuns) {
      void loadTriggerRuns(trigger.id);
    }
  }, [trigger.id, hasLoadedRuns, loadTriggerRuns]);

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
    <div className="w-full">
      <div className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <FieldLabel variant="kicker">
              <Clock3 className="mr-1.5 inline h-3.5 w-3.5" />
              Scheduled Task
            </FieldLabel>
            <StatusBadge
              label={
                trigger.enabled
                  ? t("appsview.Active")
                  : t("heartbeatsview.statusPaused")
              }
              variant={trigger.enabled ? "success" : "muted"}
              withDot
            />
          </div>
          <h2 className="text-2xl font-semibold text-txt sm:text-[2rem]">
            {trigger.displayName}
          </h2>
          <p className="text-sm leading-relaxed text-muted sm:text-sm">
            {trigger.instructions}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
          <Button
            variant="outline"
            size="sm"
            className={`h-8 px-3 text-xs ${trigger.enabled ? "border-warning/30 text-warning hover:bg-warning/10" : "border-ok/30 text-ok hover:bg-ok/10"}`}
            onClick={() =>
              void onToggleTriggerEnabled(trigger.id, trigger.enabled)
            }
          >
            {trigger.enabled
              ? t("heartbeatsview.pause")
              : t("heartbeatsview.resume")}
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

      <dl className="mb-8 grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
            {t("heartbeatsview.schedule")}
          </dt>
          <dd className="mt-1 font-medium text-txt">
            {scheduleLabel(trigger, t, uiLanguage)}
          </dd>
        </PagePanel.SummaryCard>
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
            {t("triggersview.LastRun")}
          </dt>
          <dd className="mt-1 font-medium text-txt">
            {formatDateTime(trigger.lastRunAtIso, {
              fallback: t("heartbeatsview.notYetRun"),
              locale: uiLanguage,
            })}
          </dd>
        </PagePanel.SummaryCard>
        <PagePanel.SummaryCard className="px-4 py-4">
          <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
            {t("heartbeatsview.nextRun")}
          </dt>
          <dd className="mt-1 font-medium text-txt">
            {formatDateTime(trigger.nextRunAtMs, {
              fallback: t("heartbeatsview.notScheduled"),
              locale: uiLanguage,
            })}
          </dd>
        </PagePanel.SummaryCard>
        {hasLoadedRuns && selectedRuns.length > 0 && (
          <PagePanel.SummaryCard className="px-4 py-4">
            <dt className="text-xs-tight font-semibold uppercase tracking-wider text-muted">
              {t("heartbeatsview.runStats")}
            </dt>
            <dd className="mt-1 flex items-center gap-2 text-sm font-medium">
              <span className="text-txt">
                {t("heartbeatsview.runCountPlural", {
                  count: selectedRuns.length,
                })}
              </span>
              {successCount > 0 && (
                <span className="text-ok">{successCount} ✓</span>
              )}
              {failureCount > 0 && (
                <span className="text-danger">{failureCount} ✗</span>
              )}
            </dd>
          </PagePanel.SummaryCard>
        )}
      </dl>

      <PagePanel variant="padded" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted">
            {t("triggersview.RunHistory")}
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
    </div>
  );
}

// ── Task detail pane ──────────────────────────────────────────────

function TaskDetailPane({
  task,
  system,
}: {
  task: WorkbenchTask;
  system: boolean;
}) {
  const { openEditTask, onDeleteTask, onToggleTaskCompleted, t } =
    useAutomationsViewContext();

  return (
    <div className="w-full">
      <div className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <FieldLabel variant="kicker">
              {system ? (
                <>
                  <Settings className="mr-1.5 inline h-3.5 w-3.5" />
                  System Automation
                </>
              ) : (
                <>
                  <ListTodo className="mr-1.5 inline h-3.5 w-3.5" />
                  Task
                </>
              )}
            </FieldLabel>
            <StatusBadge
              label={
                system ? "System" : task.isCompleted ? "Completed" : "Active"
              }
              variant={
                system ? "muted" : task.isCompleted ? "muted" : "success"
              }
              withDot
            />
          </div>
          <h2 className="text-2xl font-semibold text-txt sm:text-[2rem]">
            {task.name}
          </h2>
          {task.description && (
            <p className="text-sm leading-relaxed text-muted sm:text-sm">
              {task.description}
            </p>
          )}
          {task.tags && task.tags.length > 0 && (
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
        {!system && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
            <Button
              variant="outline"
              size="sm"
              className={`h-8 px-3 text-xs ${task.isCompleted ? "border-ok/30 text-ok hover:bg-ok/10" : "border-accent/30 text-accent hover:bg-accent/10"}`}
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
    </div>
  );
}

// ── Main layout ───────────────────────────────────────────────────

function AutomationsLayout() {
  const ctx = useAutomationsViewContext();
  const {
    closeEditor,
    deleteUserTemplate,
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
    openEditTrigger,
    saveFormAsTemplate,
    selectedItemId,
    selectedItemKind,
    setEditingId,
    setEditorOpen,
    setField,
    setForm,
    setFormError,
    setSelectedItemId,
    setSelectedItemKind,
    setTemplateNotice,
    showDetailPane,
    showFirstRunEmptyState,
    resolvedSelectedItem,
    t,
    templateNotice,
    triggers,
    filteredItems,
    triggerError,
    taskError,
    triggerRunsById,
    triggersLoading,
    tasksLoading,
    triggersSaving,
    uiLanguage,
    userTemplates,
    filter,
  } = ctx;

  // Ref forwarded to the n8n scoped chat composer so "New workflow" can focus it.
  const workflowComposerRef = useRef<HTMLTextAreaElement | null>(null);

  const focusWorkflowComposer = useCallback(
    (seed = "Create a new workflow that ") => {
      const ta = workflowComposerRef.current;
      if (!ta) return;
      ta.focus();
      if (!ta.value.startsWith(seed)) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        nativeSetter?.call(ta, seed);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },
    [],
  );

  const [searchQuery, setSearchQuery] = useState("");
  const searchLabel = "Search tasks";
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const visibleItems = useMemo(() => {
    if (!normalizedSearchQuery) return filteredItems;
    return filteredItems.filter((item) =>
      item.name.toLowerCase().includes(normalizedSearchQuery),
    );
  }, [normalizedSearchQuery, filteredItems]);

  const mobileSidebarLabel =
    editorOpen || editingId || editingTaskId
      ? modalTitle
      : (resolvedSelectedItem?.name ?? "Automations");

  const selectItem = (item: AutomationItem) => {
    setSelectedItemId(item.id);
    setSelectedItemKind(item.kind);
    setEditorOpen(false);
    setEditingId(null);
    if (item.kind === "trigger") {
      void loadTriggerRuns(item.trigger.id);
    }
  };

  const automationsSidebar = (
    <Sidebar
      testId="automations-sidebar"
      collapsible
      contentIdentity="automations"
      collapseButtonTestId="automations-sidebar-collapse-toggle"
      expandButtonTestId="automations-sidebar-expand-toggle"
      collapseButtonAriaLabel="Collapse tasks"
      expandButtonAriaLabel="Expand tasks"
      header={null}
      collapsedRailAction={
        <SidebarCollapsedActionButton
          aria-label="New task"
          onClick={openCreateTrigger}
        >
          <Plus className="h-4 w-4" />
        </SidebarCollapsedActionButton>
      }
      collapsedRailItems={visibleItems.map((item) => {
        const isActive = item.id === selectedItemId;
        return (
          <SidebarContent.RailItem
            key={item.id}
            aria-label={item.name}
            title={item.name}
            active={isActive}
            indicatorTone={
              item.kind === "trigger"
                ? item.trigger.enabled
                  ? "accent"
                  : undefined
                : item.task.isCompleted
                  ? undefined
                  : "accent"
            }
            onClick={() => selectItem(item)}
          >
            {railMonogram(item.name)}
          </SidebarContent.RailItem>
        );
      })}
    >
      <SidebarScrollRegion>
        <SidebarPanel>
          {/* New + Search on same row */}
          <div className="mb-3 flex items-center gap-2">
            {filter !== "workflows" && (
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={searchLabel}
                aria-label={searchLabel}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-border/30 bg-bg/30 px-3 py-1.5 text-sm text-txt placeholder:text-muted/50 focus:border-accent/40 focus:outline-none"
              />
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1 px-3 text-xs font-medium"
              onClick={
                filter === "workflows"
                  ? () => focusWorkflowComposer()
                  : openCreateTrigger
              }
            >
              <Plus className="h-3.5 w-3.5" />
              {filter === "workflows"
                ? t("automations.n8n.newWorkflow")
                : "New"}
            </Button>
          </div>

          {/* Filter tabs */}
          <FilterTabs />

          {filter !== "workflows" && (triggersLoading || tasksLoading) && (
            <SidebarContent.Notice
              icon={
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" />
              }
            >
              {t("common.loading")}
            </SidebarContent.Notice>
          )}

          {filter !== "workflows" &&
          normalizedSearchQuery &&
          visibleItems.length === 0 ? (
            <SidebarContent.EmptyState className="px-4 py-6">
              No matching items
            </SidebarContent.EmptyState>
          ) : filter !== "workflows" ? (
            visibleItems.map((item) => {
              const isActive = selectedItemId === item.id;

              if (item.kind === "trigger") {
                const trigger = item.trigger;
                return (
                  <SidebarContent.Item
                    key={item.id}
                    onClick={() => selectItem(item)}
                    onDoubleClick={() => {
                      openEditTrigger(trigger);
                      void loadTriggerRuns(trigger.id);
                    }}
                    active={isActive}
                    className="h-auto"
                  >
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <div className="flex items-center justify-between gap-1">
                        <div className="flex items-center gap-1.5 truncate">
                          <Clock3 className="h-3 w-3 shrink-0 text-muted/60" />
                          <span className="truncate text-sm font-semibold text-txt">
                            {trigger.displayName}
                          </span>
                        </div>
                        <StatusBadge
                          label={
                            trigger.enabled
                              ? t("appsview.Active")
                              : t("heartbeatsview.statusPaused")
                          }
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
                            label={localizedExecutionStatus(
                              trigger.lastStatus,
                              t,
                            )}
                            variant={toneForLastStatus(trigger.lastStatus)}
                          />
                        )}
                      </div>
                    </div>
                  </SidebarContent.Item>
                );
              }

              // Task item
              const task = item.task;
              const isSys = item.system;
              return (
                <SidebarContent.Item
                  key={item.id}
                  onClick={() => selectItem(item)}
                  onDoubleClick={
                    isSys ? undefined : () => ctx.openEditTask(task)
                  }
                  active={isActive}
                  className={`h-auto ${isSys ? "opacity-60" : ""}`}
                >
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <div className="flex items-center gap-1.5 truncate">
                        {isSys ? (
                          <Settings className="h-3 w-3 shrink-0 text-muted/50" />
                        ) : task.isCompleted ? (
                          <CheckCircle2 className="h-3 w-3 shrink-0 text-ok/60" />
                        ) : (
                          <Circle className="h-3 w-3 shrink-0 text-muted/60" />
                        )}
                        <span
                          className={`truncate text-sm font-semibold ${isSys ? "text-muted" : task.isCompleted ? "text-muted line-through" : "text-txt"}`}
                        >
                          {task.name}
                        </span>
                      </div>
                      <StatusBadge
                        label={
                          isSys
                            ? "System"
                            : task.isCompleted
                              ? "Done"
                              : "Active"
                        }
                        variant={
                          isSys
                            ? "muted"
                            : task.isCompleted
                              ? "muted"
                              : "success"
                        }
                        withDot
                      />
                    </div>
                    {task.description && (
                      <div className="mt-0.5 truncate text-xs-tight text-muted">
                        {task.description}
                      </div>
                    )}
                  </div>
                </SidebarContent.Item>
              );
            })
          ) : null}
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
        {showDetailPane ? (
          <button
            type="button"
            className="mb-3 flex items-center gap-2 rounded-2xl border border-border/30 bg-bg/25 px-4 py-3 text-base font-medium text-muted hover:text-txt md:hidden"
            onClick={() => {
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

        {filter === "workflows" ? (
          <N8nWorkflowsPanel
            composerRef={workflowComposerRef}
            onFocusComposer={focusWorkflowComposer}
          />
        ) : editorOpen || editingId || editingTaskId ? (
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
        ) : resolvedSelectedItem ? (
          resolvedSelectedItem.kind === "trigger" ? (
            <TriggerDetailPane trigger={resolvedSelectedItem.trigger} />
          ) : (
            <TaskDetailPane
              task={resolvedSelectedItem.task}
              system={resolvedSelectedItem.system}
            />
          )
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10 text-center">
            <div className="space-y-3">
              <h3 className="text-lg font-semibold text-txt-strong">
                {showFirstRunEmptyState
                  ? "Create your first automation"
                  : "Select an item"}
              </h3>
              {showFirstRunEmptyState && (
                <p className="text-sm text-muted">
                  Schedule recurring automations or create tasks to track work.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  );
}

// ── Exports ───────────────────────────────────────────────────────

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
