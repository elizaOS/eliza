import {
  type IAgentRuntime,
  logger,
  type Route,
  type RouteRequest,
  type RouteResponse,
} from "@elizaos/core";
import type {
  ClaudeCodeWorkbenchService,
  WorkbenchRunInput,
} from "./services/workbench-service.ts";

function getService(runtime: IAgentRuntime): ClaudeCodeWorkbenchService {
  const service = runtime.getService(
    "claude_code_workbench",
  ) as ClaudeCodeWorkbenchService | null;
  if (!service) {
    throw new Error("Claude Code workbench service not available");
  }
  return service;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseRunInput(body: unknown): WorkbenchRunInput | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const record = body as Record<string, unknown>;
  const workflow = toStringOrUndefined(record.workflow);

  if (!workflow) {
    return null;
  }

  return {
    workflow,
    cwd: toStringOrUndefined(record.cwd),
    stdin: toStringOrUndefined(record.stdin),
  };
}

const statusRoute: Route = {
  name: "claude-code-workbench-status",
  public: false,
  path: "/status",
  type: "GET",
  handler: async (
    _req: RouteRequest,
    res: RouteResponse,
    runtime: IAgentRuntime,
  ) => {
    try {
      const service = getService(runtime);
      res.json({ ok: true, status: service.getStatus() });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

const workflowsRoute: Route = {
  name: "claude-code-workbench-workflows",
  public: false,
  path: "/workflows",
  type: "GET",
  handler: async (
    _req: RouteRequest,
    res: RouteResponse,
    runtime: IAgentRuntime,
  ) => {
    try {
      const service = getService(runtime);
      res.json({ ok: true, workflows: service.listWorkflows() });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

const runRoute: Route = {
  name: "claude-code-workbench-run",
  public: false,
  path: "/run",
  type: "POST",
  handler: async (
    req: RouteRequest,
    res: RouteResponse,
    runtime: IAgentRuntime,
  ) => {
    try {
      const input = parseRunInput(req.body);
      if (!input) {
        res.status(400).json({
          ok: false,
          error:
            "Invalid run request. Provide non-empty `workflow` in request body.",
        });
        return;
      }

      const service = getService(runtime);
      const result = await service.run(input);
      res.status(result.ok ? 200 : 500).json({ ok: result.ok, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Claude Code workbench route error: ${message}`);
      res.status(500).json({ ok: false, error: message });
    }
  },
};

export const claudeCodeWorkbenchRoutes: Route[] = [
  statusRoute,
  workflowsRoute,
  runRoute,
];
