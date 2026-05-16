import { serve } from "bun";
import { createPlatformBackend } from "./src/backend/index";
import type { InstallerStepId, WritePlan } from "./src/backend/types";

const backend = createPlatformBackend();
const PORT = 3742;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/drives" && req.method === "GET") {
      const drives = await backend.listRemovableDrives();
      return Response.json(drives, { headers: corsHeaders });
    }

    if (url.pathname === "/images" && req.method === "GET") {
      const images = await backend.listImages();
      return Response.json(images, { headers: corsHeaders });
    }

    if (url.pathname === "/plan" && req.method === "POST") {
      const request = (await req.json()) as Parameters<
        typeof backend.createWritePlan
      >[0];
      const plan = await backend.createWritePlan(request);
      return Response.json(plan, { headers: corsHeaders });
    }

    if (url.pathname === "/execute" && req.method === "POST") {
      if (!backend.executeWritePlan) {
        return Response.json(
          { error: "executeWritePlan not implemented on this platform" },
          { status: 501, headers: corsHeaders },
        );
      }

      const { plan } = (await req.json()) as { plan: WritePlan };
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          try {
            await backend.executeWritePlan!(
              plan,
              (stepId: InstallerStepId, progress: number) => {
                const data = JSON.stringify({ stepId, progress });
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              },
            );
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`),
            );
          } catch (err) {
            const errData = JSON.stringify({ error: String(err) });
            controller.enqueue(encoder.encode(`data: ${errData}\n\n`));
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
});

console.log(`USB installer backend running at http://localhost:${PORT}`);
