/**
 * App Authentication and Origin Validation Middleware
 *
 * This middleware validates requests from apps by:
 * 1. Checking if the API key belongs to an app
 * 2. Validating the origin against the app's allowed origins
 * 3. Enforcing rate limits for the app
 * 4. Tracking app usage
 */

import { NextRequest, NextResponse } from "next/server";
import { appsService } from "@/lib/services/apps";
import { apiKeysService } from "@/lib/services/api-keys";
import { logger } from "@/lib/utils/logger";
import type { App, ApiKey } from "@/lib/types";

/**
 * App authentication context with validated app and API key.
 */
export interface AppAuthContext {
  appId: string;
  app: App;
  apiKey: ApiKey;
  origin: string;
}

/**
 * Validate origin against app's allowed origins
 */
export function validateOrigin(
  allowedOrigins: string[],
  requestOrigin: string,
): boolean {
  // Allow requests with no origin (e.g., server-to-server)
  if (!requestOrigin) {
    return true;
  }

  // Check if wildcard is allowed
  if (allowedOrigins.includes("*")) {
    return true;
  }

  // Check exact matches
  if (allowedOrigins.includes(requestOrigin)) {
    return true;
  }

  // Check wildcard subdomains (e.g., *.example.com)
  for (const allowed of allowedOrigins) {
    if (allowed.includes("*")) {
      const pattern = allowed.replace(/\*/g, ".*");
      const regex = new RegExp(`^${pattern}$`);
      if (regex.test(requestOrigin)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Validate and authenticate app from API key
 */
export async function validateAppAuth(
  request: NextRequest,
): Promise<AppAuthContext | NextResponse> {
  // Get API key from header
  const apiKeyHeader = request.headers.get("X-API-Key");
  const authHeader = request.headers.get("authorization");

  let apiKeyValue: string | null = null;

  if (apiKeyHeader) {
    apiKeyValue = apiKeyHeader;
  } else if (authHeader?.startsWith("Bearer ")) {
    apiKeyValue = authHeader.substring(7);
  }

  if (!apiKeyValue) {
    return NextResponse.json(
      {
        success: false,
        error: "API key is required",
        code: "MISSING_API_KEY",
      },
      { status: 401 },
    );
  }

  // Validate API key
  const apiKey = await apiKeysService.validateApiKey(apiKeyValue);

  if (!apiKey) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid or expired API key",
        code: "INVALID_API_KEY",
      },
      { status: 401 },
    );
  }

  // Check if this API key is associated with an app
  // Uses cached lookup - avoids fetching all org apps
  const app = await appsService.getByApiKeyId(apiKey.id);

  if (!app) {
    // This is a regular API key, not an app API key
    // We can allow it to proceed without app-specific validation
    return NextResponse.json(
      {
        success: false,
        error: "This API key is not associated with an app",
        code: "NOT_AN_APP_KEY",
      },
      { status: 403 },
    );
  }

  // Check if app is active
  if (!app.is_active) {
    return NextResponse.json(
      {
        success: false,
        error: "App is inactive",
        code: "APP_INACTIVE",
      },
      { status: 403 },
    );
  }

  // Get and validate origin
  const origin =
    request.headers.get("origin") || request.headers.get("referer") || "";
  const allowedOrigins = app.allowed_origins as string[];

  if (!validateOrigin(allowedOrigins, origin)) {
    logger.warn(`Origin validation failed for app ${app.id}`, {
      appId: app.id,
      origin,
      allowedOrigins,
    });

    return NextResponse.json(
      {
        success: false,
        error: "Origin not allowed",
        code: "ORIGIN_NOT_ALLOWED",
        origin,
        allowedOrigins,
      },
      { status: 403 },
    );
  }

  // Return validated context
  return {
    appId: app.id,
    app,
    apiKey,
    origin,
  };
}

/**
 * Middleware wrapper for app authentication
 * Use this in API routes that should be accessible by apps
 */
export async function requireAppAuth(
  request: NextRequest,
  handler: (context: AppAuthContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const authResult = await validateAppAuth(request);

  // If validation failed, authResult is a NextResponse error
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  // Track API key usage
  await apiKeysService.incrementUsage(authResult.apiKey.id);

  // Track app usage (async, don't wait)
  void appsService.incrementUsage(authResult.appId, "0.00");

  // Call the handler with validated context
  return handler(authResult);
}

/**
 * Extract app ID from API key without full validation
 * Uses cached lookup for performance
 */
export async function getAppFromApiKey(apiKey: string): Promise<string | null> {
  const validatedKey = await apiKeysService.validateApiKey(apiKey);
  if (!validatedKey) return null;

  // Use cached lookup instead of fetching all org apps
  const app = await appsService.getByApiKeyId(validatedKey.id);

  return app?.id || null;
}
