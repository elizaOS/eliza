/** Status of an individual task within a plan */
export enum TaskStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  CANCELLED = "cancelled",
}

/** Status of an overall plan */
export enum PlanStatus {
  DRAFT = "draft",
  ACTIVE = "active",
  COMPLETED = "completed",
  ARCHIVED = "archived",
}

/** A single task within a plan */
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  order: number;
  dependencies: string[];
  assignee: string | null;
  createdAt: number;
  completedAt: number | null;
}

/** Metadata values for plans */
export type PlanMetadataValue = string | number | boolean;

/** Metadata record for plans */
export type PlanMetadata = Record<string, PlanMetadataValue>;

/** A complete plan with tasks */
export interface Plan {
  id: string;
  title: string;
  description: string;
  status: PlanStatus;
  tasks: Task[];
  createdAt: number;
  updatedAt: number;
  metadata: PlanMetadata;
}

/** Parameters for CREATE_PLAN action */
export interface CreatePlanParameters {
  title?: string;
  description?: string;
  tasks?: Array<{ title: string; description?: string; dependencies?: string[] }>;
}

/** Parameters for UPDATE_PLAN action */
export interface UpdatePlanParameters {
  planId?: string;
  title?: string;
  description?: string;
  status?: PlanStatus;
}

/** Parameters for COMPLETE_TASK action */
export interface CompleteTaskParameters {
  planId?: string;
  taskId?: string;
  taskTitle?: string;
}

/** Parameters for GET_PLAN action */
export interface GetPlanParameters {
  planId?: string;
  title?: string;
}

/** Source identifier for plans created by this plugin */
export const PLAN_SOURCE = "plugin-planning";

/** Table name for plans in the runtime database */
export const PLUGIN_PLANS_TABLE = "plans";

/** Task status display labels */
export const TASK_STATUS_LABELS: Record<string, string> = {
  [TaskStatus.PENDING]: "Pending",
  [TaskStatus.IN_PROGRESS]: "In Progress",
  [TaskStatus.COMPLETED]: "Completed",
  [TaskStatus.CANCELLED]: "Cancelled",
};

/** Plan status display labels */
export const PLAN_STATUS_LABELS: Record<string, string> = {
  [PlanStatus.DRAFT]: "Draft",
  [PlanStatus.ACTIVE]: "Active",
  [PlanStatus.COMPLETED]: "Completed",
  [PlanStatus.ARCHIVED]: "Archived",
};

/** Generate a short unique ID for tasks */
export function generateTaskId(index: number): string {
  return `task-${index + 1}`;
}

/** Generate a unique plan ID */
export function generatePlanId(): string {
  return `plan-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/** Serialize a plan to a storable string */
export function encodePlan(plan: Plan): string {
  return JSON.stringify(plan);
}

/** Deserialize a plan from storage */
export function decodePlan(text: string): Plan | null {
  try {
    const parsed = JSON.parse(text) as Plan;
    if (parsed.id && parsed.title && Array.isArray(parsed.tasks)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Calculate plan completion percentage */
export function getPlanProgress(plan: Plan): number {
  if (plan.tasks.length === 0) return 0;
  const completed = plan.tasks.filter((t) => t.status === TaskStatus.COMPLETED).length;
  return Math.round((completed / plan.tasks.length) * 100);
}

/** Format a plan as a readable string */
export function formatPlan(plan: Plan): string {
  const progress = getPlanProgress(plan);
  const statusLabel = PLAN_STATUS_LABELS[plan.status] ?? plan.status;

  const header = `Plan: ${plan.title}\nStatus: ${statusLabel} | Progress: ${progress}%\n${plan.description}`;

  const taskLines = plan.tasks
    .sort((a, b) => a.order - b.order)
    .map((t) => {
      const statusIcon =
        t.status === TaskStatus.COMPLETED
          ? "[x]"
          : t.status === TaskStatus.IN_PROGRESS
            ? "[~]"
            : t.status === TaskStatus.CANCELLED
              ? "[-]"
              : "[ ]";
      const assigneeStr = t.assignee ? ` (@${t.assignee})` : "";
      return `  ${statusIcon} ${t.title}${assigneeStr}`;
    });

  return `${header}\n\nTasks:\n${taskLines.join("\n")}`;
}
