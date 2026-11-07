import type { WorkbenchTodo } from "@elizaos/contracts";
/** HTTP context shared by workbench overview and VFS routes. */

import type http from "node:http";
import type { AgentRuntime, Task, UUID } from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/host/protocol";

import type { TriggerSummary } from "../triggers/types.ts";

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
  toWorkbenchTodo: (task: Task) => WorkbenchTodo | null;
  decodePathComponent: (
    raw: string,
    res: http.ServerResponse,
    label: string,
  ) => string | null;
  taskToTriggerSummary: (task: Task) => TriggerSummary | null;
  listTriggerTasks: (runtime: AgentRuntime) => Promise<Task[]>;
}
