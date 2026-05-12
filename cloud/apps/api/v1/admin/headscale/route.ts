/**
 * Admin Headscale Status API
 *
 * GET /api/v1/admin/headscale — Get headscale server status, list all VPN
 *     nodes with IPs and online status.
 *
 * Requires super_admin role.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface HeadscaleNode {
  id: string;
  machineKey?: string;
  nodeKey?: string;
  name: string;
  givenName: string;
  user: { id: string; name: string };
  ipAddresses: string[];
  online: boolean;
  lastSeen: string;
  expiry: string;
  createdAt: string;
  forcedTags?: string[];
}

interface HeadscaleNodesResponse {
  nodes?: HeadscaleNode[];
  machines?: HeadscaleNode[];
}

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const { role } = await requireAdmin(c);
    if (role !== "super_admin") {
      return c.json({ success: false, error: "Super admin access required" }, 403);
    }

    const HEADSCALE_API_URL =
      (c.env.HEADSCALE_API_URL as string | undefined) || "http://localhost:8081";
    const HEADSCALE_API_KEY = (c.env.HEADSCALE_API_KEY as string | undefined) || "";
    const HEADSCALE_USER = (c.env.HEADSCALE_USER as string | undefined) || "agent";

    if (!HEADSCALE_API_KEY) {
      return c.json(
        {
          success: false,
          error: "Headscale not configured: HEADSCALE_API_KEY environment variable is missing",
        },
        503,
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${HEADSCALE_API_KEY}`,
      Accept: "application/json",
    };

    let nodesResponse = await fetch(`${HEADSCALE_API_URL}/api/v1/node`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!nodesResponse.ok && nodesResponse.status === 404) {
      nodesResponse = await fetch(`${HEADSCALE_API_URL}/api/v1/machine`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    }

    if (!nodesResponse.ok) {
      const errText = await nodesResponse.text().catch(() => "");
      logger.error("[Admin Headscale] API request failed", {
        status: nodesResponse.status,
        body: errText.slice(0, 500),
      });
      return c.json(
        {
          success: false,
          error: `Headscale API error: ${nodesResponse.status} ${nodesResponse.statusText}`,
        },
        502,
      );
    }

    const nodesData = (await nodesResponse.json()) as HeadscaleNodesResponse;
    const machines: HeadscaleNode[] = nodesData.nodes || nodesData.machines || [];

    const filteredMachines = HEADSCALE_USER
      ? machines.filter((m) => m.user?.name === HEADSCALE_USER || !m.user?.name)
      : machines;

    const vpnNodes = filteredMachines.map((m) => ({
      id: m.id,
      name: m.name,
      givenName: m.givenName,
      user: m.user?.name,
      ipAddresses: m.ipAddresses,
      online: m.online,
      lastSeen: m.lastSeen,
      expiry: m.expiry,
      createdAt: m.createdAt,
      tags: m.forcedTags || [],
    }));

    const onlineCount = vpnNodes.filter((n) => n.online).length;

    return c.json({
      success: true,
      data: {
        serverConfigured: true,
        user: HEADSCALE_USER,
        vpnNodes,
        summary: {
          total: vpnNodes.length,
          online: onlineCount,
          offline: vpnNodes.length - onlineCount,
        },
        queriedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error("[Admin Headscale] Failed to fetch status", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof TypeError && error.message.includes("fetch")) {
      return c.json(
        {
          success: false,
          error: "Cannot reach headscale server",
        },
        502,
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
