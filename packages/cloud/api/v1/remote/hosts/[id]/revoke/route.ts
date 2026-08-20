/** Revokes one account-owned remote host registration. */
import { Hono } from "hono";
import { remoteHostsRepository } from "@/db/repositories/remote-hosts";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const hostId = c.req.param("id");
    if (!hostId)
      return c.json({ success: false, error: "Host id required" }, 400);
    const host = await remoteHostsRepository.revoke(
      hostId,
      user.organization_id,
      user.id,
    );
    if (!host) {
      return c.json({ success: false, error: "Host not found" }, 404);
    }
    return c.json({
      success: true,
      data: { id: host.id, status: host.status, revokedAt: host.revoked_at },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
