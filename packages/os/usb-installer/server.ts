import { randomUUID } from "node:crypto";
import { createPlatformBackend } from "./src/backend/index";
import type {
  InstallerStepId,
  UsbInstallerBackend,
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
    },
  };
}

export function createUsbInstallerHandler(
  backend: UsbInstallerBackend = createPlatformBackend(),
  options: UsbInstallerHandlerOptions = {},
) {
  const plans = new Map<string, StoredWritePlan>();
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

    assertWritePlanAllowed(plan);
    const planId = randomUUID();
    plans.set(planId, {
      plan,
      createdAt: now(),
    });
    return { ...plan, planId };
  }

  async function executeStoredPlan(
    planId: string,
    onProgress: (stepId: InstallerStepId, progress: number) => void,
  ): Promise<void> {
    assertRawWriteGate();

    if (!backend.executeWritePlan) {
      throw new Error("executeWritePlan is not implemented on this platform.");
    }

    deleteExpiredPlans();

    const stored = plans.get(planId);
    if (!stored) {
      throw new Error("Unknown or expired write plan. Preview the plan again.");
    }

    const request = addExpectedDriveSnapshot(stored.plan.request, stored.plan);
    const freshPlan = await backend.createWritePlan({
      ...request,
      dryRun: false,
      acknowledgeDataLoss: true,
    });
    assertWritePlanAllowed(freshPlan);

    await backend.executeWritePlan(freshPlan, onProgress);
    plans.delete(planId);
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

        const encoder = new TextEncoder();

        const stream = new ReadableStream({
          async start(controller) {
            try {
              await executeStoredPlan(
                planId,
                (stepId: InstallerStepId, progress: number) => {
                  const data = JSON.stringify({ stepId, progress });
                  controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                },
              );
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`),
              );
            } catch (err) {
              const errData = JSON.stringify(serializeError(err));
              controller.enqueue(encoder.encode(`data: ${errData}\n\n`));
            } finally {
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
