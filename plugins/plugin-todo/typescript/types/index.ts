/**
 * Type definitions for the Todo Plugin
 */

import type { UUID } from "@elizaos/core";

/**
 * Task types supported by the plugin
 */
export type TaskType = "daily" | "one-off" | "aspirational";

/**
 * Priority levels (1 = highest, 4 = lowest)
 */
export type Priority = 1 | 2 | 3 | 4;

/**
 * Recurring patterns for daily tasks
 */
export type RecurringPattern = "daily" | "weekly" | "monthly";

/**
 * Core todo item structure
 */
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

/**
 * Metadata stored with todos
 */
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

/**
 * Parameters for creating a new todo
 */
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

/**
 * Parameters for updating a todo
 */
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

/**
 * Reminder message structure
 */
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

/**
 * Notification types
 */
export type NotificationType = "overdue" | "upcoming" | "daily" | "system";

/**
 * Plugin configuration
 */
export interface TodoPluginConfig {
  /**
   * Enable reminder notifications
   */
  enableReminders?: boolean;

  /**
   * Reminder check interval in milliseconds
   */
  reminderInterval?: number;

  /**
   * Enable integration with external plugins
   */
  enableIntegrations?: boolean;
}

/**
 * Task input parsed from user messages
 */
export interface TodoTaskInput {
  name: string;
  description?: string;
  taskType: TaskType;
  priority?: Priority;
  urgent?: boolean;
  dueDate?: string;
  recurring?: RecurringPattern;
}

/**
 * Task selection from extraction
 */
export interface TaskSelection {
  taskId: string;
  taskName: string;
  isFound: boolean;
}

/**
 * Task update properties
 */
export interface TaskUpdate {
  name?: string;
  description?: string;
  priority?: Priority;
  urgent?: boolean;
  dueDate?: string | null;
  recurring?: RecurringPattern;
}

/**
 * Confirmation response from user
 */
export interface ConfirmationResponse {
  isConfirmation: boolean;
  shouldProceed: boolean;
  modifications?: string;
}

/**
 * Structured API response for todos
 */
export interface StructuredTodoResponse {
  worldId: UUID;
  worldName: string;
  rooms: Array<{
    roomId: UUID;
    roomName: string;
    tasks: Todo[];
  }>;
}
