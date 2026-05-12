import { randomBytes } from "node:crypto";
import type http from "node:http";
import { type Service, ServiceType } from "@elizaos/core";
import type { CompatRuntimeState } from "./compat-route-shared";
import { readCompatJsonBody } from "./compat-route-shared";
import { sendJson } from "./response";

/**
 * Internal routes called by sandboxed background-runner JSContexts (Capacitor
 * BackgroundRunner on iOS QuickJS / Android V8) and by other host shims that
 * cannot use the cookie-based session auth.
 *
 * Auth model: a single device-secret bearer token. The runner JS is shipped
 * with the secret as one of its event args at build/launch time, so the
 * secret travels in-process and is not user input.
 *
 * TODO(device-secret): the persistent on-disk store does not exist yet. For
 * now we generate an in-memory secret at boot and surface it through
 * `getDeviceSecret()` so Wave 3A/3B can seed the runner. When the secret
 * store lands, swap `getDeviceSecret` for the persistent variant and remove
 * the in-memory fallback.
 */

/**
 * The runtime contract is `runDueTasks(): Promise<void>`. The optional
 * `maxWallTimeMs` is currently advisory — passed through so a future
 * TaskService update can honour deadline-bounded execution without a route
 * signature change. `ranTasks` similarly is reported as 0 today because the
 * service returns void; if/when core exposes an executed count we surface
 * that without breaking callers.
 */
interface TaskServiceLike {
  runDueTasks(options?: { maxWallTimeMs?: number }): Promise<unknown>;
}

function isTaskServiceLike(
  service: Service | null,
): service is Service & TaskServiceLike {
  return (
    service !== null &&
    typeof Reflect.get(service, "runDueTasks") === "function"
  );
}

/**
 * Wake telemetry visible to /api/health. Wave 5 reads `lastWakeFiredAt` to
 * surface "last background tick" on the dashboard.
 */
export interface WakeTelemetry {
  lastWakeFiredAt: number | null;
  lastWakeKind: "refresh" | "processing" | null;
  lastWakeDurationMs: number | null;
  lastWakeRanTasks: number | null;
  lastWakeError: string | null;
}

const wakeTelemetry: WakeTelemetry = {
  lastWakeFiredAt: null,
  lastWakeKind: null,
  lastWakeDurationMs: null,
  lastWakeRanTasks: null,
  lastWakeError: null,
};

export function getWakeTelemetry(): Readonly<WakeTelemetry> {
  return { ...wakeTelemetry };
}

// Resets between tests; not exported through the public barrel.
export function __resetWakeTelemetryForTests(): void {
  wakeTelemetry.lastWakeFiredAt = null;
  wakeTelemetry.lastWakeKind = null;
  wakeTelemetry.lastWakeDurationMs = null;
  wakeTelemetry.lastWakeRanTasks = null;
  wakeTelemetry.lastWakeError = null;
}

let cachedDeviceSecret: string | null = null;

/**
 * Returns the bearer secret that wake POSTs must present. Generates one on
 * first call and reuses it for the process lifetime.
 *
 * TODO(device-secret): persist this to the state dir so the runner JS,
 * which is rebuilt independently of the host process, can be seeded with a
 * stable value. Today every process restart rotates the secret.
 */
export function getDeviceSecret(): string {
  if (cachedDeviceSecret === null) {
    const fromEnv = process.env.ELIZA_DEVICE_SECRET;
    if (typeof fromEnv === "string" && fromEnv.length >= 16) {
      cachedDeviceSecret = fromEnv;
    } else {
      cachedDeviceSecret = randomBytes(32).toString("hex");
    }
  }
  return cachedDeviceSecret;
}

export function __setDeviceSecretForTests(secret: string | null): void {
  cachedDeviceSecret = secret;
}

function readBearer(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return null;
  if (!raw.toLowerCase().startsWith("bearer ")) return null;
  return raw.slice(7).trim();
}

/**
 * Constant-time string comparison. Bearer secrets must not leak via
 * early-exit comparison timing.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

let runDueTasksInFlight: Promise<unknown> | null = null;

async function runDueTasksOnce(
  service: Service & TaskServiceLike,
  options: { maxWallTimeMs: number },
): Promise<{ coalesced: boolean }> {
  if (runDueTasksInFlight !== null) {
    await runDueTasksInFlight;
    return { coalesced: true };
  }
  runDueTasksInFlight = service.runDueTasks(options);
  try {
    await runDueTasksInFlight;
    return { coalesced: false };
  } finally {
    runDueTasksInFlight = null;
  }
}

interface WakeBody {
  kind: "refresh" | "processing";
  deadlineMs: number;
}

function parseWakeBody(body: Record<string, unknown> | null): WakeBody | null {
  if (body === null) return null;
  const kind = body.kind;
  const deadlineMs = body.deadlineMs;
  if (kind !== "refresh" && kind !== "processing") return null;
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs))
    return null;
  return { kind, deadlineMs };
}

export async function handleInternalWakeRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method !== "POST" || url.pathname !== "/api/internal/wake") {
    return false;
  }

  const presented = readBearer(req);
  const expected = getDeviceSecret();
  if (presented === null || !safeEqual(presented, expected)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }

  const body = await readCompatJsonBody(req, res);
  if (body === null) {
    // readCompatJsonBody already wrote 400/413 on failure.
    return true;
  }

  const parsed = parseWakeBody(body);
  if (parsed === null) {
    sendJson(res, 400, {
      ok: false,
      error:
        'invalid body: expected { kind: "refresh" | "processing", deadlineMs: number }',
    });
    return true;
  }

  const runtime = state.current;
  if (!runtime) {
    sendJson(res, 503, { ok: false, error: "runtime_unavailable" });
    return true;
  }

  const taskService = runtime.getService(ServiceType.TASK);
  if (!isTaskServiceLike(taskService)) {
    sendJson(res, 503, { ok: false, error: "task_service_unavailable" });
    return true;
  }

  const startedAt = Date.now();
  // Deadline is the absolute target wall time the caller wants us done by.
  // Clamp to at least 1s so an already-expired deadline can't pin runDueTasks
  // to a zero/negative budget.
  const maxWallTimeMs = Math.max(1000, parsed.deadlineMs - startedAt);

  try {
    const result = await runDueTasksOnce(taskService, { maxWallTimeMs });
    const durationMs = Date.now() - startedAt;
    const resultRecord = result as unknown as { ranTasks?: unknown };
    const ranTasks =
      result && typeof resultRecord.ranTasks === "number"
        ? Number(resultRecord.ranTasks)
        : 0;
    wakeTelemetry.lastWakeFiredAt = startedAt;
    wakeTelemetry.lastWakeKind = parsed.kind;
    wakeTelemetry.lastWakeDurationMs = durationMs;
    wakeTelemetry.lastWakeRanTasks = ranTasks;
    wakeTelemetry.lastWakeError = null;
    sendJson(res, 200, {
      ok: true,
      ranTasks,
      durationMs,
      coalesced: result.coalesced,
      lastWakeFiredAt: startedAt,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    wakeTelemetry.lastWakeFiredAt = startedAt;
    wakeTelemetry.lastWakeKind = parsed.kind;
    wakeTelemetry.lastWakeDurationMs = Date.now() - startedAt;
    wakeTelemetry.lastWakeRanTasks = null;
    wakeTelemetry.lastWakeError = message;
    sendJson(res, 500, { ok: false, error: message });
  }
  return true;
}
