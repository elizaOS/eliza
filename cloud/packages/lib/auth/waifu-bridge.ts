/**
 * Waifu Bridge Auth — resolves waifu-core service JWTs to eliza-cloud user+org.
 */

import crypto from "crypto";
import { dbWrite } from "@/db/helpers";
import type { Organization } from "@/db/schemas/organizations";
import { userIdentities } from "@/db/schemas/user-identities";
import { ForbiddenError } from "@/lib/api/errors";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { organizationsService } from "@/lib/services/organizations";
import { usersService } from "@/lib/services/users";
import type { UserWithOrganization } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import { isServiceJwtEnabled, type ServiceJwtPayload, verifyServiceJwt } from "./service-jwt";

export interface WaifuBridgeAuthResult {
  user: UserWithOrganization & {
    organization_id: string;
    organization: Organization;
  };
  servicePayload: ServiceJwtPayload;
  authMethod: "service_jwt";
}

/**
 * Authenticate a request from waifu-core via service JWT.
 * Returns the resolved user+org or null.
 */
let _warnedJwtNotConfigured = false;

export async function authenticateWaifuBridge(
  request: Request,
): Promise<WaifuBridgeAuthResult | null> {
  if (!isServiceJwtEnabled()) {
    // Warn once so operators notice the bridge is unconfigured without
    // flooding logs on every request.
    if (!_warnedJwtNotConfigured) {
      _warnedJwtNotConfigured = true;
      logger.warn(
        "[waifu-bridge] ELIZA_SERVICE_JWT_SECRET is not set — waifu bridge auth is disabled",
      );
    }
    return null;
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;

  const payload = await verifyServiceJwt(authHeader);
  if (!payload) return null;

  logger.info("[waifu-bridge] Authenticated service JWT", {
    userId: payload.userId,
    tier: payload.tier,
  });

  const user = await resolveServiceUser(payload);

  return {
    user,
    servicePayload: payload,
    authMethod: "service_jwt",
  };
}

function serviceIdFromUserId(userId: string): string {
  return `svc_${userId.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()}`;
}

/**
 * Derive an org slug deterministically from the userId.
 *
 * Previous implementation used crypto.randomBytes, which meant concurrent
 * requests for the same userId could each produce a different slug and
 * therefore create separate orgs. We now derive the suffix from a SHA-256
 * hash of the userId so it's stable across retries/races.
 */
function slugFromUserId(userId: string): string {
  const base = userId
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .toLowerCase()
    .slice(0, 40);
  const hash = crypto.createHash("sha256").update(userId).digest("hex").slice(0, 16);
  return `${base}-${hash}`;
}

export function canAutoCreateWaifuBridgeOrg(): boolean {
  // Only allow auto-creation when explicitly opted in. Relying on
  // NODE_ENV !== "production" was unsafe because preview / staging
  // deployments often run with NODE_ENV=development while still
  // handling real traffic.
  return getCloudAwareEnv().WAIFU_BRIDGE_ALLOW_ORG_AUTO_CREATE === "true";
}

/**
 * Resolve a service JWT userId to an eliza-cloud user with org.
 */
async function resolveServiceUser(
  payload: ServiceJwtPayload,
): Promise<WaifuBridgeAuthResult["user"]> {
  const pinnedOrgId = process.env.WAIFU_BRIDGE_ORG_ID;
  const serviceId = serviceIdFromUserId(payload.userId);

  // 1. Try existing user by serviceId
  const user = await usersService.getByStewardId(serviceId);
  if (user?.organization_id && user?.organization) {
    return user as WaifuBridgeAuthResult["user"];
  }

  // 2. Try wallet address match
  const walletMatch = payload.userId.match(/^waifu:(0x[a-fA-F0-9]{40})$/);
  if (walletMatch) {
    const walletUser = await usersService.getByWalletAddressWithOrganization(
      walletMatch[1].toLowerCase(),
    );
    if (walletUser?.organization_id && walletUser?.organization) {
      // Update identity to link the service ID
      await dbWrite
        .insert(userIdentities)
        .values({
          user_id: walletUser.id,
          steward_user_id: serviceId,
        })
        .onConflictDoUpdate({
          target: userIdentities.user_id,
          set: { steward_user_id: serviceId, updated_at: new Date() },
        });
      return walletUser as WaifuBridgeAuthResult["user"];
    }
  }

  // 3. Auto-provision
  logger.info("[waifu-bridge] Auto-provisioning service user", {
    serviceId,
    userId: payload.userId,
  });

  let orgId = pinnedOrgId;

  if (!orgId) {
    if (!canAutoCreateWaifuBridgeOrg()) {
      throw new ForbiddenError(
        "WAIFU_BRIDGE_ORG_ID must be configured before provisioning waifu bridge users in production",
      );
    }

    const slug = slugFromUserId(payload.userId);
    const orgName = payload.userId.startsWith("waifu:")
      ? `waifu-${payload.userId.slice(6, 14)}`
      : "waifu-svc";

    try {
      const org = await organizationsService.create({
        name: orgName,
        slug,
      });
      orgId = org.id;
    } catch (orgErr: unknown) {
      // Handle race: a concurrent request may have created the org with
      // the same deterministic slug.
      const isConflict =
        orgErr instanceof Error &&
        (orgErr.message.includes("duplicate key") ||
          orgErr.message.includes("unique constraint") ||
          orgErr.message.includes("23505"));
      if (!isConflict) throw orgErr;

      logger.info("[waifu-bridge] Concurrent org creation detected, resolving existing org", {
        serviceId,
        slug,
      });

      // Another request won the race and may have created the user too —
      // re-check before falling through to user creation.
      const retryUser = await usersService.getByStewardId(serviceId);
      if (retryUser?.organization_id && retryUser?.organization) {
        return retryUser as WaifuBridgeAuthResult["user"];
      }

      // The org exists but the user hasn't been created yet — look up the
      // org by its deterministic slug so we can proceed with user creation.
      const existingOrg = await organizationsService.getBySlug(slug);
      if (existingOrg) {
        orgId = existingOrg.id;
      } else {
        throw new ForbiddenError(
          "Failed to provision service org for waifu-core bridge (concurrent conflict)",
        );
      }
    }
  }

  const email = payload.email ?? `${serviceId}@waifu.bridge`;
  const walletAddr = walletMatch ? walletMatch[1].toLowerCase() : undefined;

  let newUser;
  try {
    newUser = await usersService.create({
      steward_user_id: serviceId,
      email,
      organization_id: orgId,
      wallet_address: walletAddr,
      wallet_verified: !!walletAddr,
      is_active: true,
    });
  } catch (err: unknown) {
    // Handle concurrent provisioning: if a parallel request already created
    // this user (unique constraint on steward_user_id or wallet_address),
    // re-fetch instead of failing.
    const isConflict =
      err instanceof Error &&
      (err.message.includes("duplicate key") ||
        err.message.includes("unique constraint") ||
        err.message.includes("23505"));
    if (!isConflict) throw err;

    logger.info("[waifu-bridge] Concurrent user creation detected, re-fetching", {
      serviceId,
    });

    const existing = await usersService.getByStewardId(serviceId);
    if (existing?.organization_id && existing?.organization) {
      return existing as WaifuBridgeAuthResult["user"];
    }
    // If wallet-based, try that path too
    if (walletAddr) {
      const walletUser = await usersService.getByWalletAddressWithOrganization(walletAddr);
      if (walletUser?.organization_id && walletUser?.organization) {
        return walletUser as WaifuBridgeAuthResult["user"];
      }
    }
    throw new ForbiddenError(
      "Failed to provision service account for waifu-core bridge (concurrent conflict)",
    );
  }

  // Create identity record for this service user
  await dbWrite.insert(userIdentities).values({
    user_id: newUser.id,
    steward_user_id: serviceId,
  });

  const fullUser = await usersService.getWithOrganization(newUser.id);
  if (!fullUser?.organization_id || !fullUser?.organization) {
    throw new ForbiddenError("Failed to provision service account for waifu-core bridge");
  }

  return fullUser as WaifuBridgeAuthResult["user"];
}
