/** Revokes an authenticated user's BlueBubbles gateway credential and routing binding. */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { revokeBlueBubblesGateway } from "@/lib/services/phone-gateway-devices";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const gatewayId = c.req.param("id");
    if (!gatewayId) {
      return c.json({ success: false, error: "Gateway id is required" }, 400);
    }
    const revoked = await revokeBlueBubblesGateway(
      user.organization_id,
      user.id,
      gatewayId,
    );
    if (!revoked) {
      return c.json({ success: false, error: "Gateway not found" }, 404);
    }
    return c.json({ success: true });
  } catch (error) {
    // error-policy:J1 the authenticated HTTP boundary translates service failures.
    return failureResponse(c, error);
  }
});

export default app;
