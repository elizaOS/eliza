/**
 * Health Check - Edge Function
 *
 * Ultra-fast health check endpoint that runs at the edge.
 * Used by load balancers, monitoring tools, and uptime checks.
 *
 * PERFORMANCE: Edge runtime = ~5ms response vs ~100ms+ Node.js
 */

export const runtime = "edge";

export async function GET() {
  return Response.json(
    {
      status: "ok",
      timestamp: Date.now(),
      region: process.env.VERCEL_REGION || "unknown",
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
