import type http from "node:http";
import { ServiceType } from "@elizaos/core";

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

function isTaskServiceLike(
  service: unknown,
): service is TaskServiceLike {
  return (
    service !== null &&
    typeof service === "object" &&
    typeof Reflect.get(service, "runDueTasks") === "function"
  );
}

let runDueTasksInFlight: Promise<void> | null = null;

async function runDueTasksOnce(service: TaskServiceLike): Promise<{
  coalesced: boolean;
}> {
  if (runDueTasksInFlight !== null) {
    await runDueTasksInFlight;
    return { coalesced: true };
  }

  runDueTasksInFlight = service.runDueTasks();
  try {
    await runDueTasksInFlight;
    return { coalesced: false };
  } finally {
    runDueTasksInFlight = null;
  }
}

export async function handleBackgroundTasksRoute({
  method,
  pathname,
  state,
  json,
  res,
}: BackgroundTasksRouteContext): Promise<boolean> {
  if (method.toUpperCase() !== "POST" || pathname !== "/api/background/run-due-tasks") {
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
    const result = await runDueTasksOnce(service);
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
