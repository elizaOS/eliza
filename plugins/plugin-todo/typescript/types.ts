/**
 * Type definitions for plugin-todo
 * This file is used for TypeScript type checking.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type TodoPriority = 'low' | 'medium' | 'high';

export interface TodoItem {
  id: string;
  status: TodoStatus;
  priority: TodoPriority;
}

