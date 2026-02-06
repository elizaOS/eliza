/**
 * Domain Status API
 *
 * Check the current status of a domain's DNS configuration.
 * Returns verification status, SSL status, and required DNS records.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { vercelDomainsService } from "@/lib/services/vercel-domains";
import { z } from "zod";

const StatusSchema = z.object({
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
 * POST /api/v1/apps/:id/domains/status
 * Check the DNS status of a domain
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
  const validation = StatusSchema.safeParse(body);

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

  const status = await vercelDomainsService.getDomainStatus(appId, domain);

  // Get DNS instructions based on domain type
  const isApex = vercelDomainsService.isApexDomain(domain);
  const dnsInstructions = vercelDomainsService.getDnsInstructions(
    domain,
    isApex,
  );

  // If verified, sync status to database
  if (status.verified) {
    await vercelDomainsService.syncDomainStatus(appId);
  }

  return NextResponse.json({
    success: true,
    ...status,
    isApexDomain: isApex,
    dnsInstructions,
  });
}
