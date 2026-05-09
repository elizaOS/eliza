/**
 * AutomationsView — list/detail UI for tasks and workflows.
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
  SidebarCollapsedActionButton,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
  Spinner,
  StatusBadge,
  StatusDot,
  Textarea,
} from "@elizaos/ui";
import {
  ArrowRight,
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
import {
  type AutomationListResponse,
  type AutomationNodeDescriptor,
  type AutomationItem as CatalogAutomationItem,
  type Conversation,
  isMissingCredentialsResponse,
  isNeedsClarificationResponse,
  type WorkflowClarificationRequest,
  type WorkflowClarificationTargetGroup,
  type WorkflowStatusResponse,
  type WorkflowDefinition,
  type WorkflowDefinitionMissingCredential,
  type WorkflowDefinitionNeedsClarificationResponse,
  type WorkflowDefinitionWriteRequest,
  type TriggerSummary,
  type WorkbenchTask,
} from "../../api/client";
import { useWorkflowGenerationState } from "../../hooks/useWorkflowGenerationState";
import {
  dispatchFocusConnector,
  prettyCredName,
  providerFromCredType,
  useApp,
} from "../../state";
import { confirmDesktopAction } from "../../utils";
import { formatDateTime, formatDurationMs } from "../../utils/format";
// Direct sub-path import: `widgets/index.ts` re-exports `WidgetHost` while
// also pulling other widgets/* modules that depend back through the barrel.
// Going through the index from here drags Rollup into a chunk-level cycle
// (warning: "reexported through module ... while both modules are
// dependencies of each other"); the direct import skips it.
import { WidgetHost } from "../../widgets/WidgetHost";
import { ChoiceWidget } from "../chat/widgets/ChoiceWidget";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import {
  AppWorkspaceChrome,
  useAppWorkspaceChatChrome,
} from "../workspace/AppWorkspaceChrome";
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
  humanizeEventKind,
  loadUserTemplates,
  localizedExecutionStatus,
  railMonogram,
  saveUserTemplates,
  scheduleLabel,
  type TriggerFormState,
  toneForLastStatus,
  validateForm,
} from "./heartbeat-utils";
import { PageScopedChatPane } from "./PageScopedChatPane";
import { WorkflowGraphViewer } from "./WorkflowGraphViewer";
import {
  VISUALIZE_WORKFLOW_EVENT,
  type VisualizeWorkflowEventDetail,
} from "./workflow-graph-events";

type AutomationFilter = "all" | "coordinator" | "workflows" | "scheduled";
type AutomationSubpage = "list" | "node-catalog";
type SelectionKind = "trigger" | "task" | "workflow" | null;
type AutomationItem = CatalogAutomationItem;

interface ScheduledAutomationEntry {
  item: AutomationItem;
  schedule: TriggerSummary;
  key: string;
}

const WORKFLOW_DRAFT_TITLE = "New Workflow Draft";
const WORKFLOW_SYSTEM_ADDENDUM =
  "You are in a workflow-specific automation room. Focus only on this " +
  "workflow. Use the linked terminal conversation only when it directly " +
  "informs the workflow. Request keys and connector setup when needed, and " +
  "prefer owner-scoped LifeOps integrations for personal services.";

const AUTOMATION_DRAFT_SYSTEM_ADDENDUM =
  "You are in an automation-creation room. The user wants to create one " +
  "automation. Decide whether it should be a task or a workflow and call " +
  "the matching action exactly once:\n" +
  '- Task: a simple prompt that runs on a schedule or from an event, for example "every morning summarize my inbox" or "when I get a GitHub notification, make a todo". Use WORKFLOW with op="create_trigger" and a clear displayName, instructions, and any needed schedule.\n' +
  '- Workflow: a multi-step workflow pipeline with deterministic steps and integrations, for example "when a Slack message matches X, post to Discord and log it". Use WORKFLOW with op="create" and a clear seedPrompt.\n' +
  "Ask one short clarifying question only if the shape is genuinely " +
  "ambiguous; otherwise create immediately. After creation, briefly " +
  "confirm what you made and how it starts.";

const NODE_CLASS_ORDER = [
  "agent",
  "action",
  "context",
  "integration",
  "trigger",
  "flow-control",
] as const;

const PAGE_CHAT_PREFILL_EVENT = "eliza:chat:prefill";
const DESCRIBE_WORKFLOW_PROMPT = "Describe your workflow";
const DESCRIBE_AUTOMATION_PROMPT = "What should happen?";
const WORKFLOW_PROMPT_PLACEHOLDER =
  "Describe the trigger and steps, e.g. when a GitHub issue opens, summarize it and post to Discord";
const AUTOMATION_PROMPT_PLACEHOLDER =
  "e.g. Every morning summarize my inbox, or when a GitHub issue opens, triage it";
const AUTOMATIONS_OVERVIEW_VISIBILITY_EVENT =
  "eliza:automations:overview-visibility";

interface AutomationsOverviewVisibilityDetail {
  visible: boolean;
}

type AutomationsOverviewWindow = Window & {
  __elizaAutomationsOverviewVisible?: boolean;
};

function createWorkflowDraftId(): string {
  return globalThis.crypto.randomUUID();
}

function prefillPageChat(text: string, options?: { select?: boolean }): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(PAGE_CHAT_PREFILL_EVENT, {
      detail: {
        text,
        select: options?.select ?? true,
      },
    }),
  );
}

function buildWorkflowCopyRequest(
  workflow: WorkflowDefinition,
  name: string,
): WorkflowDefinitionWriteRequest {
  return {
    name,
    nodes:
      workflow.nodes?.map((node) => ({
        name: node.name,
        type: node.type,
        typeVersion: node.typeVersion ?? 1,
        position: node.position ?? [0, 0],
        parameters: node.parameters ?? {},
        ...(node.notes ? { notes: node.notes } : {}),
        ...(node.notesInFlow !== undefined
          ? { notesInFlow: node.notesInFlow }
          : {}),
      })) ?? [],
    connections: workflow.connections ?? {},
    settings: {},
  };
}

function inferAutomationPromptKind(prompt: string): "task" | "workflow" {
  const normalized = prompt.toLowerCase();
  const looksScheduledTask =
    /\b(every|daily|hourly|weekly|monthly|weekday|morning|evening|at \d{1,2})\b/.test(
      normalized,
    );
  const looksWorkflow =
    /\b(when|if|after|then|workflow|pipeline|webhook|event|triage|route|label|enrich|crm)\b/.test(
      normalized,
    ) ||
    (normalized.includes(" and ") &&
      /\b(send|post|create|update|reply|notify|summarize)\b/.test(normalized));

  if (looksScheduledTask && !normalized.includes("when ")) return "task";
  return looksWorkflow ? "workflow" : "task";
}

function titleFromAutomationPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "New task";
  const title = cleaned.split(" ").slice(0, 7).join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

// Reads `#automations.trigger=<id>` from the URL hash. The LifeOps chat-sidebar
// Automations widget writes this when a row is clicked, so /automations can
// focus the matching trigger card on navigation. Duplicated here (instead of
// cross-importing from @elizaos/app-lifeops) to keep the package dep graph
// one-way (app-lifeops → app-core).
const AUTOMATIONS_TRIGGER_HASH_KEY = "automations.trigger";

function readAutomationsTriggerFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!raw) return null;
  for (const chunk of raw.split("&")) {
    if (!chunk) continue;
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    try {
      const key = decodeURIComponent(chunk.slice(0, eq));
      if (key !== AUTOMATIONS_TRIGGER_HASH_KEY) continue;
      const value = decodeURIComponent(chunk.slice(eq + 1));
      return value || null;
    } catch {
      // Skip malformed encodings.
    }
  }
  return null;
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
  if (item.type === "workflow") return "workflow";
  if (item.task) return "task";
  if (item.trigger) return "trigger";
  return null;
}

function getAutomationDisplayTitle(item: AutomationItem): string {
  return item.isDraft ? "Draft" : item.title;
}

function getOverviewDisplayTitle(item: AutomationItem): string {
  if (!item.isDraft) {
    return getAutomationDisplayTitle(item);
  }
  if (item.type === "automation_draft") {
    return "Draft automation";
  }
  return `Draft ${getAutomationGroupLabel(item).toLowerCase()}`;
}

function getAutomationGroupLabel(item: AutomationItem): string {
  if (item.type === "workflow") {
    return "Workflow";
  }
  if (item.system) {
    return "Agent owned";
  }
  return "Task";
}

function collectScheduledAutomationEntries(
  items: AutomationItem[],
): ScheduledAutomationEntry[] {
  return items.flatMap((item) =>
    item.schedules.map((schedule) => ({
      item,
      schedule,
      key: `${item.id}:${schedule.id}`,
    })),
  );
}

function isTimeBasedTrigger(trigger: TriggerSummary): boolean {
  return trigger.triggerType !== "event";
}

function formatScheduleCount(count: number): string {
  return count === 1 ? "1 schedule" : `${count} schedules`;
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

function getAutomationUpdatedAtMs(item: AutomationItem): number {
  if (!item.updatedAt) {
    return 0;
  }
  const ts = Date.parse(item.updatedAt);
  return Number.isFinite(ts) ? ts : 0;
}

function sortAutomationsByUpdatedAtDesc(
  items: AutomationItem[],
): AutomationItem[] {
  return [...items].sort(
    (left, right) =>
      getAutomationUpdatedAtMs(right) - getAutomationUpdatedAtMs(left),
  );
}

function getAutomationIndicatorTone(
  item: AutomationItem,
): "accent" | undefined {
  if (item.type === "workflow") {
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

function getAutomationStatusTone(
  item: AutomationItem,
): "success" | "warning" | "muted" | "danger" {
  if (item.isDraft) return "warning";
  if (item.type === "workflow") {
    return item.enabled ? "success" : "muted";
  }
  if (item.trigger) {
    const lastTone = toneForLastStatus(item.trigger.lastStatus);
    if (lastTone === "danger") return "danger";
    return item.trigger.enabled ? "success" : "muted";
  }
  if (item.task) {
    return item.task.isCompleted ? "muted" : "success";
  }
  return "muted";
}

function getTriggerWakeModeLabel(trigger: TriggerSummary): string {
  return trigger.wakeMode === "inject_now"
    ? "Interrupt and run now"
    : "Queue for next cycle";
}

function getTriggerStartModeLabel(trigger: TriggerSummary): string {
  if (trigger.triggerType === "once") return "One time";
  if (trigger.triggerType === "cron") return "Cron schedule";
  if (trigger.triggerType === "event") return "Event";
  return "Repeating";
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
  if (trigger.triggerType === "event") {
    return `Event: ${trigger.eventKind ?? "event"}.`;
  }
  return `Schedule type: ${trigger.triggerType}.`;
}

function buildWorkflowCompilationPrompt(item: AutomationItem): string {
  const lines = [
    "Compile this coordinator automation into an workflow.",
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
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatusResponse | null>(null);
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
        setWorkflowStatus(automationData.workflowStatus ?? null);
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
    window.addEventListener("eliza:automations:setFilter", handler);
    return () =>
      window.removeEventListener("eliza:automations:setFilter", handler);
  }, []);

  const allItems = automationItems;
  const filteredItems = useMemo(() => {
    switch (filter) {
      case "coordinator":
        return allItems.filter((item) => item.type === "coordinator_text");
      case "workflows":
        return allItems.filter((item) => item.type === "workflow");
      case "scheduled":
        return allItems.filter((item) => item.schedules.length > 0);
      default:
        return allItems;
    }
  }, [allItems, filter]);

  useEffect(() => {
    if (!selectedItemId) return;
    // Exempt in-flight workflow drafts — they're not in allItems until
    // generateWorkflowFromPrompt finishes and refreshAutomations
    // surfaces the real workflow. Without this exemption the draft
    // selection gets cleared mid-generation, the auto-select effect
    // below picks lastSelectedIdRef (typically a task like Heartbeat),
    // and the user lands somewhere unexpected — defeating the
    // WorkflowGenerationProgress UI we just added on the draft pane.
    if (selectedItemId.startsWith("workflow-draft:")) return;
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

  // When the LifeOps chat-sidebar Automations widget row is clicked, it
  // writes `#automations.trigger=<id>` and `setTab("automations")`s over.
  // Read the hash on mount and on any hashchange to focus that trigger.
  useEffect(() => {
    function applyHash(): void {
      const hashTriggerId = readAutomationsTriggerFromHash();
      if (!hashTriggerId) return;
      const nextId = `trigger:${hashTriggerId}`;
      setSelectedItemId((prev) => (prev === nextId ? prev : nextId));
      setSelectedItemKind("trigger");
    }
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

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
    openCreateTrigger();
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
        if (updated.kind === "workflow" && updated.workflowId) {
          setSelectedItemId(`workflow:${updated.workflowId}`);
          setSelectedItemKind("workflow");
        } else {
          setSelectedItemId(`trigger:${updated.id}`);
          setSelectedItemKind("trigger");
        }
        await refreshAutomations();
        closeEditor();
      }
      return;
    }

    const created = await createTrigger(buildCreateRequest(form));
    if (created) {
      if (created.kind === "workflow" && created.workflowId) {
        setSelectedItemId(`workflow:${created.workflowId}`);
        setSelectedItemKind("workflow");
      } else {
        setSelectedItemId(`trigger:${created.id}`);
        setSelectedItemKind("trigger");
      }
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

  const onDeleteTrigger = async (triggerId?: string, displayName?: string) => {
    const targetId = triggerId ?? editingId;
    if (!targetId) return;
    const confirmed = await confirmDesktopAction({
      title: t("heartbeatsview.deleteTitle"),
      message: t("heartbeatsview.deleteMessage", {
        name: displayName ?? form.displayName,
      }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      type: "warning",
    });
    if (!confirmed) return;

    const deleted = await deleteTrigger(targetId);
    if (!deleted) return;

    if (selectedItemId === `trigger:${targetId}`) {
      setSelectedItemId(null);
      setSelectedItemKind(null);
    }
    await refreshAutomations();
    if (targetId === editingId) {
      closeEditor();
    }
  };

  const onDeleteTask = async (taskId: string) => {
    const confirmed = await confirmDesktopAction({
      title: t("automations.taskDeleteTitle", {
        defaultValue: "Delete task",
      }),
      message: t("automations.taskDeleteMessage", {
        defaultValue: "Are you sure you want to delete this task?",
      }),
      confirmLabel: t("common.delete"),
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
      const found = allItems.find((item) => item.id === selectedItemId);
      if (found) return found;
      // In-flight workflow draft (createWorkflowDraft set selectedItemId
      // BEFORE refreshAutomations surfaced the real workflow). Synthesize
      // a minimal draft item so AutomationDraftPane renders with the
      // WorkflowGenerationProgress card during the LLM call.
      //
      // The `room` field is left null here. `activeWorkflowConversation`
      // — the live conversation tied to this draft — lives in
      // AutomationsLayout (a different scope from this controller hook),
      // so we cannot read it from here without a larger refactor.
      // Instead, handleDeleteDraft reads activeWorkflowConversation
      // directly and falls back to it when item.room is missing on a
      // synthesized draft (see the handler below).
      if (selectedItemId.startsWith("workflow-draft:")) {
        const draftId = selectedItemId.slice("workflow-draft:".length);
        const synthesized: AutomationItem = {
          id: selectedItemId,
          type: "automation_draft",
          source: "workflow_draft",
          title: "New workflow",
          description: "",
          status: "draft",
          enabled: false,
          system: false,
          isDraft: true,
          hasBackingWorkflow: false,
          updatedAt: null,
          draftId,
          schedules: [],
          room: null,
        };
        return synthesized;
      }
      return null;
    }
    return allItems[0] ?? null;
  }, [allItems, editingId, editingTaskId, editorOpen, selectedItemId]);

  const modalTitle =
    editorMode === "trigger"
      ? form.kind === "workflow"
        ? editingId
          ? `Edit ${form.displayName.trim() || "schedule"}`
          : "New schedule"
        : editingId
          ? t("heartbeatsview.editTitle", {
              name:
                form.displayName.trim() ||
                t("automations.taskLabel", {
                  defaultValue: "Task",
                }),
              defaultValue: "Edit {{name}}",
            })
          : t("automations.newTask", {
              defaultValue: "New task",
            })
      : editingTaskId
        ? t("automations.editTask", {
            defaultValue: "Edit task",
          })
        : t("automations.newTextTask", {
            defaultValue: "New text task",
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
    setEditorMode,
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
    workflowStatus,
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
      <div className="flex items-center gap-1">
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
          <Chevron
            aria-hidden
            className="ml-auto h-3 w-3 shrink-0 text-muted"
          />
        </button>
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            aria-label={addLabel ?? "Add"}
            title={addLabel}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {collapsed ? null : count === 0 ? (
        <div className="py-1 pl-8 pr-1 text-2xs text-muted/70">
          {emptyLabel}
        </div>
      ) : (
        <div className="space-y-0 pl-3 pr-0.5">{children}</div>
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
      <DialogContent className="w-[min(calc(100vw_-_1.5rem),56rem)] max-w-none">
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

        <div className="grid gap-3 overflow-y-auto pr-1 sm:grid-cols-2 max-h-[min(32rem,calc(100dvh_-_12rem))]">
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

function CreateAutomationDialog({
  open,
  onOpenChange,
  onCreateTask,
  onCreateWorkflow,
  onDescribeAutomation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateTask: () => void;
  onCreateWorkflow: () => void;
  onDescribeAutomation: (prompt: string) => Promise<void> | void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100vw_-_1.5rem),34rem)] max-w-none">
        <DialogHeader>
          <DialogTitle>Create automation</DialogTitle>
        </DialogHeader>

        <AutomationCommandBar
          autoFocus
          onSubmit={async (prompt) => {
            await onDescribeAutomation(prompt);
            onOpenChange(false);
          }}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={onCreateTask}
            className="rounded-xl border border-border/30 bg-bg/30 p-4 text-left transition-colors hover:border-accent/40 hover:bg-accent/5"
          >
            <div className="text-sm font-semibold text-txt">Task</div>
          </button>
          <button
            type="button"
            onClick={onCreateWorkflow}
            className="rounded-xl border border-border/30 bg-bg/30 p-4 text-left transition-colors hover:border-accent/40 hover:bg-accent/5"
          >
            <div className="text-sm font-semibold text-txt">Workflow</div>
          </button>
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
          <FieldLabel>Task name</FieldLabel>
          <Input
            value={taskFormName}
            onChange={(event) => setTaskFormName(event.target.value)}
            placeholder="Task name..."
            autoFocus
          />
        </div>
        <div>
          <FieldLabel>Prompt</FieldLabel>
          <Textarea
            value={taskFormDescription}
            onChange={(event) => setTaskFormDescription(event.target.value)}
            placeholder="What should this task do?"
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
            ? t("automations.saveTask", {
                defaultValue: "Save task",
              })
            : t("automations.createTask", {
                defaultValue: "Create task",
              })}
        </Button>
        {editingTaskId && (
          <Button
            variant="outline"
            size="sm"
            className="border-danger/30 text-danger hover:bg-danger/10"
            onClick={() => void onDeleteTask(editingTaskId)}
          >
            {t("common.delete")}
          </Button>
        )}
      </div>
    </PagePanel>
  );
}

/**
 * Render a single clarification ("Which channel in Cozy Devs?") with a row
 * of quick-pick buttons drawn from the catalog. Falls back to a hint when
 * the catalog has no entries for the clarification's platform/scope (e.g.
 * the user only configured Discord but the LLM asked about Slack), since
 * the user has nothing to pick from in that case.
 */
function ClarificationPanel({
  state,
  onChoose,
  onDismiss,
}: {
  state: {
    response: WorkflowDefinitionNeedsClarificationResponse;
    currentIndex: number;
    busy: boolean;
    error?: string;
  };
  onChoose: (paramPath: string, value: string) => void;
  onDismiss: () => void;
}) {
  const current = state.response.clarifications[state.currentIndex];
  if (!current) return null;

  const options = optionsForClarification(state.response.catalog, current);
  // Used as React key so chained clarifications (e.g. target_server →
  // target_channel) force a fresh ChoiceWidget instance instead of inheriting
  // the previous pick's locked/disabled internal state. Also doubled as the
  // widget's data id.
  const choiceId = `workflow-clarification-${current.paramPath || "free-text"}`;

  return (
    <PagePanel
      variant="padded"
      className="mb-4 border border-accent/40 bg-accent/5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2 min-w-0 flex-1">
          <p className="text-sm font-semibold text-txt">{current.question}</p>
          {state.response.clarifications.length > 1 ? (
            <p className="text-2xs text-muted">
              Step {state.currentIndex + 1} of{" "}
              {state.response.clarifications.length}
            </p>
          ) : null}
          {options.length > 0 ? (
            <ChoiceWidget
              key={choiceId}
              id={choiceId}
              scope="workflow-clarification"
              options={options}
              onChoose={(value) => {
                if (state.busy) return;
                onChoose(current.paramPath, value);
              }}
            />
          ) : (
            <ClarificationFreeTextInput
              key={choiceId}
              busy={state.busy}
              onSubmit={(value) => onChoose(current.paramPath, value)}
              placeholderHint={current.platform}
            />
          )}
          {state.error ? (
            <p className="text-2xs text-danger">{state.error}</p>
          ) : null}
          {state.busy ? (
            <p className="text-2xs text-muted">Applying choice…</p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted hover:text-txt"
          onClick={onDismiss}
          disabled={state.busy}
        >
          Cancel
        </Button>
      </div>
    </PagePanel>
  );
}

/**
 * Filter the catalog snapshot down to the picker options for one
 * clarification. Channel pickers narrow to a single guild via
 * `scope.guildId`. Server pickers list one entry per group. Free-text and
 * value clarifications fall back to a text input (returns []).
 */
function optionsForClarification(
  catalog: ReadonlyArray<WorkflowClarificationTargetGroup>,
  clarification: WorkflowClarificationRequest,
): Array<{ value: string; label: string }> {
  const platform = clarification.platform;
  if (!platform) return [];
  const groups = catalog.filter((g) => g.platform === platform);
  if (groups.length === 0) return [];

  switch (clarification.kind) {
    case "target_server":
      return groups.map((g) => ({
        value: g.groupId,
        label: g.groupName,
      }));
    case "target_channel": {
      const guildId = clarification.scope?.guildId;
      const scoped = guildId
        ? groups.filter((g) => g.groupId === guildId)
        : groups;
      const out: Array<{ value: string; label: string }> = [];
      for (const g of scoped) {
        for (const t of g.targets) {
          if (t.kind !== "channel") continue;
          // When we have multiple guilds in scope, prefix the label so the
          // user can disambiguate same-named channels.
          const label =
            scoped.length > 1 ? `${g.groupName}/#${t.name}` : `#${t.name}`;
          out.push({ value: t.id, label });
        }
      }
      return out;
    }
    case "recipient": {
      const out: Array<{ value: string; label: string }> = [];
      for (const g of groups) {
        for (const t of g.targets) {
          if (t.kind !== "recipient") continue;
          out.push({ value: t.id, label: t.name });
        }
      }
      return out;
    }
    default:
      return [];
  }
}

function ClarificationFreeTextInput({
  busy,
  onSubmit,
  placeholderHint,
}: {
  busy: boolean;
  onSubmit: (value: string) => void;
  placeholderHint?: string;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || trimmed.length === 0) return;
        onSubmit(trimmed);
      }}
      className="mt-1 flex items-center gap-2"
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={
          placeholderHint
            ? `Enter a value for ${placeholderHint}…`
            : "Type your answer…"
        }
        disabled={busy}
        className="h-8 text-xs"
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={busy || trimmed.length === 0}
      >
        Apply
      </Button>
    </form>
  );
}

function WorkflowRuntimeNotice({
  status,
  workflowFetchError,
  busy,
  onRefresh,
}: {
  status: WorkflowStatusResponse | null;
  workflowFetchError: string | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  if (!status && !workflowFetchError) {
    return null;
  }

  if (status?.mode === "disabled") {
    return (
      <div className="mb-2 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border/25 bg-bg/30 px-3 py-1.5 text-xs-tight">
        <span className="text-muted">
          Workflow runtime is unavailable. Text tasks still work without it.
        </span>
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
          <span className="text-danger/90">Workflow runtime is unavailable.</span>
        </div>
        <div className="flex items-center gap-3">
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
  const disabledCount = nodes.filter(
    (n) => n.availability === "disabled",
  ).length;

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
                  title={node.disabledReason || node.description || node.label}
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
  return <AutomationNodePalette nodes={nodes} title="Nodes" />;
}

function TaskAutomationDetailPane({
  automation,
  onPromoteToWorkflow,
}: {
  automation: AutomationItem;
  onPromoteToWorkflow: (item: AutomationItem) => Promise<void>;
}) {
  const {
    openEditTask,
    onDeleteTask,
    onToggleTaskCompleted,
    setEditorOpen,
    setEditorMode,
    setTaskFormDescription,
    setTaskFormName,
    setEditingTaskId,
    setSelectedItemId,
    setSelectedItemKind,
    t,
    uiLanguage,
  } = useAutomationsViewContext();
  const task = automation.task;

  if (!task) {
    return null;
  }

  const statusLabel = automation.system
    ? "System"
    : task.isCompleted
      ? "Completed"
      : "Open";
  const statusTone: "success" | "warning" | "muted" | "danger" =
    automation.system ? "muted" : task.isCompleted ? "muted" : "success";
  const nextScheduledRun = automation.schedules
    .filter(isTimeBasedTrigger)
    .map((schedule) => schedule.nextRunAtMs ?? 0)
    .filter((value) => value > 0)
    .sort((left, right) => left - right)[0];
  const taskTypeLabel = automation.system ? "Agent owned" : "Task";

  return (
    <div className="space-y-4">
      <DetailHeader
        icon={
          automation.system ? (
            <Settings className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <FileText className="h-3.5 w-3.5" aria-hidden />
          )
        }
        title={getAutomationDisplayTitle(automation)}
        description={
          automation.description ||
          (automation.system ? "Internal manual task." : "Simple text task.")
        }
        status={
          <DetailStatusIndicator
            label={statusLabel}
            tone={statusTone}
            dotOnly={!automation.system && !task.isCompleted}
          />
        }
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
                label="Duplicate"
                onClick={() => {
                  setTaskFormName(`${task.name} copy`);
                  setTaskFormDescription(task.description);
                  setEditingTaskId(null);
                  setEditorMode("task");
                  setSelectedItemId(null);
                  setSelectedItemKind(null);
                  setEditorOpen(true);
                }}
                icon={<Copy className="h-3.5 w-3.5" />}
              />
              <IconAction
                label="Compile to Workflow"
                onClick={() => void onPromoteToWorkflow(automation)}
                icon={<GitBranch className="h-3.5 w-3.5" />}
              />
              <IconAction
                label={t("common.edit")}
                onClick={() => openEditTask(task)}
                icon={<EditIcon className="h-3.5 w-3.5" />}
              />
              <IconAction
                label={t("common.delete")}
                onClick={() => void onDeleteTask(task.id)}
                icon={<Trash2 className="h-3.5 w-3.5" />}
                tone="danger"
              />
            </>
          ) : null
        }
      />
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <OverviewMetricCard
          label="Task type"
          value={taskTypeLabel}
          detail={
            automation.schedules.length > 0
              ? formatScheduleCount(automation.schedules.length)
              : "Run it manually"
          }
        />
        <OverviewMetricCard
          label="Status"
          value={statusLabel}
          detail={task.isCompleted ? "Already completed" : "Still open"}
          tone={task.isCompleted ? "default" : "ok"}
        />
        <OverviewMetricCard
          label="Starts"
          value={
            nextScheduledRun
              ? formatRelativeFuture(nextScheduledRun, t)
              : "Manual"
          }
          detail={
            nextScheduledRun
              ? formatDateTime(nextScheduledRun, {
                  fallback: "—",
                  locale: uiLanguage,
                })
              : "Run it yourself or attach a schedule"
          }
          tone={nextScheduledRun ? "ok" : "default"}
        />
        <OverviewMetricCard
          label="Updated"
          value={formatRelativePast(automation.updatedAt, t)}
          detail={formatDateTime(automation.updatedAt, { fallback: "—" })}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.12fr)_minmax(320px,0.88fr)]">
        <div className="space-y-4">
          <DetailSection title="Prompt">
            <div className="min-h-[10rem] px-4 py-4 text-sm leading-relaxed text-muted/85 whitespace-pre-wrap">
              {task.description || "Describe what this task should do."}
            </div>
          </DetailSection>

          <DetailSection
            title={
              automation.schedules.length > 0 ? "Starts when" : "How it starts"
            }
          >
            {automation.schedules.length > 0 ? (
              <div className="divide-y divide-border/20">
                {automation.schedules.map((schedule) => (
                  <OverviewListItem
                    key={schedule.id}
                    title={schedule.displayName}
                    meta={scheduleLabel(schedule, t, uiLanguage)}
                    detail={formatDateTime(schedule.nextRunAtMs ?? null, {
                      fallback: "No next run queued",
                      locale: uiLanguage,
                    })}
                    trailing={schedule.enabled ? "Live" : "Paused"}
                    tone={schedule.enabled ? "success" : "muted"}
                  />
                ))}
              </div>
            ) : (
              <div className="px-4 py-4 text-xs-tight text-muted/70">
                This task is manual right now. Add a schedule if you want it to
                start on its own.
              </div>
            )}
          </DetailSection>
        </div>

        <div className="space-y-4">
          <DetailSection title="Details">
            <DetailFactList
              items={[
                {
                  label: "State",
                  value: task.isCompleted ? "Completed" : "Open",
                },
                {
                  label: "Source",
                  value: automation.system
                    ? "Internal checklist item"
                    : "Simple prompt task",
                },
                {
                  label: "Next run",
                  value: nextScheduledRun
                    ? formatDateTime(nextScheduledRun, {
                        fallback: "—",
                        locale: uiLanguage,
                      })
                    : "Manual",
                },
                {
                  label: "Tags",
                  value:
                    task.tags.length > 0 ? (
                      <div className="flex flex-wrap justify-end gap-1">
                        {task.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-bg/50 px-1.5 py-0.5 text-[10px] text-muted"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      "None"
                    ),
                },
              ]}
            />
          </DetailSection>
        </div>
      </div>
    </div>
  );
}

interface AutomationExample {
  icon: LucideIcon;
  label: string;
  blurb: string;
  prompt: string;
  kind: "task" | "workflow";
}

const AUTOMATION_DRAFT_EXAMPLES: AutomationExample[] = [
  {
    icon: Mail,
    kind: "task",
    label: "Daily inbox digest",
    blurb: "A simple recurring prompt that keeps your morning brief tight.",
    prompt:
      "Every weekday at 9am, summarize my Gmail inbox from the last 24 hours and post the summary to my #daily channel in Slack.",
  },
  {
    icon: Clock3,
    kind: "task",
    label: "Hourly health check",
    blurb: "A lightweight prompt that watches for anything stuck or failing.",
    prompt:
      "Every hour, review recent activity, check that nothing is stuck or errored, and notify me if anything needs attention.",
  },
  {
    icon: GitBranch,
    kind: "workflow",
    label: "GitHub issue triage",
    blurb: "An event-driven pipeline that labels, routes, and replies.",
    prompt:
      "When a new issue is opened on my GitHub repo, classify it (bug / feature / question / docs), add the matching label, and post a welcoming comment.",
  },
  {
    icon: Share2,
    kind: "workflow",
    label: "Lead handoff",
    blurb: "A cross-app flow that enriches, routes, and notifies.",
    prompt:
      "When a new website lead arrives, enrich it, create the contact in my CRM, and post a summary to Slack for the team.",
  },
];

function OverviewIdeaGrid({
  ideas,
  onSelect,
}: {
  ideas: AutomationExample[];
  onSelect: (idea: AutomationExample) => void;
}) {
  return (
    <div className="grid gap-1.5">
      {ideas.map((idea) => {
        const Icon = idea.icon;
        return (
          <button
            key={idea.label}
            type="button"
            onClick={() => onSelect(idea)}
            className="group flex items-start gap-2 rounded-[var(--radius-sm)] border border-border/25 bg-bg/30 px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-accent/5"
          >
            <Icon
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent/80"
              aria-hidden
            />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-center gap-2">
                <div className="truncate text-xs-tight font-semibold text-txt">
                  {idea.label}
                </div>
                <span className="rounded bg-bg/50 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted/70">
                  {idea.kind}
                </span>
              </div>
              <div className="text-[11px] leading-snug text-muted/70">
                {idea.blurb}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function AutomationCommandBar({
  onSubmit,
  autoFocus = false,
}: {
  onSubmit: (prompt: string) => Promise<void> | void;
  autoFocus?: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      setPrompt("");
    } finally {
      setSubmitting(false);
    }
  }, [onSubmit, prompt, submitting]);

  return (
    <div className="rounded-2xl border border-border/30 bg-bg/55 p-1.5 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={AUTOMATION_PROMPT_PLACEHOLDER}
          aria-label={DESCRIBE_AUTOMATION_PROMPT}
          className="min-h-11 flex-1 border-0 bg-transparent px-4 text-sm shadow-none focus-visible:ring-0"
          autoFocus={autoFocus}
        />
        <Button
          variant="default"
          size="sm"
          className="h-10 shrink-0 rounded-xl px-4 text-sm"
          disabled={submitting || prompt.trim().length === 0}
          onClick={() => void submit()}
        >
          {submitting ? "Creating..." : "Create"}
        </Button>
      </div>
    </div>
  );
}

function AutomationStatusStrip({
  entries,
}: {
  entries: Array<{
    label: string;
    value: number;
    tone: "success" | "warning" | "muted" | "danger";
  }>;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map((entry) => (
        <div
          key={entry.label}
          className="inline-flex items-center gap-2 rounded-full border border-border/25 bg-bg/40 px-2.5 py-1 text-xs"
        >
          <StatusDot tone={entry.tone} />
          <span className="font-medium text-txt">{entry.label}</span>
          <span className="tabular-nums text-muted">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

function formatRelativeFuture(
  targetMs: number,
  t?: (
    key: string,
    options?: { defaultValue?: string; value?: number },
  ) => string,
): string {
  const delta = targetMs - Date.now();
  if (delta <= 0) return "now";
  return `in ${formatDurationMs(delta, { t })}`;
}

function formatRelativePast(
  iso: string | number | null | undefined,
  t?: (
    key: string,
    options?: { defaultValue?: string; value?: number },
  ) => string,
): string {
  if (!iso) return "—";
  const ts = typeof iso === "string" ? Date.parse(iso) : iso;
  if (!Number.isFinite(ts)) return "—";
  const delta = Date.now() - ts;
  if (delta < 0) return "now";
  return `${formatDurationMs(delta, { t })} ago`;
}

function OverviewMetricCard({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  tone?: "default" | "ok" | "warning" | "danger";
}) {
  const valueClass =
    tone === "ok"
      ? "text-ok"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-danger"
          : "text-txt";

  return (
    <div className="rounded-xl border border-border/25 bg-bg/35 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted/70">
        {label}
      </div>
      <div className={`mt-2 text-lg font-semibold leading-none ${valueClass}`}>
        {value}
      </div>
      <div className="mt-2 text-[11px] leading-snug text-muted/70">
        {detail}
      </div>
    </div>
  );
}

function OverviewListItem({
  title,
  badge,
  meta,
  detail,
  trailing,
  tone = "muted",
  onClick,
}: {
  title: string;
  badge?: string;
  meta?: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  tone?: "success" | "warning" | "muted" | "danger";
  onClick?: () => void;
}) {
  const content = (
    <div className="flex items-start gap-2">
      <StatusDot tone={tone} className="mt-1 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-txt">{title}</span>
          {badge ? (
            <span className="rounded bg-bg/50 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted/70">
              {badge}
            </span>
          ) : null}
          {trailing ? (
            <span className="ml-auto shrink-0 text-[11px] text-muted/70">
              {trailing}
            </span>
          ) : null}
        </div>
        {meta ? (
          <div className="mt-0.5 text-[11px] leading-snug text-muted/70">
            {meta}
          </div>
        ) : null}
        {detail ? (
          <div className="mt-1 line-clamp-1 text-[11px] leading-snug text-muted/60">
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (!onClick) {
    return <div className="px-3 py-2 text-xs-tight">{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-3 py-2 text-left text-xs-tight transition-colors hover:bg-bg-muted/40"
    >
      {content}
    </button>
  );
}

function HeroEmptyState({
  ideas,
  onSubmit,
  drafts,
  onSelectDraft,
  onDeleteDraft,
  t,
}: {
  ideas: AutomationExample[];
  onSubmit: (text: string) => void;
  drafts: AutomationItem[];
  onSelectDraft: (item: AutomationItem) => void;
  onDeleteDraft?: (item: AutomationItem) => void | Promise<void>;
  t: AutomationsViewController["t"];
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const submit = useCallback(() => {
    const text = value.trim();
    if (text.length === 0) return;
    setValue("");
    onSubmit(text);
  }, [onSubmit, value]);

  const handleChipSelect = useCallback((idea: AutomationExample) => {
    setValue(idea.prompt);
    textareaRef.current?.focus();
  }, []);

  const canSubmit = value.trim().length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 py-10">
      <div className="w-full max-w-[560px] space-y-3">
        <div className="relative">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Describe a task or workflow…"
            rows={2}
            variant="form"
            className="resize-none pr-12"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute bottom-2 right-2 h-7 w-7 p-0"
            onClick={submit}
            disabled={!canSubmit}
            aria-label="Submit"
          >
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {ideas.map((idea) => (
            <button
              key={idea.label}
              type="button"
              onClick={() => handleChipSelect(idea)}
              className="rounded-full border border-border/50 bg-bg-accent px-2.5 py-1 text-xs text-txt transition-colors hover:border-accent/40 hover:bg-accent/5"
            >
              {idea.label}
            </button>
          ))}
        </div>
      </div>
      {drafts.length > 0 && (
        <div className="w-full max-w-[560px]">
          <DetailSection title="Drafts in progress">
            <div className="divide-y divide-border/20">
              {drafts.map((item) => (
                <div key={item.id} className="flex items-stretch gap-1">
                  <div className="min-w-0 flex-1">
                    <OverviewListItem
                      onClick={() => onSelectDraft(item)}
                      title={getOverviewDisplayTitle(item)}
                      badge="Draft"
                      meta={formatRelativePast(item.updatedAt, t)}
                      detail={
                        item.description.trim() ||
                        "Open it and keep shaping it in the sidebar agent."
                      }
                      tone="warning"
                    />
                  </div>
                  {onDeleteDraft && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto w-8 shrink-0 self-center text-muted hover:bg-danger/10 hover:text-danger"
                      onClick={() => void onDeleteDraft(item)}
                      aria-label="Delete draft"
                      title="Delete draft"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </DetailSection>
        </div>
      )}
    </div>
  );
}

// biome-ignore lint/correctness/noUnusedVariables: reserved for future dashboard view
function AutomationsDashboard({
  items,
  onSelectItem,
  onCreateTask,
  onCreateWorkflow,
  onDescribeAutomation,
  onUseIdea,
}: {
  items: AutomationItem[];
  onSelectItem: (item: AutomationItem) => void;
  onCreateTask: () => void;
  onCreateWorkflow: () => void;
  onDescribeAutomation: (prompt: string) => Promise<void> | void;
  onUseIdea: (idea: AutomationExample) => void;
}) {
  const { t, uiLanguage } = useAutomationsViewContext();
  const now = Date.now();

  const visibleItems = useMemo(
    () => items.filter((item) => !item.system),
    [items],
  );

  const scheduledEntries = useMemo(
    () => collectScheduledAutomationEntries(visibleItems),
    [visibleItems],
  );
  const draftItems = useMemo(
    () =>
      sortAutomationsByUpdatedAtDesc(
        visibleItems.filter((item) => item.isDraft),
      ).slice(0, 4),
    [visibleItems],
  );
  const taskHighlights = useMemo(
    () =>
      sortAutomationsByUpdatedAtDesc(
        visibleItems.filter((item) => item.type !== "workflow"),
      ).slice(0, 6),
    [visibleItems],
  );
  const workflowHighlights = useMemo(
    () =>
      sortAutomationsByUpdatedAtDesc(
        visibleItems.filter((item) => item.type === "workflow"),
      ).slice(0, 6),
    [visibleItems],
  );
  const liveItems = useMemo(
    () =>
      sortAutomationsByUpdatedAtDesc(
        visibleItems.filter((item) => item.enabled && !item.isDraft),
      ).slice(0, 5),
    [visibleItems],
  );
  const recentItems = useMemo(
    () => sortAutomationsByUpdatedAtDesc(visibleItems).slice(0, 6),
    [visibleItems],
  );

  const taskCount = visibleItems.filter(
    (item) => item.type !== "workflow",
  ).length;
  const workflowCount = visibleItems.filter(
    (item) => item.type === "workflow",
  ).length;

  const activeCount = visibleItems.filter(
    (item) => item.enabled && !item.isDraft,
  ).length;
  const activeScheduleCount = scheduledEntries.filter(
    ({ schedule }) => schedule.enabled && isTimeBasedTrigger(schedule),
  ).length;
  const activeEventCount = scheduledEntries.filter(
    ({ schedule }) => schedule.enabled && schedule.triggerType === "event",
  ).length;
  const upcoming = useMemo(
    () =>
      scheduledEntries
        .filter(
          ({ schedule }) =>
            schedule.enabled &&
            isTimeBasedTrigger(schedule) &&
            typeof schedule.nextRunAtMs === "number" &&
            schedule.nextRunAtMs > now,
        )
        .sort(
          (a, b) =>
            (a.schedule.nextRunAtMs ?? 0) - (b.schedule.nextRunAtMs ?? 0),
        )
        .slice(0, 6),
    [scheduledEntries, now],
  );

  const failures = useMemo(
    () =>
      scheduledEntries
        .filter(
          ({ schedule }) => toneForLastStatus(schedule.lastStatus) === "danger",
        )
        .slice(0, 5),
    [scheduledEntries],
  );
  const taskIdeas = useMemo(
    () => AUTOMATION_DRAFT_EXAMPLES.filter((idea) => idea.kind === "task"),
    [],
  );
  const workflowIdeas = useMemo(
    () => AUTOMATION_DRAFT_EXAMPLES.filter((idea) => idea.kind === "workflow"),
    [],
  );
  const nextUpcoming = upcoming[0] ?? null;
  const attentionEntries = useMemo(() => {
    const next: Array<{
      key: string;
      item: AutomationItem;
      tone: "warning" | "danger";
      title: string;
      groupLabel: string;
      meta: string;
      detail: string;
      trailing: string;
    }> = failures.map(({ key, item, schedule }) => ({
      key,
      item,
      tone: "danger",
      title: getOverviewDisplayTitle(item),
      groupLabel: getAutomationGroupLabel(item),
      meta: scheduleLabel(schedule, t, uiLanguage),
      detail:
        schedule.lastError?.trim() ||
        `Last run ${formatRelativePast(schedule.lastRunAtIso, t)}.`,
      trailing: formatRelativePast(schedule.lastRunAtIso, t),
    }));

    return next.slice(0, 6);
  }, [failures, t, uiLanguage]);
  const statusEntries = [
    {
      label: "Live",
      value: activeCount,
      tone: activeCount > 0 ? "success" : "muted",
    },
    {
      label: "Timed",
      value: activeScheduleCount,
      tone: activeScheduleCount > 0 ? "success" : "muted",
    },
    {
      label: "Events",
      value: activeEventCount,
      tone: activeEventCount > 0 ? "success" : "muted",
    },
    {
      label: "Attention",
      value: attentionEntries.length,
      tone: attentionEntries.length > 0 ? "danger" : "success",
    },
  ] satisfies Parameters<typeof AutomationStatusStrip>[0]["entries"];

  if (taskCount === 0 && workflowCount === 0) {
    return (
      <div className="space-y-4 px-1 pt-4">
        <section className="overflow-hidden rounded-xl border border-border/25 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.14),transparent_38%),radial-gradient(circle_at_top_right,rgba(34,197,94,0.12),transparent_32%),rgba(255,255,255,0.02)]">
          <div className="space-y-3 px-4 py-4 sm:px-5">
            <div className="inline-flex items-center gap-2 rounded-full border border-border/25 bg-bg/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted/70">
              <LayoutDashboard className="h-3 w-3" aria-hidden />
              Overview
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold text-txt">
                Build your first automation
              </h2>
              <p className="text-xs-tight text-muted/80">
                Workflows handle multi-step pipelines; tasks are simple prompts
                that run on a schedule or from an event.
              </p>
            </div>
            <AutomationCommandBar onSubmit={onDescribeAutomation} autoFocus />
            <div className="flex flex-wrap gap-2">
              <Button variant="default" size="sm" onClick={onCreateTask}>
                New task
              </Button>
              <Button variant="outline" size="sm" onClick={onCreateWorkflow}>
                New workflow
              </Button>
            </div>
          </div>
        </section>

        <div className="grid gap-3 xl:grid-cols-2">
          <DetailSection title="Task ideas">
            <div className="p-2">
              <OverviewIdeaGrid
                ideas={taskIdeas}
                onSelect={(idea) => onUseIdea(idea)}
              />
            </div>
          </DetailSection>

          <DetailSection title="Workflow ideas">
            <div className="p-2">
              <OverviewIdeaGrid
                ideas={workflowIdeas}
                onSelect={(idea) => onUseIdea(idea)}
              />
            </div>
          </DetailSection>
        </div>

        {draftItems.length > 0 && (
          <DetailSection title="Drafts in progress">
            <div className="divide-y divide-border/20">
              {draftItems.map((item) => (
                <OverviewListItem
                  key={item.id}
                  onClick={() => onSelectItem(item)}
                  title={getOverviewDisplayTitle(item)}
                  badge="Draft"
                  meta={formatRelativePast(item.updatedAt, t)}
                  detail={
                    item.description.trim() ||
                    "Open it and keep shaping it in the sidebar agent."
                  }
                  tone="warning"
                />
              ))}
            </div>
          </DetailSection>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 px-1 pt-4">
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <div className="rounded-xl border border-border/25 bg-[radial-gradient(circle_at_top_left,rgba(34,197,94,0.1),transparent_34%),radial-gradient(circle_at_top_right,rgba(56,189,248,0.12),transparent_30%),rgba(255,255,255,0.02)] px-4 py-4 sm:px-5">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-border/25 bg-bg/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted/70">
                <LayoutDashboard className="h-3 w-3" aria-hidden />
                Overview
              </div>
              <AutomationStatusStrip entries={statusEntries} />
            </div>
            <AutomationCommandBar onSubmit={onDescribeAutomation} />
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={onCreateTask}>
                New task
              </Button>
              <Button variant="ghost" size="sm" onClick={onCreateWorkflow}>
                New workflow
              </Button>
            </div>
          </div>
        </div>

        <DetailSection title="Next up" className="h-full">
          {nextUpcoming?.schedule.nextRunAtMs ? (
            <button
              type="button"
              onClick={() => onSelectItem(nextUpcoming.item)}
              className="flex w-full flex-col gap-2 px-4 py-4 text-left transition-colors hover:bg-bg-muted/40"
            >
              <div className="flex items-center gap-2">
                <StatusDot tone="success" className="shrink-0" />
                <span className="truncate text-sm font-semibold text-txt">
                  {getOverviewDisplayTitle(nextUpcoming.item)}
                </span>
                <span className="rounded bg-bg/50 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted/70">
                  {getAutomationGroupLabel(nextUpcoming.item)}
                </span>
              </div>
              <div className="pl-4 text-[11px] text-muted/70">
                {scheduleLabel(nextUpcoming.schedule, t, uiLanguage)}
              </div>
              <div className="pl-4">
                <div className="text-lg font-semibold text-txt">
                  {formatRelativeFuture(nextUpcoming.schedule.nextRunAtMs, t)}
                </div>
                <div className="mt-1 text-[11px] text-muted/70">
                  {formatDateTime(nextUpcoming.schedule.nextRunAtMs, {
                    fallback: "—",
                    locale: uiLanguage,
                  })}
                </div>
              </div>
            </button>
          ) : (
            <div className="flex h-full min-h-[11.75rem] flex-col justify-between gap-3 px-4 py-4">
              <div className="space-y-1">
                <div className="text-sm font-medium text-txt">None queued.</div>
              </div>
              {draftItems[0] ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => onSelectItem(draftItems[0])}
                >
                  Continue draft
                </Button>
              ) : null}
            </div>
          )}
        </DetailSection>
      </section>

      {attentionEntries.length > 0 ? (
        <DetailSection title="Needs attention">
          <div className="divide-y divide-border/20">
            {attentionEntries.map((entry) => (
              <OverviewListItem
                key={entry.key}
                onClick={() => onSelectItem(entry.item)}
                title={entry.title}
                badge={entry.groupLabel}
                meta={entry.meta}
                detail={entry.detail}
                trailing={entry.trailing}
                tone={entry.tone}
              />
            ))}
          </div>
        </DetailSection>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <DetailSection title="Running" className="h-full">
          {liveItems.length > 0 ? (
            <div className="divide-y divide-border/20">
              {liveItems.map((item) => (
                <OverviewListItem
                  key={item.id}
                  onClick={() => onSelectItem(item)}
                  title={getOverviewDisplayTitle(item)}
                  badge={getAutomationGroupLabel(item)}
                  meta={
                    item.schedules[0]
                      ? scheduleLabel(item.schedules[0], t, uiLanguage)
                      : "Manual or event"
                  }
                  trailing={formatRelativePast(item.updatedAt, t)}
                  tone="success"
                />
              ))}
            </div>
          ) : (
            <div className="px-3 py-4 text-xs-tight text-muted/70">
              Nothing live.
            </div>
          )}
        </DetailSection>

        <DetailSection title="Drafts" className="h-full">
          {draftItems.length > 0 ? (
            <div className="divide-y divide-border/20">
              {draftItems.map((item) => (
                <OverviewListItem
                  key={item.id}
                  onClick={() => onSelectItem(item)}
                  title={getOverviewDisplayTitle(item)}
                  badge={getAutomationGroupLabel(item)}
                  meta="Continue"
                  trailing={formatRelativePast(item.updatedAt, t)}
                  tone="warning"
                />
              ))}
            </div>
          ) : (
            <div className="px-3 py-4 text-xs-tight text-muted/70">
              No drafts.
            </div>
          )}
        </DetailSection>
      </div>

      <DetailSection title="Recently changed">
        {recentItems.length > 0 ? (
          <div className="grid divide-y divide-border/20 md:grid-cols-2 md:divide-x md:divide-y-0">
            {recentItems.map((item) => (
              <OverviewListItem
                key={item.id}
                onClick={() => onSelectItem(item)}
                title={getOverviewDisplayTitle(item)}
                badge={getAutomationGroupLabel(item)}
                meta={
                  item.schedules[0]
                    ? scheduleLabel(item.schedules[0], t, uiLanguage)
                    : item.isDraft
                      ? "Draft"
                      : "Manual or event"
                }
                trailing={formatRelativePast(item.updatedAt, t)}
                tone={getAutomationStatusTone(item)}
              />
            ))}
          </div>
        ) : (
          <div className="px-3 py-4 text-xs-tight text-muted/70">
            No recent changes.
          </div>
        )}
      </DetailSection>

      <div className="grid gap-4 xl:grid-cols-2">
        <DetailSection
          title="Tasks"
          className="h-full"
          action={
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onCreateTask}
            >
              New task
            </Button>
          }
        >
          {taskHighlights.length > 0 ? (
            <div className="divide-y divide-border/20">
              {taskHighlights.map((item) => (
                <OverviewListItem
                  key={item.id}
                  onClick={() => onSelectItem(item)}
                  title={getOverviewDisplayTitle(item)}
                  badge={
                    item.isDraft
                      ? "Draft"
                      : item.schedules.length > 0
                        ? formatScheduleCount(item.schedules.length)
                        : undefined
                  }
                  meta={
                    item.isDraft
                      ? "In progress"
                      : item.schedules.length > 0
                        ? scheduleLabel(item.schedules[0], t, uiLanguage)
                        : "Event or manual"
                  }
                  trailing={formatRelativePast(item.updatedAt, t)}
                  tone={getAutomationStatusTone(item)}
                />
              ))}
            </div>
          ) : (
            <div className="px-3 py-4 text-xs-tight text-muted/70">
              No tasks yet.
            </div>
          )}
        </DetailSection>

        <DetailSection
          title="Workflows"
          className="h-full"
          action={
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onCreateWorkflow}
            >
              New workflow
            </Button>
          }
        >
          {workflowHighlights.length > 0 ? (
            <div className="divide-y divide-border/20">
              {workflowHighlights.map((item) => (
                <OverviewListItem
                  key={item.id}
                  onClick={() => onSelectItem(item)}
                  title={getOverviewDisplayTitle(item)}
                  badge={
                    item.isDraft
                      ? "Draft"
                      : `${getWorkflowNodeCount(item)} nodes`
                  }
                  meta={
                    item.isDraft
                      ? "In progress"
                      : item.schedules.length > 0
                        ? scheduleLabel(item.schedules[0], t, uiLanguage)
                        : "Event or manual"
                  }
                  trailing={formatRelativePast(item.updatedAt, t)}
                  tone={getAutomationStatusTone(item)}
                />
              ))}
            </div>
          ) : (
            <div className="px-3 py-4 text-xs-tight text-muted/70">
              No workflows yet.
            </div>
          )}
        </DetailSection>
      </div>
    </div>
  );
}

function AutomationDraftPane({
  automation,
  onSeedPrompt,
  onDeleteDraft,
  isGenerating,
}: {
  automation: AutomationItem;
  onSeedPrompt: (prompt: string) => void;
  onDeleteDraft: (item: AutomationItem) => Promise<void>;
  isGenerating?: boolean;
}) {
  const chatChrome = useAppWorkspaceChatChrome();

  const openSidebarDraftChat = useCallback(
    (prompt: string) => {
      chatChrome?.openChat();
      onSeedPrompt(prompt);
    },
    [chatChrome, onSeedPrompt],
  );

  return (
    <div className="space-y-4 px-4 pt-6">
      {isGenerating && (
        <div className="flex items-start gap-3 rounded-xl border border-accent/40 bg-accent/5 px-4 py-3 text-sm">
          <Spinner className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-txt">
              Building your workflow…
            </div>
            <div className="mt-0.5 text-xs text-muted">
              Generations usually take 10–30 seconds. Hooking up connectors,
              picking nodes, and wiring the graph.
            </div>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-txt">
            {getAutomationDisplayTitle(automation)}
          </h2>
          <p className="max-w-2xl text-xs-tight text-muted/80">
            Use the sidebar agent to turn this draft into a task or workflow.
            Say what should start it and what result you want.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-3 text-sm"
            onClick={() => openSidebarDraftChat(DESCRIBE_WORKFLOW_PROMPT)}
          >
            {DESCRIBE_WORKFLOW_PROMPT}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-3 text-sm text-danger hover:bg-danger/10 hover:text-danger"
            onClick={() => void onDeleteDraft(automation)}
          >
            Delete draft
          </Button>
        </div>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {AUTOMATION_DRAFT_EXAMPLES.map((example) => {
          const Icon = example.icon;
          return (
            <button
              key={example.label}
              type="button"
              onClick={() => openSidebarDraftChat(example.prompt)}
              className="group flex items-start gap-2 rounded-[var(--radius-sm)] border border-border/25 bg-bg/30 px-3 py-2 text-left transition-colors hover:border-accent/40 hover:bg-accent/5"
            >
              <Icon
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent/80"
                aria-hidden
              />
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
        The draft updates here as the automation takes shape.
      </p>
    </div>
  );
}

function IconAction({
  icon,
  label,
  onClick,
  tone,
  disabled,
  ariaBusy,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  tone?: "ok" | "warning" | "danger";
  disabled?: boolean;
  ariaBusy?: boolean;
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
      aria-busy={ariaBusy}
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
  status,
  actions,
}: {
  icon: ReactNode;
  title: string;
  description?: string | null;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border/20 pb-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5 text-muted">
          {icon}
          <h2 className="truncate text-base font-semibold text-txt">{title}</h2>
          {status}
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

function DetailStatusIndicator({
  label,
  tone,
  dotOnly = false,
}: {
  label: string;
  tone: "success" | "warning" | "muted" | "danger";
  dotOnly?: boolean;
}) {
  if (dotOnly) {
    return (
      <span className="inline-flex items-center">
        <StatusDot tone={tone} />
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  return <StatusBadge label={label} variant={tone} withDot />;
}

function DetailSection({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-[var(--radius-sm)] border border-border/25 bg-bg/20 ${
        className ?? ""
      }`}
    >
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

function DetailFactList({
  items,
}: {
  items: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="divide-y divide-border/20">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex items-start justify-between gap-3 px-3 py-2 text-xs-tight"
        >
          <dt className="shrink-0 text-muted/70">{item.label}</dt>
          <dd className="min-w-0 text-right text-txt">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function getWorkflowFlowNodes(workflow: WorkflowDefinition | null): Array<{
  id: string;
  label: string;
  type: string;
}> {
  const nodes = workflow?.nodes ?? [];
  return [...nodes]
    .sort((left, right) => {
      const leftX = left.position?.[0] ?? 0;
      const rightX = right.position?.[0] ?? 0;
      if (leftX !== rightX) return leftX - rightX;
      const leftY = left.position?.[1] ?? 0;
      const rightY = right.position?.[1] ?? 0;
      if (leftY !== rightY) return leftY - rightY;
      return left.name.localeCompare(right.name);
    })
    .map((node) => ({
      id: node.id ?? node.name,
      label: node.name,
      type: (node.type ?? "node").split(".").pop() ?? "node",
    }));
}

function WorkflowDataFlowStrip({ workflow }: { workflow: WorkflowDefinition | null }) {
  const flowNodes = getWorkflowFlowNodes(workflow);
  if (flowNodes.length === 0) {
    return (
      <div className="px-4 py-3 text-xs-tight text-muted/70">
        Generate the workflow to see its data path.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-3">
      <span className="rounded-full border border-border/25 bg-bg/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
        Input
      </span>
      {flowNodes.map((node, index) => (
        <div key={node.id} className="flex items-center gap-2">
          <ArrowRight className="h-3 w-3 text-muted/50" aria-hidden />
          <span className="max-w-[12rem] truncate rounded-full border border-border/25 bg-bg/45 px-2.5 py-1 text-xs text-txt">
            {node.label}
          </span>
          <span className="hidden rounded bg-bg/40 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-muted/60 sm:inline">
            {node.type}
          </span>
          {index === flowNodes.length - 1 ? (
            <>
              <ArrowRight className="h-3 w-3 text-muted/50" aria-hidden />
              <span className="rounded-full border border-border/25 bg-bg/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                Output
              </span>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TriggerAutomationDetailPane({
  automation,
  onPromoteToWorkflow,
}: {
  automation: AutomationItem;
  onPromoteToWorkflow: (item: AutomationItem) => Promise<void>;
}) {
  const {
    t,
    uiLanguage,
    openEditTrigger,
    onRunSelectedTrigger,
    onToggleTriggerEnabled,
    onDeleteTrigger,
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
  const nextRunLabel = trigger.nextRunAtMs
    ? trigger.triggerType === "event"
      ? `On ${humanizeEventKind(trigger.eventKind ?? "event")}`
      : formatRelativeFuture(trigger.nextRunAtMs, t)
    : "Event or manual";
  const whatRuns =
    trigger.kind === "workflow"
      ? trigger.workflowName || "Selected workflow"
      : trigger.instructions || "No prompt yet.";

  return (
    <div className="space-y-4">
      <DetailHeader
        icon={<Clock3 className="h-3.5 w-3.5" aria-hidden />}
        title={getAutomationDisplayTitle(automation)}
        description={automation.description}
        status={
          <DetailStatusIndicator
            label={trigger.enabled ? "Active" : "Paused"}
            tone={trigger.enabled ? "success" : "muted"}
            dotOnly={trigger.enabled}
          />
        }
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
              label={t("common.edit")}
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
            <IconAction
              label={t("common.delete")}
              onClick={() =>
                void onDeleteTrigger(trigger.id, trigger.displayName)
              }
              icon={<Trash2 className="h-3.5 w-3.5" />}
              tone="danger"
            />
          </>
        }
      />

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <OverviewMetricCard
          label="Runs"
          value={<span className="tabular-nums">{selectedRuns.length}</span>}
          detail={`${successCount} successful · ${failureCount} failed`}
          tone={
            failureCount > 0 ? "danger" : successCount > 0 ? "ok" : "default"
          }
        />
        <OverviewMetricCard
          label="Starts"
          value={getTriggerStartModeLabel(trigger)}
          detail={scheduleLabel(trigger, t, uiLanguage)}
        />
        <OverviewMetricCard
          label="When it fires"
          value={getTriggerWakeModeLabel(trigger)}
          detail={trigger.enabled ? "Enabled" : "Paused"}
          tone={trigger.enabled ? "ok" : "default"}
        />
        <OverviewMetricCard
          label="Next run"
          value={nextRunLabel}
          detail={
            trigger.triggerType === "event"
              ? "Waiting for event input"
              : formatDateTime(trigger.nextRunAtMs, {
                  fallback: "No time-based run queued",
                  locale: uiLanguage,
                })
          }
          tone={
            trigger.nextRunAtMs || trigger.triggerType === "event"
              ? "ok"
              : "default"
          }
        />
        <OverviewMetricCard
          label="Last run"
          value={formatRelativePast(trigger.lastRunAtIso, t)}
          detail={formatDateTime(trigger.lastRunAtIso, {
            fallback: "Not run yet",
            locale: uiLanguage,
          })}
        />
      </div>

      <DetailSection
        title={trigger.kind === "workflow" ? "Runs this workflow" : "Prompt"}
      >
        <div className="min-h-[8rem] px-4 py-4 text-sm leading-relaxed text-muted/85 whitespace-pre-wrap">
          {whatRuns}
        </div>
      </DetailSection>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.95fr)]">
        <DetailSection
          title="Run history"
          className="h-full"
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
              {t("appsview.Loading")}
            </div>
          ) : selectedRuns.length === 0 ? (
            <div className="px-3 py-3 text-xs-tight text-muted/60">
              No runs yet.
            </div>
          ) : (
            <div className="divide-y divide-border/20">
              {selectedRuns.map((run) => (
                <div
                  key={run.triggerRunId}
                  className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs-tight"
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
                  {run.error ? (
                    <div className="basis-full whitespace-pre-wrap rounded border border-danger/20 bg-danger/10 px-2 py-1 font-mono text-[11px] text-danger/90">
                      {run.error}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </DetailSection>

        <DetailSection title="Schedule & behavior" className="h-full">
          <DetailFactList
            items={[
              {
                label: "Schedule",
                value: scheduleLabel(trigger, t, uiLanguage),
              },
              {
                label: "Trigger type",
                value: getTriggerStartModeLabel(trigger),
              },
              ...(trigger.triggerType === "event"
                ? [
                    {
                      label: "Event",
                      value: trigger.eventKind
                        ? humanizeEventKind(trigger.eventKind)
                        : "Unknown",
                    },
                  ]
                : []),
              {
                label: "Wake mode",
                value: getTriggerWakeModeLabel(trigger),
              },
              {
                label: "Status",
                value: trigger.enabled ? "Enabled" : "Paused",
              },
              {
                label: "Max runs",
                value: trigger.maxRuns ? String(trigger.maxRuns) : "Unlimited",
              },
            ]}
          />
        </DetailSection>
      </div>
    </div>
  );
}

function WorkflowAutomationDetailPane({
  automation,
  workflowStatus,
  workflowFetchError,
  workflowBusyId,
  workflowOpsBusy,
  onDeleteDraft,
  onDeleteWorkflow,
  onDuplicateWorkflow,
  onGenerateWorkflow,
  onRefreshWorkflows,
  onScheduleWorkflow,
  onToggleWorkflowActive,
}: {
  automation: AutomationItem;
  workflowStatus: WorkflowStatusResponse | null;
  workflowFetchError: string | null;
  workflowBusyId: string | null;
  workflowOpsBusy: boolean;
  onDeleteDraft: (item: AutomationItem) => Promise<void>;
  onDeleteWorkflow: (item: AutomationItem) => Promise<void>;
  onDuplicateWorkflow: (item: AutomationItem) => Promise<void>;
  onGenerateWorkflow: (item: AutomationItem, prompt: string) => Promise<void>;
  onRefreshWorkflows: () => Promise<void>;
  onScheduleWorkflow: (item: AutomationItem) => void;
  onToggleWorkflowActive: (item: AutomationItem) => Promise<void>;
}) {
  const { t, uiLanguage } = useApp();
  const chatChrome = useAppWorkspaceChatChrome();
  const [fullWorkflow, setFullWorkflow] = useState<WorkflowDefinition | null>(
    automation.workflow ?? null,
  );
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowPrompt, setWorkflowPrompt] = useState("");
  const [workflowPromptError, setWorkflowPromptError] = useState<string | null>(
    null,
  );
  const [workflowPromptSaving, setWorkflowPromptSaving] = useState(false);
  const workflowGenerating = useWorkflowGenerationState(automation.workflowId);
  const busy =
    workflowOpsBusy ||
    (automation.workflowId != null && workflowBusyId === automation.workflowId);
  const graphWorkflow = fullWorkflow ?? automation.workflow ?? null;
  const nodeCount =
    graphWorkflow?.nodeCount ??
    graphWorkflow?.nodes?.length ??
    getWorkflowNodeCount(automation);
  const workflowIsActive = graphWorkflow?.active ?? automation.enabled;
  const nextWorkflowRun = automation.schedules
    .filter(isTimeBasedTrigger)
    .map((schedule) => schedule.nextRunAtMs ?? 0)
    .filter((value) => value > 0)
    .sort((left, right) => left - right)[0];
  const workflowIdeas = AUTOMATION_DRAFT_EXAMPLES.filter(
    (idea) => idea.kind === "workflow",
  );
  const showWorkflowStarterIdeas = automation.isDraft || nodeCount === 0;
  const showWorkflowPromptBox = automation.isDraft || nodeCount === 0;
  const handleDescribeWorkflow = useCallback(() => {
    chatChrome?.openChat();
    prefillPageChat(DESCRIBE_WORKFLOW_PROMPT, { select: true });
  }, [chatChrome]);
  const handleUseWorkflowIdea = useCallback(
    (idea: AutomationExample) => {
      chatChrome?.openChat();
      prefillPageChat(idea.prompt, { select: true });
    },
    [chatChrome],
  );
  const submitWorkflowPrompt = useCallback(async () => {
    const prompt = workflowPrompt.trim();
    if (!prompt) {
      setWorkflowPromptError("Describe what this workflow should do.");
      return;
    }
    setWorkflowPromptError(null);
    setWorkflowPromptSaving(true);
    try {
      await onGenerateWorkflow(automation, prompt);
      setWorkflowPrompt("");
      chatChrome?.openChat();
      prefillPageChat(prompt, { select: false });
    } catch (error) {
      setWorkflowPromptError(
        error instanceof Error ? error.message : "Failed to generate workflow.",
      );
    } finally {
      setWorkflowPromptSaving(false);
    }
  }, [automation, chatChrome, onGenerateWorkflow, workflowPrompt]);

  useEffect(() => {
    let cancelled = false;
    setFullWorkflow(automation.workflow ?? null);

    if (!automation.workflowId || !automation.hasBackingWorkflow) {
      setWorkflowLoading(false);
      return undefined;
    }

    setWorkflowLoading(true);
    void client
      .getWorkflowDefinition(automation.workflowId)
      .then((workflow) => {
        if (!cancelled) {
          setFullWorkflow(workflow);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFullWorkflow(automation.workflow ?? null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWorkflowLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    automation.hasBackingWorkflow,
    automation.workflow,
    automation.workflowId,
  ]);

  return (
    <div className="space-y-4">
      <WorkflowRuntimeNotice
        status={workflowStatus}
        workflowFetchError={workflowFetchError}
        busy={busy}
        onRefresh={() => void onRefreshWorkflows()}
      />

      <DetailHeader
        icon={<Workflow className="h-3.5 w-3.5" aria-hidden />}
        title={getAutomationDisplayTitle(automation)}
        description={null}
        status={
          <DetailStatusIndicator
            label={
              automation.isDraft
                ? "Draft"
                : automation.enabled
                  ? "Active"
                  : "Paused"
            }
            tone={
              automation.isDraft
                ? "warning"
                : automation.enabled
                  ? "success"
                  : "muted"
            }
            dotOnly={!automation.isDraft && automation.enabled}
          />
        }
        actions={
          automation.isDraft ? (
            <IconAction
              label="Delete draft"
              onClick={() => void onDeleteDraft(automation)}
              icon={<Trash2 className="h-3.5 w-3.5" />}
              tone="danger"
            />
          ) : automation.workflowId ? (
            <>
              <IconAction
                label={
                  busy
                    ? t("common.updating", {
                        defaultValue: "Updating...",
                      })
                    : workflowIsActive
                      ? t("automations.workflow.deactivate", {
                          defaultValue: "Deactivate",
                        })
                      : t("automations.workflow.activate", {
                          defaultValue: "Activate",
                        })
                }
                onClick={() => void onToggleWorkflowActive(automation)}
                disabled={busy}
                ariaBusy={busy}
                icon={
                  workflowIsActive ? (
                    <Pause className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )
                }
                tone={workflowIsActive ? "warning" : "ok"}
              />
              <IconAction
                label="Schedule workflow"
                onClick={() => onScheduleWorkflow(automation)}
                disabled={busy}
                icon={<Clock3 className="h-3.5 w-3.5" />}
              />
              <IconAction
                label="Duplicate workflow"
                onClick={() => void onDuplicateWorkflow(automation)}
                disabled={busy}
                icon={<Copy className="h-3.5 w-3.5" />}
              />
              <IconAction
                label={
                  busy
                    ? t("common.updating", {
                        defaultValue: "Updating...",
                      })
                    : t("automations.workflow.deleteWorkflow", {
                        defaultValue: "Delete workflow",
                      })
                }
                onClick={() => void onDeleteWorkflow(automation)}
                disabled={busy}
                ariaBusy={busy}
                icon={<Trash2 className="h-3.5 w-3.5" />}
                tone="danger"
              />
            </>
          ) : null
        }
      />

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <OverviewMetricCard
          label="Status"
          value={
            automation.isDraft
              ? "Draft"
              : workflowIsActive
                ? "Active"
                : "Paused"
          }
          detail={
            automation.schedules.length > 0
              ? formatScheduleCount(automation.schedules.length)
              : "No schedule attached"
          }
          tone={
            automation.isDraft ? "warning" : workflowIsActive ? "ok" : "default"
          }
        />
        <OverviewMetricCard
          label="Nodes"
          value={<span className="tabular-nums">{nodeCount}</span>}
          detail={nodeCount > 0 ? "Visible in the graph below" : "Still blank"}
        />
        <OverviewMetricCard
          label="Starts"
          value={
            automation.schedules.length > 0
              ? formatScheduleCount(automation.schedules.length)
              : "Event or manual"
          }
          detail={
            automation.schedules.length > 0
              ? scheduleLabel(automation.schedules[0], t, uiLanguage)
              : "No time-based schedule yet"
          }
        />
        <OverviewMetricCard
          label="Next run"
          value={
            nextWorkflowRun
              ? formatRelativeFuture(nextWorkflowRun, t)
              : "Not queued"
          }
          detail={
            nextWorkflowRun
              ? formatDateTime(nextWorkflowRun, {
                  fallback: "—",
                  locale: uiLanguage,
                })
              : "Trigger it from an event or attach a schedule"
          }
          tone={nextWorkflowRun ? "ok" : "default"}
        />
        <OverviewMetricCard
          label="Updated"
          value={formatRelativePast(automation.updatedAt, t)}
          detail={formatDateTime(automation.updatedAt, {
            fallback: "—",
            locale: uiLanguage,
          })}
        />
      </div>

      {showWorkflowPromptBox && (
        <DetailSection title="Create workflow">
          <div className="p-3">
            <div className="flex flex-col gap-2 rounded-full border border-border/30 bg-bg/50 p-1.5 shadow-sm sm:flex-row sm:items-center">
              <Input
                data-workflow-prompt-input="true"
                value={workflowPrompt}
                onChange={(event) => setWorkflowPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submitWorkflowPrompt();
                  }
                }}
                placeholder={WORKFLOW_PROMPT_PLACEHOLDER}
                className="min-h-10 flex-1 border-0 bg-transparent px-4 shadow-none focus-visible:ring-0"
                autoFocus={automation.isDraft}
              />
              <Button
                variant="default"
                size="sm"
                className="h-10 shrink-0 rounded-full px-5"
                disabled={workflowPromptSaving || busy}
                onClick={() => void submitWorkflowPrompt()}
              >
                {workflowPromptSaving ? "Generating..." : "Generate"}
              </Button>
            </div>
            {workflowPromptError && (
              <div className="mt-2 text-xs text-danger">
                {workflowPromptError}
              </div>
            )}
          </div>
        </DetailSection>
      )}

      <DetailSection
        title="Workflow graph"
        action={
          automation.isDraft || nodeCount === 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                const input = document.querySelector<HTMLInputElement>(
                  "[data-workflow-prompt-input='true']",
                );
                input?.focus();
                if (!input) handleDescribeWorkflow();
              }}
            >
              {DESCRIBE_WORKFLOW_PROMPT}
            </Button>
          ) : undefined
        }
      >
        <div className="p-3">
          <WorkflowGraphViewer
            workflow={graphWorkflow}
            loading={workflowLoading}
            isGenerating={workflowGenerating}
            emptyStateActionLabel={DESCRIBE_WORKFLOW_PROMPT}
            emptyStateHelpText="Describe it above to generate the graph."
            onEmptyStateAction={() => {
              const input = document.querySelector<HTMLInputElement>(
                "[data-workflow-prompt-input='true']",
              );
              input?.focus();
              if (!input) handleDescribeWorkflow();
            }}
            status={workflowStatus}
          />
        </div>
      </DetailSection>

      <DetailSection title="Data flow">
        <WorkflowDataFlowStrip workflow={graphWorkflow} />
      </DetailSection>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.95fr)]">
        <DetailSection title="Starts when" className="h-full">
          {automation.schedules.length > 0 ? (
            <div className="divide-y divide-border/20">
              {automation.schedules.map((schedule) => (
                <OverviewListItem
                  key={schedule.id}
                  title={schedule.displayName}
                  meta={scheduleLabel(schedule, t, uiLanguage)}
                  detail={formatDateTime(schedule.nextRunAtMs ?? null, {
                    fallback: "No next run queued",
                    locale: uiLanguage,
                  })}
                  trailing={schedule.enabled ? "Live" : "Paused"}
                  tone={schedule.enabled ? "success" : "muted"}
                />
              ))}
            </div>
          ) : (
            <div className="px-4 py-4 text-xs-tight text-muted/70">
              No schedule yet. Start it from an event or add one in the sidebar.
            </div>
          )}
        </DetailSection>

        {showWorkflowStarterIdeas ? (
          <DetailSection title="Starter ideas" className="h-full">
            <div className="p-2">
              <OverviewIdeaGrid
                ideas={workflowIdeas}
                onSelect={handleUseWorkflowIdea}
              />
            </div>
          </DetailSection>
        ) : (
          <DetailSection title="Details" className="h-full">
            <DetailFactList
              items={[
                {
                  label: "Type",
                  value: automation.isDraft ? "Draft" : "workflow",
                },
                {
                  label: "Nodes",
                  value: String(nodeCount),
                },
                {
                  label: "Schedules",
                  value: String(automation.schedules.length),
                },
                {
                  label: "Updated",
                  value: formatRelativePast(automation.updatedAt, t),
                },
              ]}
            />
          </DetailSection>
        )}
      </div>
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
  let Icon: LucideIcon = Zap;
  let tone: "success" | "warning" | "muted" | "danger" = "muted";
  let titleClass = "text-txt";

  if (item.type === "workflow") {
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
      className={`group flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] py-1 pl-2 pr-1.5 text-left transition-colors ${
        selected ? "bg-accent/15 text-txt" : "text-txt hover:bg-bg-muted/50"
      } ${item.system ? "opacity-60" : ""}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted/70" aria-hidden />
      <span className={`truncate text-xs-tight ${titleClass}`}>
        {getAutomationDisplayTitle(item)}
      </span>
      <StatusDot tone={tone} className="ml-auto h-1.5 w-1.5 shrink-0" />
    </button>
  );
}

function AutomationsSidebarChatGuideActions() {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-8 gap-1.5 px-3 text-sm"
      onClick={() =>
        prefillPageChat(DESCRIBE_WORKFLOW_PROMPT, { select: true })
      }
    >
      {DESCRIBE_WORKFLOW_PROMPT}
    </Button>
  );
}

function AutomationsSidebarChat({
  activeItem,
}: {
  activeItem: AutomationItem | null;
}) {
  const { activeConversationId, conversations, t } = useApp();
  const { refreshAutomations } = useAutomationsViewContext();
  const [overviewVisible, setOverviewVisible] = useState(false);
  const scopedActiveItem = overviewVisible ? null : activeItem;

  useEffect(() => {
    const overviewWindow = window as AutomationsOverviewWindow;
    setOverviewVisible(
      Boolean(overviewWindow.__elizaAutomationsOverviewVisible),
    );

    const handleOverviewVisibility = (event: Event): void => {
      const detail = (event as CustomEvent<AutomationsOverviewVisibilityDetail>)
        .detail;
      setOverviewVisible(Boolean(detail?.visible));
    };

    window.addEventListener(
      AUTOMATIONS_OVERVIEW_VISIBILITY_EVENT,
      handleOverviewVisibility,
    );
    return () =>
      window.removeEventListener(
        AUTOMATIONS_OVERVIEW_VISIBILITY_EVENT,
        handleOverviewVisibility,
      );
  }, []);

  const automationConversationAdapter = useMemo(() => {
    if (!scopedActiveItem) {
      return null;
    }

    const bridgeConversationId = getAutomationBridgeIdForItem(
      scopedActiveItem,
      activeConversationId,
      conversations,
    );

    if (scopedActiveItem.type === "workflow") {
      const metadata = scopedActiveItem.workflowId
        ? buildWorkflowConversationMetadata(
            scopedActiveItem.workflowId,
            scopedActiveItem.title,
            bridgeConversationId,
          )
        : buildWorkflowDraftConversationMetadata(
            scopedActiveItem.draftId ?? scopedActiveItem.id,
            bridgeConversationId,
          );

      return {
        allowClear: false,
        buildRoutingMetadata: () =>
          buildAutomationResponseRoutingMetadata(metadata),
        identityKey: JSON.stringify({
          metadata,
          title: scopedActiveItem.title,
        }),
        onAfterSend: () => void refreshAutomations(),
        resolveConversation: () =>
          resolveAutomationConversation({
            title: scopedActiveItem.title,
            metadata,
          }),
      };
    }

    if (scopedActiveItem.type === "automation_draft") {
      const metadata = buildAutomationDraftConversationMetadata(
        scopedActiveItem.draftId ?? scopedActiveItem.id,
        bridgeConversationId,
      );

      return {
        allowClear: false,
        buildRoutingMetadata: () =>
          buildAutomationResponseRoutingMetadata(metadata),
        identityKey: JSON.stringify({
          metadata,
          title: getAutomationDisplayTitle(scopedActiveItem),
        }),
        onAfterSend: () => void refreshAutomations(),
        resolveConversation: () =>
          resolveAutomationConversation({
            title: getAutomationDisplayTitle(scopedActiveItem),
            metadata,
          }),
      };
    }

    return null;
  }, [
    scopedActiveItem,
    activeConversationId,
    conversations,
    refreshAutomations,
  ]);

  if (scopedActiveItem?.type === "workflow") {
    return (
      <PageScopedChatPane
        scope="page-automations"
        conversationAdapter={automationConversationAdapter ?? undefined}
        introOverride={{
          title: scopedActiveItem.isDraft ? "Workflow draft" : "Workflow",
          body: scopedActiveItem.isDraft
            ? "Describe the trigger and steps. The graph updates here."
            : "Ask to inspect, change, or troubleshoot this workflow.",
          actions: scopedActiveItem.isDraft ? (
            <AutomationsSidebarChatGuideActions />
          ) : undefined,
        }}
        placeholderOverride={
          scopedActiveItem.isDraft
            ? DESCRIBE_WORKFLOW_PROMPT
            : t("automations.chat.placeholder")
        }
        systemAddendumOverride={WORKFLOW_SYSTEM_ADDENDUM}
      />
    );
  }

  if (scopedActiveItem?.type === "automation_draft") {
    return (
      <PageScopedChatPane
        scope="page-automations"
        conversationAdapter={automationConversationAdapter ?? undefined}
        introOverride={{
          title: "Draft",
          body: "Describe the result and what should start it.",
        }}
        placeholderOverride="Describe your automation"
        systemAddendumOverride={AUTOMATION_DRAFT_SYSTEM_ADDENDUM}
      />
    );
  }

  return (
    <PageScopedChatPane
      scope="page-automations"
      placeholderOverride="Describe your workflow, task, or schedule"
      introOverride={{
        title: "Automations",
        body: "Create or inspect a task or workflow.",
        actions: <AutomationsSidebarChatGuideActions />,
      }}
    />
  );
}

function AutomationsLayout() {
  const { activeConversationId, conversations, setTab } = useApp();
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
    setEditorMode,
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
    workflowStatus,
    workflowFetchError,
  } = ctx;
  const [showDashboard, setShowDashboard] = useState(true);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(["agent-owned"]),
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
  const [missingCredentials, setMissingCredentials] = useState<
    WorkflowDefinitionMissingCredential[] | null
  >(null);
  // Active clarification state — populated when /generate or
  // /resolve-clarification returns `needs_clarification`. The draft is the
  // unmodified workflow JSON the route returned; clarifications drive the
  // ChoiceWidget renders below; catalog supplies the picker options;
  // currentIndex chains successive pickers (server-then-channel etc.) by
  // surfacing one clarification at a time.
  const [clarification, setClarification] = useState<{
    response: WorkflowDefinitionNeedsClarificationResponse;
    currentIndex: number;
    busy: boolean;
    error?: string;
  } | null>(null);
  const [workflowBusyId, setWorkflowBusyId] = useState<string | null>(null);
  const [workflowOpsBusy, setWorkflowOpsBusy] = useState(false);
  const [activeWorkflowConversation, setActiveWorkflowConversation] =
    useState<Conversation | null>(null);
  const [createDialogMode, setCreateDialogMode] = useState<"all" | null>(null);
  const [templatesModalOpen, setTemplatesModalOpen] = useState(false);
  const [activeSubpage, setActiveSubpage] = useState<AutomationSubpage>(() =>
    getAutomationSubpageFromPath(getNavigationPathFromWindow()),
  );
  const visibleItems = filteredItems;

  useEffect(() => {
    if (!showDashboard) return;
    setSelectedItemId(null);
    setSelectedItemKind(null);
  }, [setSelectedItemId, setSelectedItemKind, showDashboard]);

  useEffect(() => {
    (window as AutomationsOverviewWindow).__elizaAutomationsOverviewVisible =
      showDashboard;
    window.dispatchEvent(
      new CustomEvent<AutomationsOverviewVisibilityDetail>(
        AUTOMATIONS_OVERVIEW_VISIBILITY_EVENT,
        {
          detail: { visible: showDashboard },
        },
      ),
    );
  }, [showDashboard]);

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
      ? "Nodes"
      : showDashboard
        ? "Overview"
        : editorOpen || editingId || editingTaskId
          ? modalTitle
          : resolvedSelectedItem
            ? getAutomationDisplayTitle(resolvedSelectedItem)
            : "Automations";

  const selectItem = useCallback(
    (item: AutomationItem) => {
      showAutomationsList();
      setShowDashboard(false);
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

  const showOverview = useCallback(() => {
    showAutomationsList();
    setShowDashboard(true);
    setSelectedItemId(null);
    setSelectedItemKind(null);
    setEditorOpen(false);
    setEditingId(null);
    ctx.setEditingTaskId(null);
  }, [
    ctx,
    setEditingId,
    setEditorOpen,
    setSelectedItemId,
    setSelectedItemKind,
    showAutomationsList,
  ]);

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
              item.type === "workflow" &&
              item.workflowId != null &&
              !item.isDraft,
          )
          .map((item) => item.workflowId as string),
      );
      const previousTriggerIds = new Set(
        ctx.allItems
          .filter((item) => item.trigger?.id)
          .map((item) => item.trigger?.id),
      );
      const previousTaskIds = new Set(
        ctx.allItems
          .filter((item) => item.task?.id)
          .map((item) => item.task?.id),
      );

      const data = await ctx.refreshAutomations();
      const draftScope = draftConversation?.metadata?.scope;
      if (!draftConversation || !draftScope) {
        return data;
      }

      const bridgeConversationId =
        draftConversation.metadata?.terminalBridgeConversationId;

      // Workflow-draft scope: rebind on new workflow (existing path).
      if (
        draftScope === "automation-workflow-draft" &&
        draftConversation.metadata?.automationType === "workflow"
      ) {
        const createdWorkflows =
          data?.automations.filter(
            (item) =>
              item.type === "workflow" &&
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
              item.type === "workflow" &&
              item.workflowId != null &&
              !item.isDraft &&
              !previousWorkflowIds.has(item.workflowId),
          ) ?? [];

        const createdCount =
          createdTriggers.length +
          createdTasks.length +
          createdWorkflows.length;
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
          const trigger = created.trigger;
          if (!trigger) return await ctx.refreshAutomations();
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
          const task = created.task;
          if (!task) return await ctx.refreshAutomations();
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

  const bindConversationToWorkflow = useCallback(
    async (
      conversation: Conversation,
      workflow: WorkflowDefinition,
      bridgeConversationId?: string | null,
    ): Promise<Conversation> => {
      const reboundMetadata = buildWorkflowConversationMetadata(
        workflow.id,
        workflow.name,
        bridgeConversationId ?? undefined,
      );
      const { conversation: reboundConversation } =
        await client.updateConversation(conversation.id, {
          title: workflow.name,
          metadata: reboundMetadata,
        });
      setActiveWorkflowConversation(reboundConversation);
      return reboundConversation;
    },
    [],
  );

  const selectWorkflowById = useCallback(
    (workflowId: string) => {
      setShowDashboard(false);
      setSelectedItemId(`workflow:${workflowId}`);
      setSelectedItemKind("workflow");
      setEditorOpen(false);
      setEditingId(null);
      ctx.setEditingTaskId(null);
    },
    [ctx, setEditingId, setEditorOpen, setSelectedItemId, setSelectedItemKind],
  );

  const generateWorkflowFromPrompt = useCallback(
    async ({
      prompt,
      title,
      conversation,
      bridgeConversationId,
      workflowId,
    }: {
      prompt: string;
      title?: string;
      conversation?: Conversation | null;
      bridgeConversationId?: string | null;
      workflowId?: string | null;
    }): Promise<WorkflowDefinition | null> => {
      setWorkflowOpsBusy(true);
      setPageNotice(null);
      setMissingCredentials(null);
      setClarification(null);
      try {
        const result = await client.generateWorkflowDefinition({
          prompt,
          ...(title?.trim() ? { name: title.trim() } : {}),
          ...(workflowId ? { workflowId } : {}),
          ...(bridgeConversationId ? { bridgeConversationId } : {}),
        });
        if (isMissingCredentialsResponse(result)) {
          setMissingCredentials(result.missingCredentials);
          return null;
        }
        if (isNeedsClarificationResponse(result)) {
          setClarification({
            response: result,
            currentIndex: 0,
            busy: false,
          });
          return null;
        }
        if (conversation) {
          await bindConversationToWorkflow(
            conversation,
            result,
            bridgeConversationId,
          );
        }
        await ctx.refreshAutomations();
        selectWorkflowById(result.id);
        return result;
      } finally {
        setWorkflowOpsBusy(false);
      }
    },
    [bindConversationToWorkflow, ctx, selectWorkflowById],
  );

  // Resolve one clarification by posting the picked value to
  // /resolve-clarification. The route either returns the next pending
  // clarification (chained pickers) or a fully-deployed workflow.
  const resolveClarificationChoice = useCallback(
    async (paramPath: string, value: string): Promise<void> => {
      setClarification((prev) =>
        prev ? { ...prev, busy: true, error: undefined } : prev,
      );
      try {
        const draftRecord = clarification?.response.draft as
          | (Record<string, unknown> & { id?: string; name?: string })
          | undefined;
        if (!draftRecord) {
          setClarification((prev) => (prev ? { ...prev, busy: false } : prev));
          return;
        }
        const result = await client.resolveWorkflowClarification({
          draft: draftRecord,
          resolutions: [{ paramPath, value }],
        });
        if (isMissingCredentialsResponse(result)) {
          setClarification(null);
          setMissingCredentials(result.missingCredentials);
          return;
        }
        if (isNeedsClarificationResponse(result)) {
          setClarification({
            response: result,
            currentIndex: 0,
            busy: false,
          });
          return;
        }
        // Successful deploy — refresh, select, and clear the panel. Wrap
        // the post-deploy refresh in its own try so that a refresh failure
        // surfaces via pageNotice instead of being swallowed by the outer
        // catch (which would no-op once clarification is null).
        setClarification(null);
        try {
          await ctx.refreshAutomations();
          selectWorkflowById(result.id);
        } catch (refreshErr) {
          const message =
            refreshErr instanceof Error
              ? refreshErr.message
              : String(refreshErr);
          setPageNotice(
            `Workflow deployed but the automations list could not refresh: ${message}`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setClarification((prev) =>
          prev ? { ...prev, busy: false, error: message } : prev,
        );
      }
    },
    [clarification, ctx, selectWorkflowById],
  );

  const dismissClarification = useCallback(() => {
    setClarification(null);
  }, []);

  const createWorkflowDraft = useCallback(
    async (options?: { initialPrompt?: string; title?: string }) => {
      setPageNotice(null);
      showAutomationsList();
      const draftId = createWorkflowDraftId();
      setShowDashboard(false);
      setFilter("all");
      setSelectedItemId(`workflow-draft:${draftId}`);
      setSelectedItemKind("workflow");
      setEditorOpen(false);
      setEditingId(null);
      ctx.setEditingTaskId(null);
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
          await generateWorkflowFromPrompt({
            prompt: options.initialPrompt.trim(),
            title: options.title?.trim() || undefined,
            conversation,
            bridgeConversationId,
          });
          return;
        }

        const data = await ctx.refreshAutomations();
        const resolvedItem = findAutomationForConversation(
          data,
          conversation.id,
        );

        setSelectedItemId(resolvedItem?.id ?? `workflow-draft:${draftId}`);
        setSelectedItemKind("workflow");
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
      generateWorkflowFromPrompt,
      resolvedSelectedItem,
      setFilter,
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
    openCreateTrigger();
  }, [openCreateTrigger, showAutomationsList]);

  const handleZeroStateNewTask = useCallback(() => {
    showAutomationsList();
    openCreateTask();
  }, [openCreateTask, showAutomationsList]);

  // biome-ignore lint/correctness/noUnusedVariables: reserved for seeded task creation
  const openSeededTask = useCallback(
    (idea: AutomationExample) => {
      showAutomationsList();
      openCreateTrigger();
      setForm({
        ...emptyForm,
        displayName: idea.label,
        instructions: idea.prompt,
      });
    },
    [openCreateTrigger, setForm, showAutomationsList],
  );

  const handleDescribeAutomation = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;

      if (inferAutomationPromptKind(trimmed) === "workflow") {
        await createWorkflowDraft({
          title: titleFromAutomationPrompt(trimmed),
          initialPrompt: trimmed,
        });
        return;
      }

      showAutomationsList();
      openCreateTrigger();
      setForm({
        ...emptyForm,
        displayName: titleFromAutomationPrompt(trimmed),
        instructions: trimmed,
      });
    },
    [createWorkflowDraft, openCreateTrigger, setForm, showAutomationsList],
  );

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

  const handleToggleWorkflowActive = useCallback(
    async (item: AutomationItem) => {
      if (!item.workflowId) {
        return;
      }
      setWorkflowBusyId(item.workflowId);
      setPageNotice(null);
      try {
        if (item.enabled) {
          await client.deactivateWorkflowDefinition(item.workflowId);
        } else {
          await client.activateWorkflowDefinition(item.workflowId);
        }
        await ctx.refreshAutomations();
      } catch (error) {
        setPageNotice(
          error instanceof Error
            ? error.message
            : t("automations.workflow.updateStateFailed", {
                defaultValue: "Failed to update workflow state.",
              }),
        );
      } finally {
        setWorkflowBusyId(null);
      }
    },
    [ctx, t],
  );

  const handleGenerateWorkflow = useCallback(
    async (item: AutomationItem, prompt: string) => {
      const conversationId = item.room?.conversationId;
      const conversation = conversationId
        ? (conversations.find((candidate) => candidate.id === conversationId) ??
          null)
        : null;
      const title =
        item.title.trim() && item.title !== WORKFLOW_DRAFT_TITLE
          ? item.title
          : undefined;

      await generateWorkflowFromPrompt({
        prompt,
        title,
        conversation,
        bridgeConversationId: item.room?.terminalBridgeConversationId,
        workflowId: item.hasBackingWorkflow ? item.workflowId : null,
      });
    },
    [conversations, generateWorkflowFromPrompt],
  );

  const handleScheduleWorkflow = useCallback(
    (item: AutomationItem) => {
      if (!item.workflowId) {
        setPageNotice("Generate the workflow before scheduling it.");
        return;
      }

      setForm({
        ...emptyForm,
        displayName: `Run ${item.title}`,
        kind: "workflow",
        workflowId: item.workflowId,
        workflowName: item.title,
      });
      setEditorMode("trigger");
      setEditingId(null);
      ctx.setEditingTaskId(null);
      setSelectedItemId(null);
      setSelectedItemKind(null);
      setEditorOpen(true);
      setShowDashboard(false);
    },
    [
      ctx,
      setEditingId,
      setEditorMode,
      setEditorOpen,
      setForm,
      setSelectedItemId,
      setSelectedItemKind,
    ],
  );

  const handleDeleteWorkflow = useCallback(
    async (item: AutomationItem) => {
      if (!item.workflowId) {
        return;
      }
      const confirmed = await confirmDesktopAction({
        title: t("automations.workflow.deleteWorkflow", {
          defaultValue: "Delete workflow",
        }),
        message:
          item.schedules.length > 0
            ? `Delete "${item.title}" and ${item.schedules.length} attached schedule${item.schedules.length === 1 ? "" : "s"}? This cannot be undone.`
            : t("automations.workflow.deleteConfirmWorkflow", {
                defaultValue: 'Delete "{{name}}"? This cannot be undone.',
                name: item.title,
              }),
        confirmLabel: t("automations.workflow.deleteWorkflow", {
          defaultValue: "Delete workflow",
        }),
        cancelLabel: t("common.cancel"),
        type: "warning",
      });
      if (!confirmed) return;

      setWorkflowBusyId(item.workflowId);
      setPageNotice(null);
      try {
        await client.deleteWorkflowDefinition(item.workflowId);
        await Promise.all(
          item.schedules.map((schedule) => client.deleteTrigger(schedule.id)),
        );
        // Also delete the chat conversation/room that backed this workflow.
        // Without this, the `/api/automations` aggregator keeps surfacing the
        // workflow row as a ghost entry because rooms with workflowId
        // metadata are listed even when the underlying workflow is gone.
        const conversationId = item.room?.conversationId;
        if (conversationId) {
          try {
            await client.deleteConversation(conversationId);
          } catch (roomErr) {
            // Non-fatal: the workflow itself is deleted; surface the room
            // failure to the user but don't roll back.
            setPageNotice(
              `Workflow deleted, but its chat room could not be removed: ${
                roomErr instanceof Error ? roomErr.message : String(roomErr)
              }`,
            );
          }
        }
        if (selectedItemId === item.id) {
          setSelectedItemId(null);
          setSelectedItemKind(null);
        }
        // Mirror handleDeleteDraft: also clear the active workflow
        // conversation if it's the one tied to the deleted workflow.
        // Without this, refreshAutomationsWithDraftBinding keeps receiving
        // a stale conversation reference on subsequent refreshes.
        if (
          conversationId &&
          activeWorkflowConversation?.id === conversationId
        ) {
          setActiveWorkflowConversation(null);
        }
        await ctx.refreshAutomations();
      } catch (error) {
        setPageNotice(
          error instanceof Error
            ? error.message
            : t("automations.workflow.deleteFailed", {
                defaultValue: "Failed to delete workflow.",
              }),
        );
      } finally {
        setWorkflowBusyId(null);
      }
    },
    [
      activeWorkflowConversation?.id,
      ctx,
      selectedItemId,
      setSelectedItemId,
      setSelectedItemKind,
      t,
    ],
  );

  const handleDuplicateWorkflow = useCallback(
    async (item: AutomationItem) => {
      if (!item.workflowId) {
        return;
      }

      setPageNotice(null);
      try {
        const workflow = await client.getWorkflowDefinition(item.workflowId);
        const copy = await client.createWorkflowDefinition(
          buildWorkflowCopyRequest(workflow, `${item.title} Copy`),
        );
        await ctx.refreshAutomations();
        selectWorkflowById(copy.id);
      } catch (error) {
        setPageNotice(
          error instanceof Error
            ? error.message
            : "Failed to duplicate workflow.",
        );
      }
    },
    [ctx, selectWorkflowById],
  );

  const handleDeleteDraft = useCallback(
    async (item: AutomationItem) => {
      // Synthesized in-flight drafts (workflow-draft:* ids surfaced
      // before refreshAutomations completes) have no `room` because the
      // controller's resolvedSelectedItem useMemo can't reach
      // activeWorkflowConversation from its scope. Fall back to the
      // live activeWorkflowConversation when item.room is missing —
      // that's the same conversation the synthesized item represents.
      const conversationId =
        item.room?.conversationId ?? activeWorkflowConversation?.id ?? null;
      if (!conversationId) {
        setPageNotice("This draft is missing its automation room.");
        return;
      }

      const confirmed = await confirmDesktopAction({
        title: "Delete draft",
        message: `Delete "${getAutomationDisplayTitle(item)}"? This removes the draft room and its conversation.`,
        confirmLabel: "Delete draft",
        cancelLabel: t("common.cancel"),
        type: "warning",
      });
      if (!confirmed) return;

      setPageNotice(null);
      try {
        await client.deleteConversation(conversationId);
        if (selectedItemId === item.id) {
          setSelectedItemId(null);
          setSelectedItemKind(null);
        }
        if (activeWorkflowConversation?.id === conversationId) {
          setActiveWorkflowConversation(null);
        }
        await ctx.refreshAutomations();
        setShowDashboard(true);
      } catch (error) {
        setPageNotice(
          error instanceof Error ? error.message : "Failed to delete draft.",
        );
      }
    },
    [
      activeWorkflowConversation?.id,
      ctx,
      selectedItemId,
      setSelectedItemId,
      setSelectedItemKind,
      t,
    ],
  );

  const workflowItems = useMemo(
    () => visibleItems.filter((item) => item.type === "workflow"),
    [visibleItems],
  );
  const taskItems = useMemo(
    () =>
      visibleItems.filter(
        (item) => item.type === "automation_draft" || item.trigger != null,
      ),
    [visibleItems],
  );
  const agentOwnedItems = useMemo(
    () => visibleItems.filter((item) => item.task != null && item.system),
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

  const nodeCatalogActive = activeSubpage === "node-catalog";
  const nodeCatalogLabel = t("automations.nodeCatalog", {
    defaultValue: "Nodes",
  });

  const automationsSidebar = (
    <AppPageSidebar
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
      bottomAction={
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
      collapsedRailAction={
        <SidebarCollapsedActionButton
          aria-label="Create task or workflow"
          onClick={() => setCreateDialogMode("all")}
        >
          <Plus className="h-4 w-4" />
        </SidebarCollapsedActionButton>
      }
      collapsedRailItems={visibleItems.map((item) => (
        <SidebarContent.RailItem
          key={item.id}
          aria-label={getAutomationDisplayTitle(item)}
          title={getAutomationDisplayTitle(item)}
          active={item.id === selectedItemId}
          indicatorTone={getAutomationIndicatorTone(item)}
          onClick={() => selectItem(item)}
        >
          {railMonogram(getAutomationDisplayTitle(item))}
        </SidebarContent.RailItem>
      ))}
    >
      <SidebarScrollRegion
        className="!px-0 !pb-2 !pt-0 [scrollbar-gutter:auto]"
        style={{ scrollbarGutter: "auto" }}
      >
        <SidebarPanel className="bg-transparent gap-0 p-0 shadow-none">
          {isLoading && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-2xs text-muted">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted/30 border-t-muted/80" />
              {t("common.loading")}
            </div>
          )}

          <button
            type="button"
            onClick={showOverview}
            aria-current={showDashboard ? "page" : undefined}
            className={`mt-0 flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left text-xs-tight transition-colors ${
              showDashboard
                ? "bg-accent/15 text-txt"
                : "text-txt hover:bg-bg-muted/50"
            }`}
          >
            <LayoutDashboard
              className="h-3.5 w-3.5 shrink-0 text-muted/70"
              aria-hidden
            />
            <span className="truncate">Overview</span>
          </button>

          <div className="mt-0.5 space-y-1">
            <AutomationCollapsibleSection
              sectionKey="tasks"
              label="Tasks"
              icon={<FileText className="h-3.5 w-3.5" aria-hidden />}
              count={taskItems.length}
              collapsed={collapsedSections.has("tasks")}
              onToggleCollapsed={toggleSectionCollapsed}
              onAdd={handleZeroStateNewTask}
              addLabel="Create task"
              emptyLabel="No tasks"
            >
              {taskItems.map(renderItem)}
            </AutomationCollapsibleSection>

            <AutomationCollapsibleSection
              sectionKey="workflows"
              label="Workflows"
              icon={<Workflow className="h-3.5 w-3.5" aria-hidden />}
              count={workflowItems.length}
              collapsed={collapsedSections.has("workflows")}
              onToggleCollapsed={toggleSectionCollapsed}
              onAdd={() => void createWorkflowDraft()}
              addLabel="Create workflow"
              emptyLabel="No workflows"
            >
              {workflowItems.map(renderItem)}
            </AutomationCollapsibleSection>

            <AutomationCollapsibleSection
              sectionKey="agent-owned"
              label="Internal"
              icon={<SquareTerminal className="h-3.5 w-3.5" aria-hidden />}
              count={agentOwnedItems.length}
              collapsed={collapsedSections.has("agent-owned")}
              onToggleCollapsed={toggleSectionCollapsed}
              emptyLabel="No internal automations"
            >
              {agentOwnedItems.map(renderItem)}
            </AutomationCollapsibleSection>
          </div>
        </SidebarPanel>
      </SidebarScrollRegion>
    </AppPageSidebar>
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
        {activeSubpage === "node-catalog" ||
        (!showDashboard && showDetailPane) ? (
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

        {missingCredentials && missingCredentials.length > 0 && (
          <PagePanel
            variant="padded"
            className="mb-4 border border-warn/40 bg-warn-subtle"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-warn">
                  Workflow needs {missingCredentials.length} credential
                  {missingCredentials.length === 1 ? "" : "s"}
                </p>
                <p className="text-xs text-muted">
                  Connect{" "}
                  {missingCredentials
                    .map((cred) => prettyCredName(cred.credType))
                    .join(", ")}{" "}
                  to activate this workflow.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {missingCredentials.map((cred) => (
                    <Button
                      key={cred.credType}
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setTab("connectors");
                        dispatchFocusConnector(
                          providerFromCredType(cred.credType),
                        );
                        setMissingCredentials(null);
                      }}
                    >
                      Connect {prettyCredName(cred.credType)} →
                    </Button>
                  ))}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted hover:text-txt"
                onClick={() => setMissingCredentials(null)}
              >
                Dismiss
              </Button>
            </div>
          </PagePanel>
        )}

        {clarification ? (
          <ClarificationPanel
            state={clarification}
            onChoose={resolveClarificationChoice}
            onDismiss={dismissClarification}
          />
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
              kickerLabelCreate={
                form.kind === "workflow" ? "New schedule" : "New task"
              }
              kickerLabelEdit={
                form.kind === "workflow" ? "Edit schedule" : "Edit task"
              }
              submitLabelCreate={
                form.kind === "workflow" ? "Create schedule" : "Create task"
              }
              submitLabelEdit={
                form.kind === "workflow" ? "Save schedule" : "Save task"
              }
            />
          )
        ) : activeSubpage === "node-catalog" ? (
          <AutomationNodeCatalogPane nodes={automationNodes} />
        ) : showDashboard ? (
          <HeroEmptyState
            ideas={AUTOMATION_DRAFT_EXAMPLES}
            onSubmit={(text) =>
              void createWorkflowDraft({ initialPrompt: text })
            }
            drafts={ctx.allItems.filter((item) => item.isDraft).slice(0, 4)}
            onSelectDraft={selectItem}
            onDeleteDraft={handleDeleteDraft}
            t={t}
          />
        ) : resolvedSelectedItem?.type === "automation_draft" ? (
          <AutomationDraftPane
            automation={resolvedSelectedItem}
            onSeedPrompt={(prompt) => prefillPageChat(prompt, { select: true })}
            onDeleteDraft={handleDeleteDraft}
            isGenerating={workflowOpsBusy}
          />
        ) : resolvedSelectedItem?.type === "workflow" ? (
          <WorkflowAutomationDetailPane
            automation={resolvedSelectedItem}
            workflowStatus={workflowStatus}
            workflowFetchError={workflowFetchError}
            workflowBusyId={workflowBusyId}
            workflowOpsBusy={workflowOpsBusy}
            onDeleteDraft={handleDeleteDraft}
            onDeleteWorkflow={handleDeleteWorkflow}
            onDuplicateWorkflow={handleDuplicateWorkflow}
            onGenerateWorkflow={handleGenerateWorkflow}
            onRefreshWorkflows={handleRefreshWorkflows}
            onScheduleWorkflow={handleScheduleWorkflow}
            onToggleWorkflowActive={handleToggleWorkflowActive}
          />
        ) : resolvedSelectedItem?.trigger ? (
          <TriggerAutomationDetailPane
            automation={resolvedSelectedItem}
            onPromoteToWorkflow={promoteAutomationToWorkflow}
          />
        ) : resolvedSelectedItem?.task ? (
          <TaskAutomationDetailPane
            automation={resolvedSelectedItem}
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
                Select a task or workflow
              </h3>
            </div>
          </div>
        )}
      </div>

      <CreateAutomationDialog
        open={createDialogMode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateDialogMode(null);
          }
        }}
        onCreateTask={() => {
          setCreateDialogMode(null);
          handleZeroStateNewTask();
        }}
        onCreateWorkflow={() => {
          setCreateDialogMode(null);
          void createWorkflowDraft();
        }}
        onDescribeAutomation={handleDescribeAutomation}
      />
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
  const controller = useAutomationsViewController();
  // Collapse the right-rail chat dock when no workflow / draft is
  // selected. The Automations Overview page already has a centered hero
  // compose ("Describe a task or workflow…") that's the canonical create
  // surface; the bottom-right dock + hero showed two inputs at once and
  // confused users. When a workflow or draft IS selected, the rail (and
  // its PageScopedChatPane) opens so the user can edit/refine.
  //
  // Stay in CONTROLLED mode at all times. An earlier revision flipped
  // between controlled (when nothing selected) and uncontrolled (when
  // something selected); that left AppWorkspaceChrome's internal
  // `internalCollapsed` stuck at `true` after the controlled phase, so
  // the rail never opened on the first selection. Always-controlled
  // avoids that transition entirely.
  const hasScopedItem = controller.resolvedSelectedItem != null;
  const [userCollapsedWhenSelected, setUserCollapsedWhenSelected] =
    useState(false);
  // When the user clears the selection, also reset the toggle so the next
  // selection starts with the rail open by default.
  useEffect(() => {
    if (!hasScopedItem) setUserCollapsedWhenSelected(false);
  }, [hasScopedItem]);
  const chatCollapsed = hasScopedItem ? userCollapsedWhenSelected : true;
  const handleToggleChat = useCallback(
    (next: boolean) => {
      // No-op when nothing is selected — the rail is force-closed in that
      // state and the toggle button is hidden, so this should never fire.
      if (hasScopedItem) setUserCollapsedWhenSelected(next);
    },
    [hasScopedItem],
  );
  return (
    <AutomationsViewContext.Provider value={controller}>
      <AppWorkspaceChrome
        testId="automations-workspace"
        chat={
          <AutomationsSidebarChat
            activeItem={controller.resolvedSelectedItem}
          />
        }
        chatCollapsed={chatCollapsed}
        onToggleChat={handleToggleChat}
        hideCollapseButton={!hasScopedItem}
        main={
          <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
            <AutomationsLayout />
          </div>
        }
      />
    </AutomationsViewContext.Provider>
  );
}
