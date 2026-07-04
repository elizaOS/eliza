/**
 * Mounts POST /api/background/run-due-tasks, the entry point for platform-native
 * background wakes. It authorizes the request, resolves the canonical core
 * `TaskService` off the current runtime, and drives `runDueTasks()` — coalescing
 * concurrent wakes into a single in-flight run rather than standing up a second
 * scheduler. Returns 503 when the runtime or task service is unavailable.
 */
import type http from "node:http";
import { type Service, ServiceType } from "@elizaos/core";
import { ensureRouteAuthorized } from "./auth.ts";
import type { CompatRuntimeState } from "./compat-route-shared";
import { sendJson } from "./response";

interface TaskServiceLike {
  runDueTasks(): Promise<void>;
}

function isTaskServiceLike(
  service: Service | null,
): service is Service & TaskServiceLike {
  return (
    service !== null &&
    typeof Reflect.get(service, "runDueTasks") === "function"
  );
}

let runDueTasksInFlight: Promise<void> | null = null;

async function runDueTasksOnce(service: Service & TaskServiceLike): Promise<{
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

export async function handleBackgroundTasksRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method !== "POST" || url.pathname !== "/api/background/run-due-tasks") {
    return false;
  }

  if (!(await ensureRouteAuthorized(req, res, state))) {
    return true;
  }

  const runtime = state.current;
  if (!runtime) {
    sendJson(res, 503, {
      ok: false,
      error: "runtime_unavailable",
    });
    return true;
  }

  const service = runtime.getService(ServiceType.TASK);
  if (!isTaskServiceLike(service)) {
    sendJson(res, 503, {
      ok: false,
      error: "task_service_unavailable",
    });
    return true;
  }

  try {
    const result = await runDueTasksOnce(service);
    sendJson(res, 200, {
      ok: true,
      ranAt: new Date().toISOString(),
      coalesced: result.coalesced,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
