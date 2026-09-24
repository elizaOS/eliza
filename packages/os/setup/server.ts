// Configures the AOSP setup flasher build and tests.
import type { Server } from "bun";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AdbFlasherBackend } from "./src/backend/adb-backend";
import { SideloaderIosBackend } from "./src/backend/ios-backend";
import type {
  IosInstallPlan,
  IosInstallStepId,
  IosInstallStepStatus,
} from "./src/backend/ios-types";
import type {
  FlashPlan,
  FlashRequest,
  FlashStepId,
  FlashStepStatus,
} from "./src/backend/types";
import { DependencyManager } from "./src/dependencies/dep-manager";
import type { DependencyId } from "./src/dependencies/types";

const VALID_DEP_IDS: DependencyId[] = [
  "adb",
  "fastboot",
  "libimobiledevice",
  "sideloader",
];

function parseDepId(pathname: string, suffix: string): DependencyId | null {
  // pathname = "/dependencies/<id>" or "/dependencies/<id>/install"
  const rest = pathname.slice("/dependencies/".length);
  const idPart = suffix ? rest.replace(suffix, "") : rest;
  const id = idPart as DependencyId;
  return VALID_DEP_IDS.includes(id) ? id : null;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Eliza-Setup-Token",
};
const PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_PLANS = 8;

function validAuthToken(request: Request, expected: string): boolean {
  const supplied = request.headers.get("X-Eliza-Setup-Token");
  if (!supplied) return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function validateFlashRequest(value: unknown): FlashRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("execute request must be an object");
  }
  const request = value as Record<string, unknown>;
  if (
    typeof request.deviceSerial !== "string" ||
    request.deviceSerial.length === 0 ||
    request.deviceSerial.length > 256
  ) {
    throw new Error("execute request has an invalid device serial");
  }
  if (
    typeof request.buildId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(request.buildId)
  ) {
    throw new Error("execute request has an invalid build id");
  }
  if (
    typeof request.wipeData !== "boolean" ||
    typeof request.dryRun !== "boolean"
  ) {
    throw new Error("execute request requires boolean safety flags");
  }
  const validSteps: FlashStepId[] = [
    "detect-device",
    "check-bootloader",
    "reboot-bootloader",
    "unlock-bootloader",
    "download-artifacts",
    "verify-artifacts",
    "flash-partitions",
    "reboot-android",
    "validate-boot",
    "complete",
  ];
  if (
    request.stopAfter !== undefined &&
    (typeof request.stopAfter !== "string" ||
      !validSteps.includes(request.stopAfter as FlashStepId))
  ) {
    throw new Error("execute request has an invalid stopAfter step");
  }
  return {
    deviceSerial: request.deviceSerial,
    buildId: request.buildId,
    wipeData: request.wipeData,
    dryRun: request.dryRun,
    ...(request.stopAfter
      ? { stopAfter: request.stopAfter as FlashStepId }
      : {}),
  };
}

export interface CreateServerOptions {
  port?: number;
  authToken?: string;
  backend?: AdbFlasherBackend;
  iosBackend?: SideloaderIosBackend;
  depManager?: DependencyManager;
}

export type FetchHandler = (req: Request) => Promise<Response>;

export function createServerErrorResponse(_error: unknown): Response {
  return Response.json(
    { error: "The setup service could not complete this request." },
    { status: 500, headers: cors },
  );
}

export interface CreateFetchHandlerDeps {
  authToken?: string;
  backend?: AdbFlasherBackend;
  iosBackend?: SideloaderIosBackend;
  depManager?: DependencyManager;
}

/**
 * Build the route handler in isolation from `Bun.serve`. Exported so tests
 * (running under vitest/node, where `globalThis.Bun` is absent) can exercise
 * the production routing and response logic with standard WHATWG requests.
 */
export function createFetchHandler(
  deps: CreateFetchHandlerDeps = {},
): FetchHandler {
  const backend = deps.backend ?? new AdbFlasherBackend();
  const iosBackend = deps.iosBackend ?? new SideloaderIosBackend();
  const depManager = deps.depManager ?? new DependencyManager();
  const authToken = deps.authToken;
  const pendingPlans = new Map<
    string,
    { createdAt: number; plan: FlashPlan }
  >();

  const prunePlans = () => {
    const expiredBefore = Date.now() - PLAN_TTL_MS;
    for (const [token, pending] of pendingPlans) {
      if (pending.createdAt < expiredBefore) pendingPlans.delete(token);
    }
  };

  return async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (authToken && !validAuthToken(req, authToken)) {
      return new Response("Unauthorized", { status: 401, headers: cors });
    }

    if (url.pathname === "/dependencies" && req.method === "GET") {
      const results = await depManager.checkAll();
      return Response.json(results, { headers: cors });
    }

    // GET /dependencies/:id — check a single dependency
    if (
      url.pathname.startsWith("/dependencies/") &&
      !url.pathname.endsWith("/install") &&
      req.method === "GET"
    ) {
      const id = parseDepId(url.pathname, "");
      if (!id) {
        return new Response("Unknown dependency", {
          status: 400,
          headers: cors,
        });
      }
      const result = await depManager.checkOne(id);
      return Response.json(result, { headers: cors });
    }

    // POST /dependencies/:id/install — trigger auto-install (canonical path)
    if (
      url.pathname.startsWith("/dependencies/") &&
      url.pathname.endsWith("/install") &&
      req.method === "POST"
    ) {
      const id = parseDepId(url.pathname, "/install");
      if (!id) {
        return new Response("Unknown dependency", {
          status: 400,
          headers: cors,
        });
      }
      const result = await depManager.autoInstall(id);
      return Response.json(result, { headers: cors });
    }

    // POST /dependencies/:id — legacy alias (kept for the brief window where
    // the old client may still be running against a new server).
    if (
      url.pathname.startsWith("/dependencies/") &&
      !url.pathname.endsWith("/install") &&
      req.method === "POST"
    ) {
      const id = parseDepId(url.pathname, "");
      if (!id) {
        return new Response("Unknown dependency", {
          status: 400,
          headers: cors,
        });
      }
      const result = await depManager.autoInstall(id);
      return Response.json(result, { headers: cors });
    }

    if (url.pathname === "/devices" && req.method === "GET") {
      const devices = await backend.listConnectedDevices();
      return Response.json(devices, { headers: cors });
    }

    if (url.pathname === "/specs" && req.method === "POST") {
      const body = (await req.json()) as { serial: string };
      const specs = await backend.getDeviceSpecs(body.serial);
      return Response.json(specs, { headers: cors });
    }

    if (url.pathname === "/builds" && req.method === "GET") {
      const builds = await backend.listBuilds();
      return Response.json(builds, { headers: cors });
    }

    if (url.pathname === "/plan" && req.method === "POST") {
      const request = validateFlashRequest(await req.json());
      const plan = await backend.createFlashPlan(request);
      prunePlans();
      if (pendingPlans.size >= MAX_PENDING_PLANS) {
        return new Response("Too many pending flash plans", {
          status: 429,
          headers: cors,
        });
      }
      const executionToken = randomBytes(32).toString("hex");
      pendingPlans.set(executionToken, { createdAt: Date.now(), plan });
      return Response.json({ ...plan, executionToken }, { headers: cors });
    }

    if (url.pathname === "/execute" && req.method === "POST") {
      const body = (await req.json()) as { executionToken?: unknown };
      prunePlans();
      if (
        typeof body.executionToken !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.executionToken)
      ) {
        return new Response("Invalid flash plan token", {
          status: 400,
          headers: cors,
        });
      }
      const pending = pendingPlans.get(body.executionToken);
      pendingPlans.delete(body.executionToken);
      if (!pending) {
        return new Response("Flash plan token is expired or already used", {
          status: 409,
          headers: cors,
        });
      }
      const { plan } = pending;
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          try {
            await backend.executeFlashPlan(
              plan,
              (
                stepId: FlashStepId,
                status: FlashStepStatus,
                detail: string,
              ) => {
                const data = JSON.stringify({ stepId, status, detail });
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              },
            );
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`),
            );
          } catch (err) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: String(err) })}\n\n`,
              ),
            );
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          ...cors,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    // ── iOS sideloading endpoints ──────────────────────────────────────────────

    if (url.pathname === "/ios/devices" && req.method === "GET") {
      const devices = await iosBackend.listDevices();
      return Response.json(devices, { headers: cors });
    }

    if (url.pathname === "/ios/apps" && req.method === "GET") {
      const apps = await iosBackend.listApps();
      return Response.json(apps, { headers: cors });
    }

    if (url.pathname === "/ios/region" && req.method === "GET") {
      const region = await iosBackend.getRegionNotice();
      return Response.json(region, { headers: cors });
    }

    if (url.pathname === "/ios/authenticate" && req.method === "POST") {
      const body = (await req.json()) as { appleId: string; password: string };
      const state = await iosBackend.authenticate(body.appleId, body.password);
      return Response.json(state, { headers: cors });
    }

    if (url.pathname === "/ios/2fa" && req.method === "POST") {
      const body = (await req.json()) as { code: string };
      const state = await iosBackend.submit2fa(body.code);
      return Response.json(state, { headers: cors });
    }

    if (url.pathname === "/ios/plan" && req.method === "POST") {
      const request = (await req.json()) as Parameters<
        typeof iosBackend.createInstallPlan
      >[0];
      const plan = await iosBackend.createInstallPlan(request);
      return Response.json(plan, { headers: cors });
    }

    if (url.pathname === "/ios/execute" && req.method === "POST") {
      const body = (await req.json()) as { plan: IosInstallPlan };
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          try {
            await iosBackend.executeInstallPlan(
              body.plan,
              (
                stepId: IosInstallStepId,
                status: IosInstallStepStatus,
                detail?: string,
              ) => {
                const data = JSON.stringify({ stepId, status, detail });
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              },
            );
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`),
            );
          } catch (err) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: String(err) })}\n\n`,
              ),
            );
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          ...cors,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response("Not found", { status: 404, headers: cors });
  };
}

export function createServer(
  options: CreateServerOptions = {},
): Server<undefined> {
  const port = options.port ?? Number(process.env.ELIZA_SETUP_PORT ?? 3743);
  const authToken = options.authToken ?? process.env.ELIZA_SETUP_TOKEN;
  if (!authToken || authToken.length < 32) {
    throw new Error(
      "createServer requires an ELIZA_SETUP_TOKEN of at least 32 characters",
    );
  }
  const deps: CreateFetchHandlerDeps = {};
  deps.authToken = authToken;
  if (options.backend) deps.backend = options.backend;
  if (options.iosBackend) deps.iosBackend = options.iosBackend;
  if (options.depManager) deps.depManager = options.depManager;
  const handler = createFetchHandler(deps);

  // Use Bun.serve via the global so this file can be imported by toolchains
  // (vitest/node) that don't resolve the bare "bun" module specifier. The
  // factory still requires the Bun runtime to actually call it.
  const bunGlobal = (
    globalThis as { Bun?: { serve: typeof import("bun").serve } }
  ).Bun;
  if (!bunGlobal) {
    throw new Error("createServer requires the Bun runtime (globalThis.Bun)");
  }
  return bunGlobal.serve({
    hostname: "127.0.0.1",
    port,
    fetch: handler,
    error: createServerErrorResponse,
  });
}

// Run as a script: `bun server.ts` boots the production server on PORT.
// When imported (e.g. from a test that calls `createServer({...})`), this
// branch stays inactive because import.meta.main is false.
if (import.meta.main) {
  const server = createServer();
  console.log(
    `elizaOS Setup backend running at http://127.0.0.1:${server.port}`,
  );
  console.log("Run: adb devices   to verify your device is connected");
  // Emit the bound URL so the dev orchestrator / Electrobun main process can
  // pick it up and inject `window.__ELIZA_SERVER_URL__` into the renderer
  // before the React app mounts.
  console.log(
    `[elizaos-setup] ELIZA_SETUP_SERVER_URL=http://127.0.0.1:${server.port}`,
  );
}
