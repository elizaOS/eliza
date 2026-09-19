/**
 * HTTP route `POST /api/background/run-due-tasks` that forces the runtime's TASK
 * service to run its due scheduled tasks on demand (e.g. from an external
 * scheduler or a foreground nudge). Concurrent calls are coalesced through a
 * single in-flight run so overlapping requests share one pass rather than
 * stacking, and learn via the returned `coalesced` flag. Returns 503 when the
 * runtime or task service is unavailable.
 */
import type http from "node:http";
import { ServiceType } from "@elizaos/core";
import { BackgroundTaskRunCoordinator } from "@elizaos/shared/host-use-cases";

interface TaskServiceLike {
  runDueTasks(): Promise<void>;
}

interface BackgroundTasksRuntime {
  getService(serviceType: string): unknown;
}

interface BackgroundTasksRouteState {
  runtime: BackgroundTasksRuntime | null;
}

export interface BackgroundTasksRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: BackgroundTasksRouteState;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
}

function isTaskServiceLike(service: unknown): service is TaskServiceLike {
  return (
    service !== null &&
    typeof service === "object" &&
    typeof Reflect.get(service, "runDueTasks") === "function"
  );
}

const backgroundTaskRuns = new BackgroundTaskRunCoordinator();

export async function handleBackgroundTasksRoute({
  method,
  pathname,
  state,
  json,
  res,
}: BackgroundTasksRouteContext): Promise<boolean> {
  if (
    method.toUpperCase() !== "POST" ||
    pathname !== "/api/background/run-due-tasks"
  ) {
    return false;
  }

  const runtime = state.runtime;
  if (!runtime) {
    json(
      res,
      {
        ok: false,
        error: "runtime_unavailable",
      },
      503,
    );
    return true;
  }

  const service = runtime.getService(ServiceType.TASK);
  if (!isTaskServiceLike(service)) {
    json(
      res,
      {
        ok: false,
        error: "task_service_unavailable",
      },
      503,
    );
    return true;
  }

  try {
    const result = await backgroundTaskRuns.run(service);
    json(res, {
      ok: true,
      ranAt: new Date().toISOString(),
      coalesced: result.coalesced,
    });
  } catch (error) {
    json(
      res,
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
  return true;
}
