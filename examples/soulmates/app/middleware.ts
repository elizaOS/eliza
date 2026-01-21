import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { DEV_SESSION_COOKIE, isAuthEnabled } from "@/lib/auth-mode";
import { isDevLoginEnabled } from "@/lib/env";

function redirectToLogin(request: NextRequest): NextResponse {
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("callbackUrl", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/app")) {
    return NextResponse.next();
  }

  // Dev mode without NextAuth
  if (!isAuthEnabled()) {
    if (!isDevLoginEnabled()) return redirectToLogin(request);
    const devSession = request.cookies.get(DEV_SESSION_COOKIE)?.value;
    return devSession ? NextResponse.next() : redirectToLogin(request);
  }

  // Production mode with NextAuth
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
  });
  return token ? NextResponse.next() : redirectToLogin(request);
}

export const config = {
  matcher: ["/app/:path*"],
};
