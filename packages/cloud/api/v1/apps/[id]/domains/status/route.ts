/**
 * POST /api/v1/apps/:id/domains/status
 *
 * Read current verification + SSL status of a domain attached to the app.
 * Live for cloudflare-registered; stored values for external.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { cloudflareRegistrarService } from "@/lib/services/cloudflare-registrar";
import { managedDomainsService } from "@/lib/services/managed-domains";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { loadOwnedApp } from "../guards";
import { domainBodySchema as StatusSchema } from "../schemas";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const ctx = await loadOwnedApp(c);
    if ("error" in ctx)
      return c.json({ success: false, error: ctx.error }, ctx.status);
    const { user, appId } = ctx;

    const parsed = StatusSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "invalid input",
        },
        400,
      );
    }

    // getOwnDomainRow is already scoped to the caller's organization.
    const md = await managedDomainsService.getOwnDomainRow(
      user.organization_id,
      parsed.data.domain,
    );
    if (!md || md.appId !== appId) {
      return c.json(
        { success: false, error: "Domain not attached to this app" },
        404,
      );
    }

    let live: {
      status: string;
      completedAt: string | null;
      failureReason: string | null;
    } | null = null;
    if (md.registrar === "cloudflare") {
      try {
        live = await cloudflareRegistrarService.getRegistrationStatus(
          md.domain,
        );
      } catch (err) {
        logger.warn(
          "[Domains Status] cloudflare status fetch failed; returning stored state",
          {
            appId,
            domain: md.domain,
            error: extractErrorMessage(err),
          },
        );
      }
    }

    return c.json({
      success: true,
      domain: md.domain,
      registrar: md.registrar,
      status: live?.status ?? md.status,
      verified: md.verified,
      sslStatus: md.sslStatus,
      expiresAt: md.expiresAt,
      live,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
