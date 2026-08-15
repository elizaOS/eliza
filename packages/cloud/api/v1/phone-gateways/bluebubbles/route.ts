/**
 * Authenticated BlueBubbles gateway registration and status API.
 * Registration binds one Mac/iPhone bridge to trusted-administrator
 * sender-owned Cloud identity routing or an owner-scoped legacy fixed-agent
 * target and returns the relay credential exactly once.
 */

import { Hono } from "hono";
import { z } from "zod";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { adminService } from "@/lib/services/admin";
import {
  createBlueBubblesGatewayRegistration,
  listBlueBubblesGateways,
} from "@/lib/services/phone-gateway-devices";
import { validatePhoneForAPI } from "@/lib/utils/phone-normalization";
import type { AppEnv } from "@/types/cloud-worker-env";

const registerSchema = z.object({
  routingMode: z.enum(["sender-owned", "fixed-agent"]).default("sender-owned"),
  agentId: z.string().uuid().nullable().optional(),
  phoneNumber: z.string().trim().min(1).max(32),
  friendlyName: z.string().trim().min(1).max(120).optional(),
});

const app = new Hono<AppEnv>();
const CONNECTED_WINDOW_MS = 5 * 60 * 1000;

function gatewayStatus(
  lastSeenAt: Date | null,
): "registered" | "connected" | "offline" {
  if (!lastSeenAt) return "registered";
  return Date.now() - lastSeenAt.getTime() <= CONNECTED_WINDOW_MS
    ? "connected"
    : "offline";
}

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const gateways = await listBlueBubblesGateways(
      user.organization_id,
      user.id,
    );
    return c.json({
      success: true,
      data: {
        gateways: gateways.map((gateway) => ({
          id: gateway.id,
          bridgeId: gateway.bridgeId,
          phoneNumber: gateway.phoneNumber,
          friendlyName: gateway.friendlyName,
          routingMode: gateway.routingMode,
          agentId: gateway.agentId,
          userId: gateway.userId,
          lastSeenAt: gateway.lastSeenAt?.toISOString() ?? null,
          status: gatewayStatus(gateway.lastSeenAt),
        })),
      },
    });
  } catch (error) {
    // error-policy:J1 the authenticated HTTP boundary translates service failures.
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawBody = await c.req.json().catch(() => {
      // error-policy:J3 malformed request JSON is represented as invalid input.
      return null;
    });
    const parsed = registerSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid BlueBubbles gateway registration",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const phone = validatePhoneForAPI(parsed.data.phoneNumber);
    if (!phone.valid) {
      return c.json({ success: false, error: phone.error }, 400);
    }

    if (parsed.data.routingMode === "sender-owned") {
      const admin = await adminService.getAdminStatusForUser(user);
      if (!admin.isAdmin) {
        return c.json(
          {
            success: false,
            error:
              "Sender-owned BlueBubbles gateways require a trusted service administrator",
          },
          403,
        );
      }
    }

    let agentId: string | null = null;
    if (parsed.data.routingMode === "fixed-agent") {
      if (!parsed.data.agentId) {
        return c.json(
          {
            success: false,
            error: "agentId is required for fixed-agent routing",
          },
          400,
        );
      }
      const agent = await agentSandboxesRepository.findByIdAndOrg(
        parsed.data.agentId,
        user.organization_id,
      );
      if (!agent || agent.user_id !== user.id) {
        return c.json({ success: false, error: "Agent not found" }, 404);
      }
      agentId = agent.id;
    }

    const registration = await createBlueBubblesGatewayRegistration({
      organizationId: user.organization_id,
      userId: user.id,
      routingMode: parsed.data.routingMode,
      agentId,
      phoneNumber: phone.normalized,
      friendlyName: parsed.data.friendlyName,
    });
    const webhookUrl = new URL(
      `/api/webhooks/bluebubbles/${registration.bridgeId}`,
      c.req.url,
    ).toString();

    c.header("Cache-Control", "no-store");
    return c.json(
      {
        success: true,
        data: {
          id: registration.id,
          bridgeId: registration.bridgeId,
          phoneNumber: registration.phoneNumber,
          routingMode: registration.routingMode,
          agentId: registration.agentId,
          webhookUrl,
          token: registration.token,
          relayEnvironment: {
            ELIZA_CLOUD_BLUEBUBBLES_URL: webhookUrl,
            BLUEBUBBLES_BRIDGE_ID: registration.bridgeId,
            BLUEBUBBLES_GATEWAY_TOKEN: registration.token,
            BLUEBUBBLES_GATEWAY_PHONE_NUMBER: registration.phoneNumber,
          },
        },
      },
      201,
    );
  } catch (error) {
    // error-policy:J1 the authenticated HTTP boundary translates service failures.
    return failureResponse(c, error);
  }
});

export default app;
