import { NextRequest, NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { nanoid } from "nanoid";
import { createAnonymousUserAndSession } from "@/lib/services/anonymous-session-creator";
import { logger } from "@/lib/utils/logger";

const ANON_SESSION_COOKIE = "eliza-anon-session";

/**
 * Parse and validate a positive integer environment variable.
 * Returns the default value if parsing fails or value is invalid.
 */
function parsePositiveIntEnv(
  envValue: string | undefined,
  defaultValue: number,
  envName: string,
): number {
  const value = Number.parseInt(envValue || String(defaultValue), 10);
  if (Number.isNaN(value) || value <= 0) {
    logger.warn(
      `[create-anonymous-session] Invalid ${envName}, using default: ${defaultValue}`,
    );
    return defaultValue;
  }
  return value;
}

const ANON_SESSION_EXPIRY_DAYS = parsePositiveIntEnv(
  process.env.ANON_SESSION_EXPIRY_DAYS,
  7,
  "ANON_SESSION_EXPIRY_DAYS",
);
const ANON_MESSAGE_LIMIT = parsePositiveIntEnv(
  process.env.ANON_MESSAGE_LIMIT,
  5,
  "ANON_MESSAGE_LIMIT",
);

async function getClientIp(): Promise<string | undefined> {
  const headersList = await headers();
  const realIp = headersList.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }
  const forwardedFor = headersList
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return forwardedFor || undefined;
}

async function getUserAgent(): Promise<string | undefined> {
  const headersList = await headers();
  return headersList.get("user-agent") || undefined;
}

/**
 * Validates that a return URL is safe (prevents open redirect attacks).
 * Only allows relative URLs starting with / (but not //).
 */
function isValidReturnUrl(url: string): boolean {
  // Only allow relative URLs starting with /
  // Reject // to prevent protocol-relative URLs like //malicious-site.com
  return url.startsWith("/") && !url.startsWith("//");
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawReturnUrl = searchParams.get("returnUrl") || "/";

    // Validate returnUrl to prevent open redirect attacks
    const returnUrl = isValidReturnUrl(rawReturnUrl) ? rawReturnUrl : "/";
    if (rawReturnUrl !== returnUrl) {
      logger.warn("[create-anonymous-session] Invalid returnUrl rejected", {
        returnUrl: rawReturnUrl.slice(0, 100),
      });
    }

    const newSessionToken = nanoid(32);
    const expiresAt = new Date(
      Date.now() + ANON_SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );
    const ipAddress = await getClientIp();
    const userAgent = await getUserAgent();
    // NOTE: IP-based anonymous-session abuse checks intentionally removed.

    const { newUser, newSession } = await createAnonymousUserAndSession({
      sessionToken: newSessionToken,
      expiresAt,
      ipAddress,
      userAgent,
      messagesLimit: ANON_MESSAGE_LIMIT,
    });

    // Log successful session creation for audit trail
    logger.info("[create-anonymous-session] Session created successfully", {
      userId: newUser.id,
      sessionId: newSession.id,
      expiresAt: expiresAt.toISOString(),
    });

    const cookieStore = await cookies();
    cookieStore.set(ANON_SESSION_COOKIE, newSessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      expires: expiresAt,
    });

    return NextResponse.redirect(new URL(returnUrl, request.url));
  } catch (error) {
    logger.error("[create-anonymous-session] Error creating session:", error);

    return NextResponse.redirect(
      new URL("/login?error=session_error", request.url),
    );
  }
}
