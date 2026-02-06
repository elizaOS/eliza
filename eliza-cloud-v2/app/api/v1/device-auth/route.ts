/**
 * POST /api/v1/device-auth
 *
 * Device-based auto-signup for milaidy mobile and desktop clients.
 *
 * Accepts a hashed device identifier and creates a new user + org + $5
 * credit + API key if the device is new. If the device already exists,
 * returns the existing API key and account info.
 *
 * This endpoint does NOT require prior authentication — it IS the
 * authentication step for device-based clients.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/utils/logger";
import { usersRepository } from "@/db/repositories/users";
import { organizationsRepository } from "@/db/repositories/organizations";
import { creditsService } from "@/lib/services/credits";
import { apiKeysService } from "@/lib/services/api-keys";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { dbRead } from "@/db/helpers";
import { users } from "@/db/schemas/users";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Initial credits granted to new device-auth signups ($5). */
const DEVICE_AUTH_INITIAL_CREDITS = Number(
  process.env.DEVICE_AUTH_INITIAL_CREDITS ?? "5.00",
);

const deviceAuthSchema = z.object({
  deviceId: z
    .string()
    .min(16, "Device ID must be at least 16 characters (SHA-256 hash)")
    .max(128),
  platform: z.enum(["ios", "android", "macos", "windows", "linux", "web"]),
  appVersion: z.string().min(1).max(50),
  deviceName: z.string().max(100).optional(),
});

function generateOrgSlug(platform: string): string {
  const random = Math.random().toString(36).substring(2, 10);
  const timestamp = Date.now().toString(36).slice(-4);
  return `device-${platform}-${timestamp}${random}`;
}

async function ensureUniqueSlug(platform: string, maxAttempts = 10): Promise<string> {
  let slug = generateOrgSlug(platform);
  let attempts = 0;

  while (await organizationsRepository.findBySlug(slug)) {
    attempts++;
    if (attempts >= maxAttempts) {
      throw new Error("Failed to generate unique organization slug");
    }
    slug = generateOrgSlug(platform);
  }

  return slug;
}

async function handleDeviceAuth(request: NextRequest) {
  const body = await request.json();
  const validated = deviceAuthSchema.parse(body);

  // Look up existing user by device_id
  const existingUsers = await dbRead
    .select()
    .from(users)
    .where(eq(users.device_id, validated.deviceId))
    .limit(1);

  if (existingUsers.length > 0) {
    // ─── EXISTING DEVICE ────────────────────────────────────────────────
    const existingUser = existingUsers[0];

    if (!existingUser.organization_id) {
      return NextResponse.json(
        { success: false, error: "User account is incomplete (no organization)" },
        { status: 500 },
      );
    }

    // Find existing API keys for this org
    const existingApiKeys = await apiKeysService.listByOrganization(
      existingUser.organization_id,
    );

    let apiKeyValue: string;

    if (existingApiKeys.length > 0) {
      // Delete old key and create a fresh one so we can return the raw value.
      // API key hashes are one-way so we cannot retrieve the original.
      await apiKeysService.delete(existingApiKeys[0].id);
      const created = await apiKeysService.create({
        user_id: existingUser.id,
        organization_id: existingUser.organization_id,
        name: "Milaidy Device Key",
        is_active: true,
      });
      apiKeyValue = created.plainKey;
    } else {
      const created = await apiKeysService.create({
        user_id: existingUser.id,
        organization_id: existingUser.organization_id,
        name: "Milaidy Device Key",
        is_active: true,
      });
      apiKeyValue = created.plainKey;
    }

    // Get current credit balance from organization
    const org = await organizationsRepository.findById(existingUser.organization_id);
    const balance = org ? Number(org.credit_balance) : 0;

    logger.info("[device-auth] Existing device authenticated", {
      userId: existingUser.id,
      deviceId: validated.deviceId.substring(0, 8) + "...",
      platform: validated.platform,
    });

    return NextResponse.json({
      success: true,
      data: {
        apiKey: apiKeyValue,
        userId: existingUser.id,
        organizationId: existingUser.organization_id,
        credits: balance,
        isNew: false,
      },
    });
  }

  // ─── NEW DEVICE ─────────────────────────────────────────────────────
  const slug = await ensureUniqueSlug(validated.platform);

  // Create organization
  const organization = await organizationsRepository.create({
    name: validated.deviceName
      ? `${validated.deviceName}'s Organization`
      : `Milaidy Device (${validated.platform})`,
    slug,
    credit_balance: "0.00",
  });

  // Create user with device_id
  const newUser = await usersRepository.create({
    device_id: validated.deviceId,
    device_platform: validated.platform,
    is_anonymous: false,
    organization_id: organization.id,
    role: "owner",
    is_active: true,
    name: validated.deviceName ?? `Milaidy User (${validated.platform})`,
  });

  // Grant initial credits
  if (DEVICE_AUTH_INITIAL_CREDITS > 0) {
    await creditsService.addCredits({
      organizationId: organization.id,
      amount: DEVICE_AUTH_INITIAL_CREDITS,
      description: "Milaidy device signup bonus",
      metadata: {
        type: "initial_free_credits",
        source: "device-auth",
        platform: validated.platform,
        appVersion: validated.appVersion,
      },
    });
  }

  // Create API key
  const created = await apiKeysService.create({
    user_id: newUser.id,
    organization_id: organization.id,
    name: "Milaidy Device Key",
    is_active: true,
  });

  logger.info("[device-auth] New device registered", {
    userId: newUser.id,
    organizationId: organization.id,
    deviceId: validated.deviceId.substring(0, 8) + "...",
    platform: validated.platform,
    credits: DEVICE_AUTH_INITIAL_CREDITS,
  });

  return NextResponse.json(
    {
      success: true,
      data: {
        apiKey: created.plainKey,
        userId: newUser.id,
        organizationId: organization.id,
        credits: DEVICE_AUTH_INITIAL_CREDITS,
        isNew: true,
      },
    },
    { status: 201 },
  );
}

export const POST = withRateLimit(handleDeviceAuth, RateLimitPresets.CRITICAL);
