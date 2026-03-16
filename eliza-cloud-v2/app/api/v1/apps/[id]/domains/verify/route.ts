/**
 * Domain Verify API
 *
 * Trigger manual verification of a domain's ownership.
 * This calls Vercel's API to check if DNS records are properly configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { vercelDomainsService } from "@/lib/services/vercel-domains";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

const VerifySchema = z.object({
  domain: z
    .string()
    .min(4)
    .max(253)
    .transform((d) => d.toLowerCase().trim()),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/v1/apps/:id/domains/verify
 * Verify domain ownership
 */
export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const user = await requireAuthWithOrg();
  const { id: appId } = await params;

  const app = await appsService.getById(appId);
  if (!app || app.organization_id !== user.organization_id) {
    return NextResponse.json(
      { success: false, error: "App not found" },
      { status: 404 },
    );
  }

  const body = await request.json();
  const validation = VerifySchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
      { success: false, error: "Invalid domain format" },
      { status: 400 },
    );
  }

  const { domain } = validation.data;

  // Check if Vercel is configured
  if (!process.env.VERCEL_TOKEN || !process.env.VERCEL_TEAM_ID) {
    return NextResponse.json(
      {
        success: false,
        error: "Domain management is not configured",
      },
      { status: 503 },
    );
  }

  logger.info("[Domains API] Verifying domain", {
    appId,
    domain,
    userId: user.id,
  });

  const result = await vercelDomainsService.verifyDomain(appId, domain);

  // If verified, sync the status to database
  if (result.verified) {
    await vercelDomainsService.syncDomainStatus(appId);
  }

  // Get updated status regardless
  const status = await vercelDomainsService.getDomainStatus(appId, domain);
  const isApex = vercelDomainsService.isApexDomain(domain);
  const dnsInstructions = vercelDomainsService.getDnsInstructions(
    domain,
    isApex,
  );

  return NextResponse.json({
    success: true,
    verified: result.verified,
    status: {
      ...status,
      isApexDomain: isApex,
      dnsInstructions,
    },
  });
}
