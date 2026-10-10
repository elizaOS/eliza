/** Restricted renderer transport. Observation/proposal/result payloads never come
 * from this API. Hosts supply authentication and trusted goal authorization.
 */
import {
  ElizaError,
  type InteractiveTask,
  sameTaskOwner,
  type TaskOwner,
} from "@elizaos/core/protocol";
import type {
  AuthorizedTaskGoal,
  InteractiveTaskRuntime,
} from "./interactive-task-runtime.ts";

function json(status: number, value: unknown): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
function view(task: InteractiveTask) {
  return {
    schemaVersion: task.schemaVersion,
    id: task.id,
    revision: task.revision,
    epoch: task.epoch,
    status: task.status,
    hasUnknownOutcome: task.operations.some(
      (operation) => operation.status === "unknown",
    ),
  };
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new ElizaError("JSON required", { code: "TASK_INVALID" });
  const reader = request.body?.getReader();
  if (!reader) throw new ElizaError("Body required", { code: "TASK_INVALID" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        throw new ElizaError("Body too large", { code: "TASK_INVALID" });
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ElizaError("Invalid JSON", { code: "TASK_INVALID" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ElizaError("Object required", { code: "TASK_INVALID" });
  return value as Record<string, unknown>;
}

export function createInteractiveTaskHandler(options: {
  runtime: InteractiveTaskRuntime;
  /** Must check current session/grant validity, including after asynchronous work. */
  authenticate: (request: Request) => Promise<TaskOwner | null>;
  /** Resolve a server-known goal reference; renderer data is never authorization. */
  authorizeGoal: (
    goalRef: string,
    owner: TaskOwner,
  ) => Promise<AuthorizedTaskGoal>;
}): (request: Request) => Promise<Response> {
  async function authenticated(request: Request): Promise<boolean> {
    const owner = await options.authenticate(request);
    return !!owner && sameTaskOwner(owner, options.runtime.owner);
  }
  return async (request) => {
    try {
      if (!(await authenticated(request)))
        return json(401, { code: "TASK_UNAUTHORIZED" });
      const url = new URL(request.url);
      // Pause the current task as soon as the request arrives. It reads the
      // revision on the host, so it never waits for earlier cleanup, a
      // pending start reply or a second renderer round trip.
      if (url.pathname === "/tasks/current/pause" && !url.search) {
        if (request.method !== "POST")
          return json(405, { code: "TASK_METHOD_NOT_ALLOWED" });
        const input = await body(request);
        const keys = Object.keys(input);
        if (
          keys.some((key) => key !== "reason") ||
          (keys.length === 1 && input.reason !== "close")
        )
          return json(400, { code: "TASK_INVALID" });
        if (!(await authenticated(request)))
          return json(401, { code: "TASK_UNAUTHORIZED" });
        const close = input.reason === "close";
        let task = options.runtime.current();
        // Close still reaches a paused task, so the host removes its guide.
        if (
          task &&
          !["completed", "cancelled"].includes(task.status) &&
          (task.status !== "paused" || close)
        )
          task = options.runtime.control(
            task.id,
            task.revision,
            close ? "close" : "pause",
          );
        await options.runtime.settle(task?.id);
        if (!(await authenticated(request)))
          return json(401, { code: "TASK_UNAUTHORIZED" });
        return json(200, { task: task ? view(task) : null });
      }
      await options.runtime.settle();
      if (!(await authenticated(request)))
        return json(401, { code: "TASK_UNAUTHORIZED" });
      const eventsRoute =
        /^\/tasks\/([A-Za-z0-9][A-Za-z0-9_.:@-]{0,255})\/events$/.exec(
          url.pathname,
        );
      if (eventsRoute) {
        if (request.method !== "GET")
          return json(405, { code: "TASK_METHOD_NOT_ALLOWED" });
        const values = [...url.searchParams];
        if (
          values.length > 1 ||
          (values.length === 1 &&
            (values[0][0] !== "after" ||
              !/^(?:-1|0|[1-9][0-9]*)$/.test(values[0][1])))
        )
          return json(400, { code: "TASK_INVALID" });
        const result = options.runtime.events(
          eventsRoute[1],
          values.length ? Number(values[0][1]) : -1,
        );
        return json(200, { ...result, task: view(result.task) });
      }
      if (url.search) return json(400, { code: "TASK_INVALID" });
      if (url.pathname === "/tasks/current" && request.method === "GET") {
        const current = options.runtime.current();
        return json(200, { task: current ? view(current) : null });
      }
      if (url.pathname === "/tasks" && request.method === "POST") {
        const input = await body(request);
        if (
          Object.keys(input).length !== 1 ||
          typeof input.goalRef !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(input.goalRef)
        )
          return json(400, { code: "TASK_INVALID" });
        const goal = await options.authorizeGoal(
          input.goalRef,
          options.runtime.owner,
        );
        if (!(await authenticated(request)))
          return json(401, { code: "TASK_UNAUTHORIZED" });
        if (goal.goalRef !== input.goalRef)
          return json(403, { code: "TASK_ACTION_DENIED" });
        return json(201, { task: view(options.runtime.create(goal)) });
      }
      const match =
        /^\/tasks\/([A-Za-z0-9][A-Za-z0-9_.:@-]{0,255})(?:\/(pause|cancel|resume))?$/.exec(
          url.pathname,
        );
      if (!match) return json(404, { code: "TASK_NOT_FOUND" });
      const [, id, command] = match;
      if (!command && request.method === "GET")
        return json(200, { task: view(options.runtime.get(id)) });
      if (!command || request.method !== "POST")
        return json(405, { code: "TASK_METHOD_NOT_ALLOWED" });
      const input = await body(request);
      // Pause accepts reason "close": the user also closed the task surface.
      const close = command === "pause" && "reason" in input;
      if (
        Object.keys(input).length !== (close ? 2 : 1) ||
        (close && input.reason !== "close") ||
        !Number.isSafeInteger(input.expectedRevision) ||
        Number(input.expectedRevision) < 0
      )
        return json(400, { code: "TASK_INVALID" });
      if (!(await authenticated(request)))
        return json(401, { code: "TASK_UNAUTHORIZED" });
      const task =
        command === "resume"
          ? await options.runtime.observe(
              id,
              Number(input.expectedRevision),
              true,
              () => authenticated(request),
            )
          : options.runtime.control(
              id,
              Number(input.expectedRevision),
              close ? "close" : (command as "pause" | "cancel"),
            );
      await options.runtime.settle(id);
      if (!(await authenticated(request)))
        return json(401, { code: "TASK_UNAUTHORIZED" });
      return json(200, { task: view(task) });
    } catch (error) {
      if (!(error instanceof ElizaError))
        return json(503, { code: "TASK_UNAVAILABLE" });
      const status =
        error.code === "TASK_NOT_FOUND"
          ? 404
          : error.code === "TASK_INVALID"
            ? 400
            : error.code === "TASK_ACTION_DENIED"
              ? 403
              : error.code.startsWith("TASK_STORAGE") ||
                  error.code === "TASK_CLEANUP_UNCONFIRMED"
                ? 503
                : 409;
      return json(status, { code: error.code });
    }
  };
}
