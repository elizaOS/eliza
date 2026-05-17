import { serve } from "bun";
import { AdbFlasherBackend } from "./src/backend/adb-backend";
import { SideloaderIosBackend } from "./src/backend/ios-backend";
import type { FlashPlan, FlashStepId, FlashStepStatus } from "./src/backend/types";
import type { IosInstallPlan, IosInstallStepId, IosInstallStepStatus } from "./src/backend/ios-types";
import { DependencyManager } from "./src/dependencies/dep-manager";
import type { DependencyId } from "./src/dependencies/types";

const backend = new AdbFlasherBackend();
const iosBackend = new SideloaderIosBackend();
const depManager = new DependencyManager();
const PORT = 3743;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === "/dependencies" && req.method === "GET") {
      const results = await depManager.checkAll();
      return Response.json(results, { headers: cors });
    }

    if (url.pathname.startsWith("/dependencies/") && req.method === "POST") {
      const id = url.pathname.slice("/dependencies/".length) as DependencyId;
      const validIds: DependencyId[] = ["adb", "fastboot", "libimobiledevice", "sideloader"];
      if (!validIds.includes(id)) {
        return new Response("Unknown dependency", { status: 400, headers: cors });
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
              (stepId: FlashStepId, status: FlashStepStatus, detail: string) => {
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
      const request = (await req.json()) as Parameters<typeof iosBackend.createInstallPlan>[0];
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
              (stepId: IosInstallStepId, status: IosInstallStepStatus, detail?: string) => {
                const data = JSON.stringify({ stepId, status, detail });
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              },
            );
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`),
            );
          } catch (err) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`),
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
  },
});

console.log(`elizaOS Setup backend running at http://localhost:${PORT}`);
console.log("Run: adb devices   to verify your device is connected");
