import { NextResponse } from "next/server";
import { getDevLoginUser } from "@/lib/auth";
import { DEV_SESSION_COOKIE, isAuthEnabled } from "@/lib/auth-mode";
import { isDevLoginEnabled } from "@/lib/env";

export const runtime = "nodejs";

export async function POST() {
  if (isAuthEnabled() || !isDevLoginEnabled()) {
    return NextResponse.json(
      { ok: false, error: "Dev login disabled." },
      { status: 403 },
    );
  }

  const user = await getDevLoginUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Dev login unavailable." },
      { status: 500 },
    );
  }

  const response = NextResponse.json({ ok: true, userId: user.id });
  response.cookies.set(DEV_SESSION_COOKIE, user.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
