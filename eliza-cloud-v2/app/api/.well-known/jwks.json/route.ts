/**
 * JWKS (JSON Web Key Set) Endpoint
 *
 * Exposes public keys for JWT verification at /.well-known/jwks.json
 * This follows the standard JWKS discovery pattern (RFC 7517).
 */

import { getJWKS, isJWKSConfigured } from "@/lib/auth/jwks";
import { NextResponse } from "next/server";

/**
 * GET /.well-known/jwks.json
 *
 * Returns the public keys used for JWT verification.
 * Clients should cache this response (Cache-Control header provided).
 */
export async function GET() {
  if (!isJWKSConfigured()) {
    return NextResponse.json(
      { error: "JWKS not configured" },
      { status: 503 },
    );
  }

  const jwks = await getJWKS();

  return NextResponse.json(jwks, {
    headers: {
      "Cache-Control": "public, max-age=300", // 5 minute cache
      "Content-Type": "application/json",
    },
  });
}
