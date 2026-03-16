/**
 * Internal Token Issuance Endpoint
 *
 * Exchanges the gateway bootstrap secret for a JWT.
 * Used by internal services (Discord gateway) to obtain authentication tokens.
 *
 * POST /api/internal/auth/token
 * Header: X-Gateway-Secret: {GATEWAY_BOOTSTRAP_SECRET}
 * Body: { pod_name: string, service?: string }
 * Returns: { access_token, token_type, expires_in }
 */

import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isJWKSConfigured } from "@/lib/auth/jwks";
import { signInternalToken, TOKEN_LIFETIME_SECONDS } from "@/lib/auth/jwt-internal";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

const GATEWAY_BOOTSTRAP_SECRET = process.env.GATEWAY_BOOTSTRAP_SECRET;

// Log configuration issues once at startup
if (!GATEWAY_BOOTSTRAP_SECRET && process.env.NODE_ENV !== "test") {
  console.error(
    "[CRITICAL] GATEWAY_BOOTSTRAP_SECRET not configured - token issuance will fail",
  );
}

/**
 * Request body schema for token issuance.
 */
const TokenRequestSchema = z.object({
  pod_name: z.string().min(1, "pod_name is required"),
  service: z.string().optional(),
});

/**
 * Validate the gateway bootstrap secret.
 * Uses constant-time comparison to prevent timing attacks.
 */
function validateBootstrapSecret(request: NextRequest): boolean {
  if (!GATEWAY_BOOTSTRAP_SECRET) {
    return false;
  }

  const providedSecret = request.headers.get("X-Gateway-Secret");
  if (!providedSecret) {
    return false;
  }

  const expectedBuffer = Buffer.from(GATEWAY_BOOTSTRAP_SECRET, "utf8");
  const providedBuffer = Buffer.from(providedSecret, "utf8");

  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

export async function POST(request: NextRequest) {
  // Validate bootstrap secret
  if (!validateBootstrapSecret(request)) {
    logger.warn("[Token Issuance] Invalid or missing bootstrap secret");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify JWKS is configured
  if (!isJWKSConfigured()) {
    logger.error("[Token Issuance] JWKS not configured");
    return NextResponse.json(
      { error: "Service unavailable - JWKS not configured" },
      { status: 503 },
    );
  }

  // Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = TokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.issues.map((e) => e.message).join(", ") },
      { status: 400 },
    );
  }

  const { pod_name, service } = parsed.data;

  // Sign and return the token
  const token = await signInternalToken({
    subject: pod_name,
    service: service ?? "discord-gateway",
  });

  logger.info("[Token Issuance] Token issued", {
    subject: pod_name,
    service: service ?? "discord-gateway",
    expiresIn: TOKEN_LIFETIME_SECONDS,
  });

  return NextResponse.json(token);
}
