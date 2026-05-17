/**
 * Workbench / todos compat routes.
 *
 * Handles all /api/workbench/todos routes backed by AgentRuntime tasks.
 */
import type http from "node:http";
import { type AgentRuntime } from "@elizaos/core";
import { type CompatRuntimeState } from "./compat-route-shared";
export declare function runtimeHasTodoDatabase(
  runtime: AgentRuntime | null,
): boolean;
export declare function handleWorkbenchCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean>;
//# sourceMappingURL=workbench-compat-routes.d.ts.map
