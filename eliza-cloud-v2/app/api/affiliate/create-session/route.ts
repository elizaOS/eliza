import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { logger } from "@/lib/utils/logger";
import { createAnonymousUserAndSession } from "@/lib/services/anonymous-session-creator";
import { cookies } from "next/headers";

// Cookie name - must match auth-anonymous.ts
const ANON_SESSION_COOKIE = "eliza-anon-session";

// Session expiry in days
const ANON_SESSION_EXPIRY_DAYS = Number.parseInt(
  process.env.ANON_SESSION_EXPIRY_DAYS || "7",
  10,
);

// Get message limit from env or default
const ANON_MESSAGE_LIMIT = Number.parseInt(
  process.env.ANON_MESSAGE_LIMIT || "5",
  10,
);

// Schema validation for incoming request
const CreateSessionSchema = z.object({
  characterId: z.string().uuid(),
  source: z.string().optional(),
});

/**
 * POST /api/affiliate/create-session
 * Creates an anonymous session for users to try chat without signing up.
 * Creates a real anonymous user in the database and sets a session cookie.
 *
 * @param request - Request body with characterId and optional source.
 * @returns Session token and user ID.
 */
export async function POST(request: NextRequest) {
  try {
    // Parse and validate request body
    const body = await request.json();
    const validationResult = CreateSessionSchema.safeParse(body);

    if (!validationResult.success) {
      logger.warn(
        "[Create Session] Invalid request body:",
        validationResult.error.format(),
      );
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request body",
          details: validationResult.error.format(),
        },
        { status: 400 },
      );
    }

    const { characterId, source } = validationResult.data;

    // Generate session token using nanoid (consistent with other endpoints)
    const sessionToken = nanoid(32);

    // Session expires in configured days
    const expiresAt = new Date(
      Date.now() + ANON_SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );

    // Extract client info
    const realIp = request.headers.get("x-real-ip")?.trim();
    const forwardedFor = request.headers.get("x-forwarded-for");
    const ipAddress =
      realIp || forwardedFor?.split(",")[0]?.trim() || undefined;
    const userAgent = request.headers.get("user-agent") || undefined;
    // NOTE: IP-based anonymous-session abuse checks intentionally removed.

    // Use shared creator function (handles transaction internally)
    const { newUser, newSession } = await createAnonymousUserAndSession({
      sessionToken,
      expiresAt,
      ipAddress,
      userAgent,
      messagesLimit: ANON_MESSAGE_LIMIT,
    });

    logger.info(`[Create Session] Created anonymous user: ${newUser.id}`);

    const result = { user: newUser, session: newSession };

    // Set the session cookie so getAnonymousUser() can find this user
    // Only set cookie AFTER successful transaction
    const cookieStore = await cookies();
    cookieStore.set(ANON_SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict", // Prevent CSRF attacks
      path: "/",
      expires: expiresAt,
    });

    logger.info(
      `[Create Session] Created anonymous session for character ${characterId}`,
      {
        userId: result.user.id,
        source,
      },
    );

    return NextResponse.json({
      success: true,
      sessionToken,
      userId: result.user.id,
    });
  } catch (error) {
    logger.error("[Create Session] Error creating session:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to create session",
      },
      { status: 500 },
    );
  }
}
