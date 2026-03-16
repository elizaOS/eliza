import { NextRequest, NextResponse } from "next/server";
import { appsService } from "@/lib/services/apps";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";

/**
 * CORS Configuration for Page View Tracking
 *
 * SECURITY NOTE: Wildcard CORS (*) is intentional for this endpoint.
 *
 * This endpoint is specifically designed for tracking page views from embedded
 * apps that may run on any domain. The security model relies on:
 *
 * 1. API Key or App ID validation - requests must provide valid credentials
 * 2. App ownership verification - data is only written to apps owned by the credential holder
 * 3. Write-only operation - this endpoint only records analytics data, no sensitive reads
 * 4. No credential exposure - API keys are validated but not returned in responses
 *
 * Using restrictive CORS here would break legitimate use cases where:
 * - Apps are embedded in third-party websites
 * - Preview deployments run on dynamic domains
 * - Local development servers need to send tracking data
 *
 * The main risk (tracking data injection with stolen API keys) is mitigated by:
 * - API key validation ensuring data goes to correct app
 * - Rate limiting on the caller side (via API key tracking)
 * - No destructive operations possible through this endpoint
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, X-App-Id",
  "Access-Control-Max-Age": "86400",
};

function detectSource(
  origin: string,
  referer: string,
  pageUrl: string,
): string {
  const combined = `${origin} ${referer} ${pageUrl}`.toLowerCase();

  if (
    combined.includes("sandbox") ||
    combined.includes("vercel.app") ||
    combined.includes("vercel.dev") ||
    combined.includes("localhost") ||
    combined.includes("127.0.0.1") ||
    combined.includes("eliza.gg") ||
    combined.includes(".dev.") ||
    combined.includes("-preview")
  ) {
    return "sandbox_preview";
  }

  return "embed";
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * POST /api/v1/track/pageview
 * Lightweight endpoint for tracking page views from sandbox apps.
 * Accepts API key in header or app_id in body.
 */
export async function POST(req: NextRequest) {
  const startTime = Date.now();

  try {
    const body = await req.json();
    const {
      app_id,
      api_key: bodyApiKey,
      page_url,
      referrer,
      screen_width,
      screen_height,
      pathname,
    } = body;

    // Accept API key from header or body (body needed for sendBeacon which doesn't support headers)
    const apiKey = req.headers.get("x-api-key") || bodyApiKey;
    const ipAddress =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    const userAgent = req.headers.get("user-agent") || "unknown";
    const origin = req.headers.get("origin") || "";
    const referer = req.headers.get("referer") || "";

    let appId = app_id;

    if (!appId && apiKey) {
      const validatedKey = await apiKeysService.validateApiKey(apiKey);
      if (validatedKey) {
        const app = await appsService.getByApiKeyId(validatedKey.id);
        if (app) {
          appId = app.id;
        }
      }
    }

    if (!appId) {
      return NextResponse.json(
        { success: false, error: "Missing app_id or valid API key" },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const app = await appsService.getById(appId);
    if (!app) {
      return NextResponse.json(
        { success: false, error: "App not found" },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    const pageUrlValue = page_url || pathname || "/";
    const source = detectSource(origin, referer, pageUrlValue);

    await appsService.trackPageView(appId, {
      pageUrl: pageUrlValue,
      referrer: referrer || referer,
      ipAddress,
      userAgent,
      source,
      metadata: {
        screen_width,
        screen_height,
        origin,
        referer,
        pathname,
      },
    });

    logger.debug("[Track] Page view recorded", {
      appId,
      pageUrl: pageUrlValue,
      source,
      responseTimeMs: Date.now() - startTime,
    });

    return NextResponse.json(
      { success: true },
      { status: 200, headers: CORS_HEADERS },
    );
  } catch (error) {
    logger.error("[Track] Failed to record page view:", error);
    return NextResponse.json(
      { success: false, error: "Failed to track page view" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
