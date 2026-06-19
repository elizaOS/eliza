/**
 * Cookie bridge for Steward JWTs.
 *
 * POST  — Verifies a Steward JWT and sets it as an httpOnly steward-token cookie.
 *         Called by auth callback pages after receiving a token from Steward.
 *         Tokens are always sent in the POST body, never in URL params.
 * DELETE — Clears steward-token and steward-refresh cookies (logout).
 */

import { withErrorHandling } from "@feed/api";
import { jwtVerify } from "jose";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { getStewardJwtSecret } from "@/lib/auth/steward-server";

const THIRTY_DAYS = 60 * 60 * 24 * 30;

export const POST = withErrorHandling(async (req: NextRequest) => {
  let body: { token?: string; refreshToken?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const { token, refreshToken } = body;
  if (!token) {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }

  // Verify the JWT locally before storing — rejects tampered or expired tokens
  let userId: string;
  try {
    const { payload } = await jwtVerify(token, getStewardJwtSecret(), {
      issuer: "steward",
      algorithms: ["HS256"],
    });
    userId = String(payload.userId ?? "");
    if (!userId) throw new Error("missing userId claim");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid token";
    return NextResponse.json(
      { error: `Invalid Steward token: ${msg}` },
      { status: 401 },
    );
  }

  const cookieStore = await cookies();
  const isProd = process.env.NODE_ENV === "production";

  cookieStore.set("steward-token", token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: THIRTY_DAYS,
    path: "/",
  });

  if (refreshToken) {
    cookieStore.set("steward-refresh", refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: THIRTY_DAYS,
      path: "/",
    });
  }

  return NextResponse.json({ ok: true, userId });
});

export const DELETE = withErrorHandling(async () => {
  const cookieStore = await cookies();
  cookieStore.delete("steward-token");
  cookieStore.delete("steward-refresh");
  return NextResponse.json({ ok: true });
});
