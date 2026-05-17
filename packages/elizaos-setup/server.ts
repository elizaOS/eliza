import type { Server } from "bun";
import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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

async function readNodeBody(req: IncomingMessage): Promise<Buffer | null> {
  if (req.method === "GET" || req.method === "HEAD") {
    return null;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

async function writeNodeResponse(
  webResponse: Response,
  res: ServerResponse,
): Promise<void> {
  res.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => res.setHeader(key, value));

  if (!webResponse.body) {
    res.end();
    return;
  }

  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}

function createNodeServer(
  port: number,
  fetchHandler: (req: Request) => Response | Promise<Response>,
): Server<undefined> {
  const listenPort =
    port === 0 ? 30_000 + Math.floor(Math.random() * 10_000) : port;
  const nodeServer = createNodeHttpServer(async (req, res) => {
    try {
      const host = req.headers.host ?? `127.0.0.1:${listenPort}`;
      const body = await readNodeBody(req);
      const requestBody = body
        ? (body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer)
        : null;
      const request = new Request(`http://${host}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers: req.headers as HeadersInit,
        body: requestBody,
      });
      await writeNodeResponse(await fetchHandler(request), res);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });

  nodeServer.listen(listenPort, "127.0.0.1");

  return {
    get port() {
      const address = nodeServer.address();
      return typeof address === "object" && address ? address.port : listenPort;
    },
    stop(force?: boolean) {
      void force;
      nodeServer.close();
    },
  } as Server<undefined>;
}

export function createServer(
  options: CreateServerOptions = {},
): Server<undefined> {
  const backend = options.backend ?? new AdbFlasherBackend();
  const iosBackend = options.iosBackend ?? new SideloaderIosBackend();
  const depManager = options.depManager ?? new DependencyManager();
  const port = options.port ?? Number(process.env.ELIZA_SETUP_PORT ?? 3743);

  const fetchHandler = async (req: Request): Promise<Response> => {
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

  // Use Bun.serve via the global so this file can be imported by toolchains
  // that do not resolve the bare "bun" module specifier. Vitest runs under
  // Node, so it gets a small HTTP fallback around the same fetch handler.
  const bunGlobal = (globalThis as {
    Bun?: { serve: typeof import("bun").serve };
  }).Bun;
  if (!bunGlobal) {
    return createNodeServer(port, fetchHandler);
  }

  return bunGlobal.serve({
    port,
    fetch: fetchHandler,
  });
}

// Run as a script: `bun server.ts` boots the production server on PORT.
// When imported (e.g. from a test that calls `createServer({...})`), this
// branch is a no-op because import.meta.main is false.
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
