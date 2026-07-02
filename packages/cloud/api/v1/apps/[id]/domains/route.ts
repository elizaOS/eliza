/**
 * GET    /api/v1/apps/:id/domains - list managed-domain attachments for the app
 * POST   /api/v1/apps/:id/domains - attach an externally-owned domain
 *                                   (user owns it elsewhere; we generate
 *                                   a verification TXT record they must add)
 * DELETE /api/v1/apps/:id/domains - detach a managed domain from the app
 *
 * For BUYING a new cloudflare-registered domain, see /domains/buy.
 */

import crypto from "node:crypto";
import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { appDomainsCompat } from "@/lib/services/app-domains-compat";
import { managedDomainsService } from "@/lib/services/managed-domains";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { loadOwnedApp } from "./guards";
import { domainBodySchema as DomainSchema } from "./schemas";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const ctx = await loadOwnedApp(c);
    if ("error" in ctx)
      return c.json({ success: false, error: ctx.error }, ctx.status);

    const domains = await managedDomainsService.listForApp(
      ctx.user.organization_id,
      ctx.appId,
    );
    return c.json({
      success: true,
      domains: domains.map((d) => ({
        id: d.id,
        domain: d.domain,
        registrar: d.registrar,
        status: d.status,
        verified: d.verified,
        sslStatus: d.sslStatus,
        expiresAt: d.expiresAt,
        cloudflareZoneId: d.cloudflareZoneId,
        verificationToken:
          d.registrar === "external" && !d.verified
            ? d.verificationToken
            : null,
      })),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const ctx = await loadOwnedApp(c);
    if ("error" in ctx)
      return c.json({ success: false, error: ctx.error }, ctx.status);

    const parsed = DomainSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "invalid input",
        },
        400,
      );
    }
    const { domain } = parsed.data;

    // Block only when another org holds the domain's EXCLUSIVE slot — a verified
    // or cloudflare row. A mere unverified pending row from another org is NOT
    // exclusive (getDomainByName returns null for it), so it can no longer squat
    // the global namespace and deny a legitimate attach (#11024).
    const exclusive = await managedDomainsService.getDomainByName(domain);
    if (exclusive && exclusive.organizationId !== ctx.user.organization_id) {
      return c.json(
        {
          success: false,
          error: "Domain is already registered to a different organization",
        },
        409,
      );
    }

    // Reuse the caller's OWN row (verified or pending) instead of minting a dup.
    const existing = await managedDomainsService.getOwnDomainRow(
      ctx.user.organization_id,
      domain,
    );
    if (existing) {
      await managedDomainsService.assignToResource(existing.id, {
        type: "app",
        id: ctx.appId,
      });
      await appDomainsCompat.setCustomDomain({
        appId: ctx.appId,
        domain,
        verified: existing.verified,
      });
      return c.json({
        success: true,
        domain,
        id: existing.id,
        registrar: existing.registrar,
        verified: existing.verified,
        verificationRecord:
          existing.registrar === "external" && !existing.verified
            ? buildVerificationRecord(domain, existing.verificationToken ?? "")
            : null,
      });
    }

    const verificationToken = `eliza-verify-${crypto.randomBytes(16).toString("hex")}`;
    const row = await managedDomainsService.insertExternalDomain({
      organizationId: ctx.user.organization_id,
      domain,
      verificationToken,
    });
    await managedDomainsService.assignToResource(row.id, {
      type: "app",
      id: ctx.appId,
    });
    await appDomainsCompat.setCustomDomain({
      appId: ctx.appId,
      domain,
      verified: false,
    });

    return c.json(
      {
        success: true,
        domain,
        id: row.id,
        registrar: "external",
        verified: false,
        verificationRecord: buildVerificationRecord(domain, verificationToken),
        next: "Add the TXT record above to your DNS, then call POST /domains/verify with the same domain.",
      },
      201,
    );
  } catch (error) {
    logger.error("[Domains POST] external attach failed", { error });
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const ctx = await loadOwnedApp(c);
    if ("error" in ctx)
      return c.json({ success: false, error: ctx.error }, ctx.status);

    const parsed = DomainSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "invalid input",
        },
        400,
      );
    }
    const { domain } = parsed.data;

    // getOwnDomainRow is already scoped to the caller's organization.
    const md = await managedDomainsService.getOwnDomainRow(
      ctx.user.organization_id,
      domain,
    );
    if (!md || md.appId !== ctx.appId) {
      return c.json(
        { success: false, error: "Domain not attached to this app" },
        404,
      );
    }

    await managedDomainsService.unassignFromResource(md.id);
    try {
      const remainingDomains = (
        await managedDomainsService.listForApp(
          ctx.user.organization_id,
          ctx.appId,
        )
      ).filter((candidate) => candidate.id !== md.id);
      const primaryDomain = remainingDomains.find(
        (candidate) => candidate.verified && candidate.status === "active",
      );
      if (primaryDomain) {
        await appDomainsCompat.setCustomDomain({
          appId: ctx.appId,
          domain: primaryDomain.domain,
          verified: primaryDomain.verified,
        });
      } else {
        await appDomainsCompat.clearCustomDomain(ctx.appId);
      }
    } catch (error) {
      await appDomainsCompat.clearCustomDomain(ctx.appId);
      logger.warn(
        "[Domains DELETE] detached domain but failed to refresh compatibility domain",
        {
          appId: ctx.appId,
          domain,
          error: extractErrorMessage(error),
        },
      );
    }
    logger.info("[Domains DELETE] detached domain", {
      appId: ctx.appId,
      domain,
      registrar: md.registrar,
    });
    return c.json({
      success: true,
      domain,
      note:
        md.registrar === "cloudflare"
          ? "Detached from app. The cloudflare registration itself remains active until expiration."
          : "Detached from app. External registration unchanged.",
    });
  } catch (error) {
    logger.error("[Domains DELETE] failed", {
      error: extractErrorMessage(error),
    });
    return failureResponse(c, error);
  }
});

function buildVerificationRecord(domain: string, token: string) {
  return {
    type: "TXT" as const,
    name: `_eliza-cloud-verify.${domain}`,
    value: token,
    instructions: `Add a TXT record with name '_eliza-cloud-verify.${domain}' and value '${token}' to your DNS provider, then call /verify.`,
  };
}

export default app;
