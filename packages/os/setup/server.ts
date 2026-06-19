import type { Server } from "bun";
import { AdbFlasherBackend } from "./src/backend/adb-backend";
import { SideloaderIosBackend } from "./src/backend/ios-backend";
import type {
  IosInstallPlan,
  IosInstallStepId,
  IosInstallStepStatus,
} from "./src/backend/ios-types";
import type {
  FlashPlan,
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
  "Access-Control-Allow-Headers": "Content-Type",
};

export interface CreateServerOptions {
  port?: number;
  backend?: AdbFlasherBackend;
  iosBackend?: SideloaderIosBackend;
  depManager?: DependencyManager;
}

export type FetchHandler = (req: Request) => Promise<Response>;

export interface CreateFetchHandlerDeps {
  backend?: AdbFlasherBackend;
  iosBackend?: SideloaderIosBackend;
  depManager?: DependencyManager;
}

/**
 * Build the route handler in isolation from `Bun.serve`. Exported so tests
 * (running under vitest/node, where `globalThis.Bun` is absent) can wrap it
 * with `node:http` and exercise the real wire with `fetch`.
 */
export function createFetchHandler(
  deps: CreateFetchHandlerDeps = {},
): FetchHandler {
  const backend = deps.backend ?? new AdbFlasherBackend();
  const iosBackend = deps.iosBackend ?? new SideloaderIosBackend();
  const depManager = deps.depManager ?? new DependencyManager();

  return async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors });
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
      const request = await req.json();
      const plan = await backend.createFlashPlan(
        request as Parameters<typeof backend.createFlashPlan>[0],
      );
      return Response.json(plan, { headers: cors });
    }

    if (url.pathname === "/execute" && req.method === "POST") {
      const body = (await req.json()) as { plan: FlashPlan };
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          try {
            await backend.executeFlashPlan(
              body.plan,
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
  const deps: CreateFetchHandlerDeps = {};
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
  return bunGlobal.serve({ port, fetch: handler });
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
