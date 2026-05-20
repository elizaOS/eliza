/**
 * Farcaster mini-app quickAuth token exchange.
 *
 * Called by FarcasterMiniAppProvider after sdk.quickAuth.getToken() succeeds.
 * The quickAuth token is a JWT issued by https://auth.farcaster.xyz and
 * contains { sub: fid (number), address, iss, aud, exp }.
 *
 * Verification uses @farcaster/quick-auth's createClient().verifyJwt(), which
 * fetches the JWKS from auth.farcaster.xyz (~50-100ms, cached by the server).
 *
 * Client flow:
 *   1. sdk.quickAuth.getToken() → returns Farcaster-signed JWT
 *   2. Client POSTs { token } here
 *   3. This route verifies + provisions + returns { token } (Steward-compatible)
 *   4. Client POSTs to /api/auth/session to set httpOnly cookie
 */

import { createClient } from "@farcaster/quick-auth";
import { withErrorHandling } from "@feed/api";
import { db, eq, users } from "@feed/db";
import { generateSnowflakeId } from "@feed/shared";
import { SignJWT } from "jose";
import { type NextRequest, NextResponse } from "next/server";

const STEWARD_API_URL = process.env.STEWARD_API_URL ?? "http://localhost:3200";
const STEWARD_PLATFORM_KEY =
  (process.env.STEWARD_PLATFORM_KEYS ?? "").split(",")[0]?.trim() ?? "";
const STEWARD_JWT_SECRET = new TextEncoder().encode(
  process.env.STEWARD_JWT_SECRET ?? "dev-jwt-secret-change-in-prod",
);

async function ensureStewardUser(email?: string): Promise<string> {
  if (!email || !STEWARD_PLATFORM_KEY) return crypto.randomUUID();

  const res = await fetch(`${STEWARD_API_URL}/platform/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Steward-Platform-Key": STEWARD_PLATFORM_KEY,
    },
    body: JSON.stringify({ email, emailVerified: false }),
  });

  if (!res.ok)
    throw new Error(`Failed to provision Steward user: ${res.status}`);
  const data = (await res.json()) as {
    ok: boolean;
    data?: { userId?: string };
    error?: string;
  };
  if (!data.ok || !data.data?.userId)
    throw new Error(data.error ?? "missing userId");
  return data.data.userId;
}

async function mintToken(stewardUserId: string, fid: number): Promise<string> {
  return new SignJWT({ userId: stewardUserId, tenantId: "feed", fid })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("steward")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(STEWARD_JWT_SECRET);
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  let body: { token?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body" },
      { status: 400 },
    );
  }

  const { token: quickAuthToken } = body;
  if (!quickAuthToken) {
    return NextResponse.json(
      { ok: false, error: "token is required" },
      { status: 400 },
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const domain = new URL(appUrl).hostname;

  // Verify quickAuth JWT — makes a network call to auth.farcaster.xyz for JWKS
  const quickAuthClient = createClient();
  let payload: { sub: number; address?: string };
  try {
    payload = (await quickAuthClient.verifyJwt({
      token: quickAuthToken,
      domain,
    })) as typeof payload;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid Farcaster quickAuth token" },
      { status: 401 },
    );
  }

  const fid = payload.sub;
  if (!fid || typeof fid !== "number") {
    return NextResponse.json(
      { ok: false, error: "FID missing from token" },
      { status: 401 },
    );
  }

  // Look up existing user by FID
  const [existing] = await db
    .select({ id: users.id, stewardId: users.stewardId, email: users.email })
    .from(users)
    .where(eq(users.farcasterFid, String(fid)))
    .limit(1);

  let stewardUserId: string;

  if (existing) {
    if (existing.stewardId) {
      stewardUserId = existing.stewardId;
    } else {
      stewardUserId = await ensureStewardUser(existing.email ?? undefined);
      await db
        .update(users)
        .set({ stewardId: stewardUserId })
        .where(eq(users.id, existing.id));
    }
  } else {
    stewardUserId = await ensureStewardUser();
    const newId = await generateSnowflakeId();
    await db.insert(users).values({
      id: newId,
      stewardId: stewardUserId,
      farcasterFid: String(fid),
      isActor: false,
      updatedAt: new Date(),
    });
  }

  const token = await mintToken(stewardUserId, fid);
  return NextResponse.json({ ok: true, token });
});
