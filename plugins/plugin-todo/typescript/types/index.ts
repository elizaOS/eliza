import type { UUID } from "@elizaos/core";

export type TaskType = "daily" | "one-off" | "aspirational";

export type Priority = 1 | 2 | 3 | 4;

export type RecurringPattern = "daily" | "weekly" | "monthly";

export interface Todo {
  id: UUID;
  agentId: UUID;
  worldId: UUID;
  roomId: UUID;
  entityId: UUID;
  name: string;
  description?: string | null;
  type: TaskType;
  priority?: Priority | null;
  isUrgent: boolean;
  isCompleted: boolean;
  dueDate?: Date | null;
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: TodoMetadata;
  tags?: string[];
}

export interface TodoMetadata {
  createdAt?: string;
  description?: string;
  dueDate?: string;
  completedAt?: string;
  completedToday?: boolean;
  lastCompletedDate?: string;
  streak?: number;
  recurring?: RecurringPattern;
  pointsAwarded?: number;
  [key: string]: string | number | boolean | undefined;
}

export interface CreateTodoParams {
  agentId: UUID;
  worldId: UUID;
  roomId: UUID;
  entityId: UUID;
  name: string;
  description?: string;
  type: TaskType;
  priority?: Priority;
  isUrgent?: boolean;
  dueDate?: Date;
  metadata?: TodoMetadata;
  tags?: string[];
}

export interface UpdateTodoParams {
  name?: string;
  description?: string;
  priority?: Priority;
  isUrgent?: boolean;
  isCompleted?: boolean;
  dueDate?: Date | null;
  completedAt?: Date | null;
  metadata?: TodoMetadata;
}

/**
 * Filter parameters for querying todos
 */
export interface TodoFilters {
  agentId?: UUID;
  worldId?: UUID;
  roomId?: UUID;
  entityId?: UUID;
  type?: TaskType;
  isCompleted?: boolean;
  tags?: string[];
  limit?: number;
}

export interface ReminderMessage {
  entityId: UUID;
  message: string;
  priority: "low" | "medium" | "high";
  platforms?: string[];
  metadata?: {
    todoId: UUID;
    todoName: string;
    reminderType: string;
    dueDate?: Date;
  };
}

export type NotificationType = "overdue" | "upcoming" | "daily" | "system";

export interface TodoPluginConfig {
  enableReminders?: boolean;
  reminderInterval?: number;
  enableIntegrations?: boolean;
}

export interface TodoTaskInput {
  name: string;
  description?: string;
  taskType: TaskType;
  priority?: Priority;
  urgent?: boolean;
  dueDate?: string;
  recurring?: RecurringPattern;
}

export interface TaskSelection {
  taskId: string;
  taskName: string;
  isFound: boolean;
}

export interface TaskUpdate {
  name?: string;
  description?: string;
  priority?: Priority;
  urgent?: boolean;
  dueDate?: string | null;
  recurring?: RecurringPattern;
}

export interface ConfirmationResponse {
  isConfirmation: boolean;
  shouldProceed: boolean;
  modifications?: string;
}

export interface StructuredTodoResponse {
  worldId: UUID;
  worldName: string;
  rooms: Array<{
    roomId: UUID;
    roomName: string;
    tasks: Todo[];
  }>;
}
