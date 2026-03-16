/**
 * GET /api/v1/agent-bridge/:containerId (WebSocket upgrade)
 *
 * WebSocket bridge between a milaidy client and a cloud-hosted agent container.
 *
 * Protocol: JSON-RPC 2.0 over WebSocket.
 *
 * The bridge proxies messages bidirectionally:
 *   Client (milaidy) <--WS--> Cloud Bridge <--HTTP/WS--> Agent Container
 *
 * Authentication: Bearer token via query param `?token=eliza_xxxxx`
 * (WebSocket API doesn't support Authorization headers in all browsers).
 *
 * Note: Next.js App Router does not natively support WebSocket upgrades.
 * This route serves as a documentation placeholder and the actual WS
 * endpoint runs via a separate Node server or Vercel Edge function.
 * For Vercel deployment, use Edge Runtime with WebSocket support.
 *
 * In production, this bridge runs as a standalone service or via the
 * Vercel WebSocket adapter. The route handler below implements the
 * fallback HTTP polling transport for environments without WS support.
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { apiKeysService } from "@/lib/services/api-keys";
import { getContainer } from "@/lib/services/containers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — Long-poll transport fallback.
 *
 * When WebSocket is not available, clients can poll this endpoint
 * to receive pending messages from the agent.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ containerId: string }> },
) {
  const { containerId } = await params;

  // Authenticate via query token
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json(
      { success: false, error: "Missing token query parameter" },
      { status: 401 },
    );
  }

  const apiKey = await apiKeysService.validateApiKey(token);
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: "Invalid API key" },
      { status: 401 },
    );
  }

  // Verify container ownership
  const container = await getContainer(containerId, apiKey.organization_id);
  if (!container) {
    return NextResponse.json(
      { success: false, error: "Container not found" },
      { status: 404 },
    );
  }

  if (container.status !== "running" || !container.load_balancer_url) {
    return NextResponse.json(
      {
        success: false,
        error: `Container not available (status: ${container.status})`,
      },
      { status: 503 },
    );
  }

  // Return bridge connection info
  return NextResponse.json({
    success: true,
    data: {
      containerId,
      containerUrl: container.load_balancer_url,
      status: container.status,
      transport: "polling",
      bridgePort: 18790,
      message:
        "WebSocket transport preferred. Connect to wss://www.elizacloud.ai/api/v1/agent-bridge/" +
        containerId +
        "?token=<key> for real-time bidirectional communication.",
    },
  });
}

/**
 * POST — Send a message to the agent via HTTP bridge.
 *
 * This is the polling-mode send path. For real-time, use WebSocket.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ containerId: string }> },
) {
  const { containerId } = await params;

  // Authenticate via query token or Authorization header
  const token =
    request.nextUrl.searchParams.get("token") ??
    request.headers.get("Authorization")?.replace("Bearer ", "");

  if (!token) {
    return NextResponse.json(
      { success: false, error: "Missing authentication" },
      { status: 401 },
    );
  }

  const apiKey = await apiKeysService.validateApiKey(token);
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: "Invalid API key" },
      { status: 401 },
    );
  }

  // Verify container ownership
  const container = await getContainer(containerId, apiKey.organization_id);
  if (!container) {
    return NextResponse.json(
      { success: false, error: "Container not found" },
      { status: 404 },
    );
  }

  if (container.status !== "running" || !container.load_balancer_url) {
    return NextResponse.json(
      {
        success: false,
        error: `Container not available (status: ${container.status})`,
      },
      { status: 503 },
    );
  }

  // Forward the JSON-RPC message to the agent container's bridge port
  const body = await request.json();
  const agentBridgeUrl = `${container.load_balancer_url.replace(/:\d+$/, "")}:18790/bridge`;

  logger.debug(`[AgentBridge] Forwarding message to ${agentBridgeUrl}`, {
    containerId,
    method: (body as { method?: string }).method,
  });

  const agentResponse = await fetch(agentBridgeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!agentResponse.ok) {
    const errorText = await agentResponse.text();
    logger.error(`[AgentBridge] Agent returned ${agentResponse.status}: ${errorText}`);
    return NextResponse.json(
      {
        success: false,
        error: `Agent bridge error: ${agentResponse.status}`,
      },
      { status: 502 },
    );
  }

  const result = await agentResponse.json();
  return NextResponse.json(result);
}
