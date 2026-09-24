// Configures the USB installer build, server, and tests.
import { randomUUID } from "node:crypto";
import { createPlatformBackend } from "./src/backend/index";
import type {
  InstallerStepId,
  UsbInstallerBackend,
  WriteExecutionOptions,
  WritePlan,
  WriteRequest,
} from "./src/backend/types";
import { assertWritePlanAllowed } from "./src/backend/write-safety";

const PORT = Number(process.env.ELIZAOS_USB_INSTALLER_PORT ?? 3742);
const HOSTNAME = "127.0.0.1";
const DEFAULT_WRITE_PLAN_TTL_MS = 5 * 60 * 1_000;

const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:3742",
  "http://localhost:3742",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:5174",
  "http://localhost:5174",
  "http://127.0.0.1:4456",
  "http://localhost:4456",
];

interface UsbInstallerHandlerOptions {
  allowedOrigins?: readonly string[];
  planTtlMs?: number;
  now?: () => number;
}

interface StoredWritePlan {
  plan: WritePlan;
  createdAt: number;
}

interface ActiveExecution {
  controller: AbortController;
  cancellationSupported: boolean;
  targetIdentities: readonly string[];
}

interface SerializedError {
  error: string;
  name: string;
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      error: err.message,
      name: err.name,
    };
  }
  return {
    error: String(err),
    name: "Error",
  };
}

function getRequestOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") {
    return null;
  }
  return origin;
}

function configuredAllowedOrigins(
  options: UsbInstallerHandlerOptions,
): Set<string> {
  const envOrigins = (process.env.ELIZAOS_USB_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...envOrigins,
    ...(options.allowedOrigins ?? []),
  ]);
}

function configuredPlanTtlMs(options: UsbInstallerHandlerOptions): number {
  if (options.planTtlMs !== undefined) {
    return options.planTtlMs;
  }

  const value = Number(process.env.ELIZAOS_USB_PLAN_TTL_MS);
  return Number.isFinite(value) ? value : DEFAULT_WRITE_PLAN_TTL_MS;
}

function isAllowedOrigin(req: Request, allowedOrigins: Set<string>): boolean {
  const origin = getRequestOrigin(req);
  return origin === null || allowedOrigins.has(origin);
}

function corsHeaders(req: Request): HeadersInit {
  const origin = getRequestOrigin(req);
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "false",
    Vary: "Origin",
  };
}

function jsonResponse(req: Request, body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      ...corsHeaders(req),
      ...init.headers,
    },
  });
}

function errorResponse(req: Request, err: unknown, status = 500) {
  return jsonResponse(req, serializeError(err), { status });
}

function assertRawWriteGate(): void {
  if (!rawWriteEnabled()) {
    throw new Error(
      "Raw USB writes are disabled. Set ELIZAOS_USB_ENABLE_RAW_WRITE=1 only after selecting the correct removable drive and release manifest.",
    );
  }
}

function rawWriteEnabled(): boolean {
  return process.env.ELIZAOS_USB_ENABLE_RAW_WRITE === "1";
}

function addExpectedDriveSnapshot(request: WriteRequest, plan: WritePlan) {
  return {
    ...request,
    expectedDrive: {
      devicePath: plan.drive.devicePath,
      sizeBytes: plan.drive.sizeBytes,
      name: plan.drive.name,
      ...(plan.drive.stableId ? { stableId: plan.drive.stableId } : {}),
    },
  };
}

function canonicalTargetIdentities(plan: WritePlan): string[] {
  const stableId = plan.drive.stableId?.trim();
  return [
    `device-path:${plan.drive.devicePath}`,
    ...(stableId ? [`stable:${stableId}`] : []),
  ];
}

export function createUsbInstallerHandler(
  backend: UsbInstallerBackend = createPlatformBackend(),
  options: UsbInstallerHandlerOptions = {},
) {
  const plans = new Map<string, StoredWritePlan>();
  const activeExecutions = new Map<string, ActiveExecution>();
  const activeTargets = new Map<string, ActiveExecution>();
  const allowedOrigins = configuredAllowedOrigins(options);
  const planTtlMs = configuredPlanTtlMs(options);
  const now = options.now ?? Date.now;

  function deleteExpiredPlans(): void {
    const timestamp = now();
    for (const [planId, stored] of plans) {
      if (timestamp - stored.createdAt >= planTtlMs) {
        plans.delete(planId);
      }
    }
  }

  async function createStoredPlan(request: WriteRequest): Promise<WritePlan> {
    if (!request.dryRun) {
      assertRawWriteGate();
    }

    const plan = await backend.createWritePlan(request);
    if (request.dryRun) {
      return plan;
    }

    assertWritePlanAllowed(plan, {
      canonicalRawZstdSupported: backend.canonicalRawZstdSupported === true,
    });
    const planId = randomUUID();
    plans.set(planId, {
      plan,
      createdAt: now(),
    });
    return {
      ...plan,
      planId,
      cancellationSupported:
        plan.image.format === "raw.zst" &&
        backend.canonicalWriteCancellationSupported === true,
    };
  }

  async function executeStoredPlan(
    stored: StoredWritePlan,
    onProgress: (stepId: InstallerStepId, progress: number) => void,
    options: WriteExecutionOptions,
  ): Promise<void> {
    const execute = backend.executeWritePlan;
    if (!execute) {
      throw new Error(
        "This USB installer backend does not support raw write execution.",
      );
    }
    const request = addExpectedDriveSnapshot(stored.plan.request, stored.plan);
    const freshPlan = await backend.createWritePlan({
      ...request,
      dryRun: false,
      acknowledgeDataLoss: true,
    });
    assertWritePlanAllowed(freshPlan, {
      canonicalRawZstdSupported: backend.canonicalRawZstdSupported === true,
    });

    await execute.call(backend, freshPlan, onProgress, options);
  }

  return async function handleUsbInstallerRequest(req: Request) {
    if (!isAllowedOrigin(req, allowedOrigins)) {
      return errorResponse(req, new Error("Origin is not allowed."), 403);
    }

    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(req),
      });
    }

    try {
      if (url.pathname === "/health" && req.method === "GET") {
        return jsonResponse(req, {
          ok: true,
          rawWriteEnabled: rawWriteEnabled(),
        });
      }

      if (url.pathname === "/drives" && req.method === "GET") {
        const drives = await backend.listRemovableDrives();
        return jsonResponse(req, drives);
      }

      if (url.pathname === "/images" && req.method === "GET") {
        const images = await backend.listImages();
        return jsonResponse(req, images);
      }

      if (url.pathname === "/plan" && req.method === "POST") {
        const request = (await req.json()) as WriteRequest;
        const plan = await createStoredPlan(request);
        return jsonResponse(req, plan);
      }

      if (url.pathname === "/execute" && req.method === "POST") {
        const { planId } = (await req.json()) as { planId?: string };
        if (!planId) {
          return errorResponse(
            req,
            new Error("Missing planId. Create a write plan before executing."),
            400,
          );
        }
        assertRawWriteGate();
        if (!backend.executeWritePlan) {
          return errorResponse(
            req,
            new Error(
              "This USB installer backend does not support raw write execution.",
            ),
            501,
          );
        }
        if (activeExecutions.has(planId)) {
          return errorResponse(
            req,
            new Error("Write plan is already executing."),
            409,
          );
        }
        deleteExpiredPlans();
        const stored = plans.get(planId);
        if (!stored) {
          return errorResponse(
            req,
            new Error("Unknown or expired write plan. Preview the plan again."),
            409,
          );
        }
        const targetIdentities = canonicalTargetIdentities(stored.plan);
        if (targetIdentities.some((identity) => activeTargets.has(identity))) {
          return errorResponse(
            req,
            new Error("Another write is already active for this target."),
            409,
          );
        }

        const encoder = new TextEncoder();
        const executionController = new AbortController();
        const activeExecution = {
          controller: executionController,
          cancellationSupported:
            stored.plan.image.format === "raw.zst" &&
            backend.canonicalWriteCancellationSupported === true,
          targetIdentities,
        };
        // Consume the authorization and acquire both locks synchronously before
        // any target re-enumeration or stream work can yield.
        plans.delete(planId);
        activeExecutions.set(planId, activeExecution);
        for (const identity of targetIdentities) {
          activeTargets.set(identity, activeExecution);
        }

        const stream = new ReadableStream({
          async start(controller) {
            try {
              await executeStoredPlan(
                stored,
                (stepId: InstallerStepId, progress: number) => {
                  const data = JSON.stringify({ stepId, progress });
                  controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                },
                { signal: executionController.signal },
              );
              // Linearize completion against /cancel: if cancellation was
              // accepted while the backend was finishing, it must not be
              // possible to acknowledge cancellation and then report success.
              executionController.signal.throwIfAborted();
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`),
              );
            } catch (err) {
              const serialized = serializeError(err);
              const terminal =
                executionController.signal.aborted ||
                serialized.name === "WriteCancelledError"
                  ? { ...serialized, cancelled: true }
                  : serialized;
              const errData = JSON.stringify(terminal);
              controller.enqueue(encoder.encode(`data: ${errData}\n\n`));
            } finally {
              for (const [storedPlanId, candidate] of plans) {
                const candidateIdentities = canonicalTargetIdentities(
                  candidate.plan,
                );
                if (
                  candidateIdentities.some((identity) =>
                    targetIdentities.includes(identity),
                  )
                ) {
                  plans.delete(storedPlanId);
                }
              }
              if (activeExecutions.get(planId) === activeExecution) {
                activeExecutions.delete(planId);
              }
              for (const identity of targetIdentities) {
                if (activeTargets.get(identity) === activeExecution) {
                  activeTargets.delete(identity);
                }
              }
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            ...corsHeaders(req),
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
      }

      if (url.pathname === "/cancel" && req.method === "POST") {
        const { planId } = (await req.json()) as { planId?: string };
        if (!planId) {
          return errorResponse(req, new Error("Missing planId."), 400);
        }
        const execution = activeExecutions.get(planId);
        if (!execution) {
          return errorResponse(
            req,
            new Error("Write plan is not actively executing."),
            409,
          );
        }
        if (!execution.cancellationSupported) {
          return errorResponse(
            req,
            new Error("This write path does not support safe cancellation."),
            501,
          );
        }
        if (!execution.controller.signal.aborted) {
          const cancellation = new Error(
            "Write cancelled. Media is incomplete and must be rewritten or restored.",
          );
          cancellation.name = "AbortError";
          execution.controller.abort(cancellation);
        }
        return jsonResponse(req, { cancelled: true });
      }

      return new Response("Not found", {
        status: 404,
        headers: corsHeaders(req),
      });
    } catch (err) {
      return errorResponse(req, err);
    }
  };
}

if (import.meta.main) {
  Bun.serve({
    hostname: HOSTNAME,
    port: PORT,
    fetch: createUsbInstallerHandler(),
  });

  console.log(
    `USB installer backend running at http://${HOSTNAME}:${PORT} (raw writes ${rawWriteEnabled() ? "enabled" : "disabled"})`,
  );
}
