/**
 * POST /api/v1/apps/:id/domains/verify
 *
 * For external-registrar domains: do a real DNS TXT lookup at
 * `_eliza-cloud-verify.<domain>`. If the record matches the stored
 * verification token, mark the domain verified.
 *
 * For cloudflare-registrar domains: verification happens automatically
 * at registration time; this just returns the current verified state.
 */

import { promises as dns } from "node:dns";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { managedDomainsService } from "@/lib/services/managed-domains";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { loadOwnedApp } from "../guards";
import { domainBodySchema as VerifySchema } from "../schemas";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const ctx = await loadOwnedApp(c);
    if ("error" in ctx)
      return c.json({ success: false, error: ctx.error }, ctx.status);
    const { user, appId } = ctx;

    const parsed = VerifySchema.safeParse(await c.req.json());
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

    if (md.registrar === "cloudflare") {
      return c.json({
        success: true,
        domain: md.domain,
        verified: md.verified,
        registrar: md.registrar,
        note: "cloudflare-registered domains are verified at registration time",
      });
    }

    if (!md.verificationToken) {
      return c.json(
        {
          success: false,
          error: "verification token missing — re-attach the domain",
        },
        500,
      );
    }

    const recordName = `_eliza-cloud-verify.${md.domain}`;
    let records: string[][];
    try {
      records = await dns.resolveTxt(recordName);
    } catch (err) {
      logger.info("[Domains Verify] TXT lookup failed", {
        domain: md.domain,
        recordName,
        error: extractErrorMessage(err),
      });
      await managedDomainsService.syncStatus({
        domainId: md.id,
        verified: false,
        healthCheckError: `TXT lookup at ${recordName} failed`,
      });
      return c.json({
        success: true,
        domain: md.domain,
        verified: false,
        error: `TXT record not found at ${recordName} — add it then retry`,
      });
    }

    const found = records
      .flat()
      .some((value) => value === md.verificationToken);
    const updated = await managedDomainsService.syncStatus({
      domainId: md.id,
      verified: found,
      status: found ? "active" : md.status,
      healthCheckError: found
        ? null
        : `TXT record at ${recordName} did not match expected token`,
    });

    return c.json({
      success: true,
      domain: md.domain,
      verified: updated.verified,
      registrar: md.registrar,
      verifiedAt: updated.verifiedAt,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
