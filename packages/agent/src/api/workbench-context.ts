/**
 * Shared context type for workbench routes.
 *
 * Extracted from workbench-routes.ts to break the workbench-routes ↔
 * workbench-vfs-routes circular dependency.
 *
 * @module api/workbench-context
 */

import type http from "node:http";
import type { AgentRuntime, Task, UUID } from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import type { TriggerSummary } from "../triggers/types.ts";

export interface WorkbenchTodoView {
  id: string;
  name: string;
  description: string;
  priority: number | null;
  isUrgent: boolean;
  type: string;
  isCompleted: boolean;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkbenchRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: {
    runtime: AgentRuntime | null;
    adminEntityId: UUID | null;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  // Helpers from server.ts
  toWorkbenchTodo: (task: Task) => WorkbenchTodoView | null;
  normalizeTags: (value: unknown, required?: string[]) => string[];
  readTaskMetadata: (task: Task) => Record<string, unknown>;
  readTaskCompleted: (task: Task) => boolean;
  parseNullableNumber: (value: unknown) => number | null;
  asObject: (value: unknown) => Record<string, unknown> | null;
  decodePathComponent: (
    raw: string,
    res: http.ServerResponse,
    label: string,
  ) => string | null;
  taskToTriggerSummary: (task: Task) => TriggerSummary | null;
  listTriggerTasks: (runtime: AgentRuntime) => Promise<Task[]>;
}
