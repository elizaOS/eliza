import { NextRequest, NextResponse } from "next/server";
import { headers, cookies } from "next/headers";
import crypto from "crypto";
import { syncUserFromPrivy, type SyncOptions } from "@/lib/privy-sync";
import { migrateAnonymousSession } from "@/lib/session";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { logger } from "@/lib/utils/logger";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import {
  trackServerEvent,
  identifyServerUser,
} from "@/lib/analytics/posthog-server";
import { getSignupMethod } from "@/lib/analytics/posthog";

// Verify webhook signature from Privy using their recommended method
async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  // Privy sends signature as "v1,timestamp,signature"
  const parts = signature.split(",");
  if (parts.length !== 3 || parts[0] !== "v1") {
    return false;
  }

  const timestamp = parts[1];
  const providedSignature = parts[2];

  // Construct the signed payload
  const signedPayload = `v1:${timestamp}:${payload}`;

  // Calculate expected signature
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  // Compare signatures
  return crypto.timingSafeEqual(
    Buffer.from(providedSignature),
    Buffer.from(expectedSignature),
  );
}

/**
 * POST /api/privy/webhook
 * Privy webhook endpoint for handling user authentication events.
 * Verifies webhook signatures and syncs user data from Privy.
 * Handles anonymous session migration when users sign up.
 *
 * Rate limited: AGGRESSIVE (100 req/min per IP) to prevent webhook flooding
 *
 * @param request - Request containing Privy webhook payload with signature header.
 * @returns Webhook processing result.
 */
async function handlePrivyWebhook(request: NextRequest) {
  try {
    // Get the raw body
    const body = await request.text();

    // Get headers
    const headersList = await headers();
    const signature = headersList.get("privy-webhook-signature");

    if (!signature) {
      return NextResponse.json(
        { error: "Missing webhook signature" },
        { status: 401 },
      );
    }

    // Verify webhook signature
    const webhookSecret = process.env.PRIVY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.error("PRIVY_WEBHOOK_SECRET not configured");
      return NextResponse.json(
        { error: "Webhook not configured" },
        { status: 500 },
      );
    }

    const isValid = await verifyWebhookSignature(
      body,
      signature,
      webhookSecret,
    );
    if (!isValid) {
      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 401 },
      );
    }

    // Parse the webhook payload
    const payload = JSON.parse(body);

    // Extract IP address from headers (for abuse tracking)
    const forwardedFor = headersList.get("x-forwarded-for");
    const realIp = headersList.get("x-real-ip");
    const ipAddress =
      forwardedFor?.split(",")[0]?.trim() || realIp || undefined;
    const userAgent = headersList.get("user-agent") || undefined;

    // Handle different webhook events
    switch (payload.type) {
      case "user.created":
      case "user.linked_account":
      case "user.authenticated": {
        // Build sync options with signup context
        const syncOptions: SyncOptions = {
          signupContext: {
            ipAddress,
            userAgent,
          },
        };

        // Sync user on creation, linking new account, or authentication
        const user = await syncUserFromPrivy(payload.user, syncOptions);

        // Track signup event for new users
        if (payload.type === "user.created") {
          const privyUser = payload.user;
          const signupMethod = getSignupMethod(privyUser);

          // Identify user in PostHog using internal UUID for consistent tracking
          identifyServerUser(user.id, {
            email:
              privyUser.email?.address ||
              privyUser.google?.email ||
              privyUser.discord?.email,
            name:
              privyUser.google?.name ||
              privyUser.discord?.username ||
              privyUser.github?.username,
            wallet_address: privyUser.wallet?.address,
            signup_method: signupMethod,
            created_at: new Date().toISOString(),
            organization_id: user.organization_id || undefined,
          });

          // Track signup completed event using internal UUID
          trackServerEvent(user.id, "signup_completed", {
            method: signupMethod,
            has_referral: false, // TODO: Add referral tracking if implemented
          });

          logger.info("[PostHog] Tracked signup_completed", {
            userId: user.id,
            method: signupMethod,
          });
        }

        // Check for anonymous session cookie and migrate data
        const cookieStore = await cookies();
        const anonSessionToken = cookieStore.get("eliza-anon-session")?.value;

        if (anonSessionToken) {
          logger.info(
            "[Privy Webhook] Anonymous session detected, initiating migration...",
            { tokenPreview: anonSessionToken.slice(0, 8) + "..." },
          );

          try {
            const anonSession =
              await anonymousSessionsService.getByToken(anonSessionToken);

            if (anonSession) {
              const migrationResult = await migrateAnonymousSession(
                anonSession.user_id,
                payload.user.id,
              );

              logger.info("[Privy Webhook] Migration completed", {
                success: migrationResult.success,
                anonymousUserId: anonSession.user_id,
                realUserId: user.id,
                privyUserId: payload.user.id,
                ...migrationResult.mergedData,
              });
            } else {
              logger.debug(
                "[Privy Webhook] Anonymous session token not found in DB",
              );
            }
          } catch (migrationError) {
            logger.error("[Privy Webhook] Migration failed:", migrationError);
          }
        }

        break;
      }

      case "user.updated": {
        // Update existing user
        await syncUserFromPrivy(payload.user);
        break;
      }

      case "user.deleted": {
        // Handle user deletion if needed
        // For now, we'll keep the user in our database but could mark as inactive
        break;
      }

      default:
        // Unhandled webhook type
        break;
    }

    return NextResponse.json(
      { success: true, message: "Webhook processed" },
      { status: 200 },
    );
  } catch (error) {
    logger.error("Webhook processing error:", error);

    // Return 200 to prevent retries for processing errors
    // But log the error for debugging
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Processing error",
      },
      { status: 200 },
    );
  }
}

// Export rate-limited handler
export const POST = withRateLimit(
  handlePrivyWebhook,
  RateLimitPresets.AGGRESSIVE,
);
