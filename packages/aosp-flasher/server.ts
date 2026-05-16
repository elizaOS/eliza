import { serve } from "bun";
import { AdbFlasherBackend } from "./src/backend/adb-backend";
import type { FlashPlan, FlashStepId, FlashStepStatus } from "./src/backend/types";

const backend = new AdbFlasherBackend();
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

    return new Response("Not found", { status: 404, headers: cors });
  },
});

console.log(`AOSP Flasher backend running at http://localhost:${PORT}`);
console.log("Run: adb devices   to verify your device is connected");
