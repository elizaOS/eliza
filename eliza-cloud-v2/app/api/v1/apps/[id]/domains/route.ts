/**
 * Domain Management API
 *
 * Manages custom domains for apps:
 * - GET: List all domains for an app
 * - POST: Add a custom domain
 * - DELETE: Remove a custom domain
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { vercelDomainsService } from "@/lib/services/vercel-domains";
import { aiAppBuilder } from "@/lib/services/ai-app-builder";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

/**
 * Check if a domain contains potentially dangerous punycode/homograph patterns.
 * This prevents attacks where domains like "аpple.com" (using Cyrillic 'а')
 * are used to impersonate legitimate domains.
 */
function isPotentialHomographDomain(domain: string): boolean {
  // Check if domain contains punycode (xn-- prefix)
  if (domain.includes("xn--")) {
    return true;
  }

  // Check for non-ASCII characters (could be homoglyphs)
  if (/[^\x00-\x7F]/.test(domain)) {
    return true;
  }

  // Check for suspicious mixed scripts that could be homograph attacks
  // Common homograph characters: Cyrillic а(U+0430) looks like Latin a,
  // Greek ο(U+03BF) looks like Latin o, etc.
  const suspiciousPatterns = [
    /[\u0430\u0435\u043E\u0440\u0441\u0443\u0445]/, // Common Cyrillic lookalikes
    /[\u03B1\u03B5\u03BF\u03C1]/, // Common Greek lookalikes
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(domain)) {
      return true;
    }
  }

  return false;
}

const AddDomainSchema = z.object({
  domain: z
    .string()
    .min(4, "Domain must be at least 4 characters")
    .max(253, "Domain must not exceed 253 characters")
    .regex(
      /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
      "Invalid domain format. Only ASCII characters are allowed.",
    )
    .refine(
      (domain) => !isPotentialHomographDomain(domain),
      "Domain contains suspicious characters that may be used for impersonation. Only standard ASCII domains are allowed.",
    )
    .transform((d) => d.toLowerCase().trim()),
});

const RemoveDomainSchema = z.object({
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
 * GET /api/v1/apps/:id/domains
 * List all domains for an app
 */
export async function GET(
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

  const domains = await vercelDomainsService.getDomainsForApp(appId);

  let sandboxUrl: string | null = null;
  if (domains.length === 0) {
    const sessions = await aiAppBuilder.listSessions(user.id, {
      appId,
      limit: 1,
      includeInactive: true,
    });
    if (sessions.length > 0 && sessions[0].sandbox_url) {
      sandboxUrl = sessions[0].sandbox_url;
    }
  }

  return NextResponse.json({
    success: true,
    domains,
    sandboxUrl,
  });
}

/**
 * POST /api/v1/apps/:id/domains
 * Add a custom domain to an app
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
  const validation = AddDomainSchema.safeParse(body);

  if (!validation.success) {
    const firstError = validation.error.issues[0];
    return NextResponse.json(
      { success: false, error: firstError?.message || "Invalid domain format" },
      { status: 400 },
    );
  }

  const { domain } = validation.data;

  logger.info("[Domains API] Adding domain", {
    appId,
    domain,
    userId: user.id,
  });

  // Check if Vercel is configured
  if (!process.env.VERCEL_TOKEN || !process.env.VERCEL_TEAM_ID) {
    return NextResponse.json(
      {
        success: false,
        error: "Domain management is not configured. Please contact support.",
      },
      { status: 503 },
    );
  }

  const result = await vercelDomainsService.addDomain(appId, domain);

  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error || "Failed to add domain" },
      { status: 400 },
    );
  }

  const isApex = vercelDomainsService.isApexDomain(domain);
  const dnsInstructions = vercelDomainsService.getDnsInstructions(
    domain,
    isApex,
  );

  return NextResponse.json({
    success: true,
    domain: result.domain,
    verified: result.verified,
    verificationRecords: result.verificationRecords,
    dnsInstructions,
    isApexDomain: isApex,
  });
}

/**
 * DELETE /api/v1/apps/:id/domains
 * Remove a custom domain from an app
 */
export async function DELETE(
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
  const validation = RemoveDomainSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
      { success: false, error: "Invalid domain format" },
      { status: 400 },
    );
  }

  const { domain } = validation.data;

  logger.info("[Domains API] Removing domain", {
    appId,
    domain,
    userId: user.id,
  });

  const result = await vercelDomainsService.removeDomain(appId, domain);

  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error || "Failed to remove domain" },
      { status: 400 },
    );
  }

  return NextResponse.json({
    success: true,
    message: "Domain removed successfully",
  });
}
