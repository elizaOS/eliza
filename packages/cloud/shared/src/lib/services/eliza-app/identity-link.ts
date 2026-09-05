/**
 * Mints and confirms the short-lived link codes that bind a messaging-platform
 * handle (iMessage/phone, WhatsApp, Telegram, Discord) to an authenticated
 * eliza.app account (#17344, design doc "Authenticated Identity Linking").
 *
 * `start` runs under the caller's own session; `confirm` runs under gateway
 * internal auth with a platform identity the gateway itself attests — the code
 * is the proof the two sides belong to the same person. Consumption is
 * single-use via a row lock and one transaction containing the identity bind
 * plus code consumption, so a failed bind leaves the code pending and replay
 * reports `already_used`. Cross-account takeovers fail closed at both the
 * owner check and the database uniqueness constraints.
 */
import { ElizaError } from "@elizaos/core/edge";
import { and, eq, lt } from "drizzle-orm";
import { dbWrite } from "../../../db/client";
import { usersRepository } from "../../../db/repositories/users";
import {
  type IdentityLinkCodePlatform,
  identityLinkCodes,
} from "../../../db/schemas/identity-link-codes";
import { users } from "../../../db/schemas/users";
import { isUniqueConstraintError } from "../../utils/db-errors";
import { logger } from "../../utils/logger";
import { isValidE164, normalizePhoneNumber } from "../../utils/phone-normalization";
import { mintIdentityLinkCode } from "./identity-link-code";
import { invalidateBoundPersonalDeliveryProjection } from "./personal-delivery-projection-contract";

const CODE_TTL_MS = 10 * 60 * 1000;
const MINT_ATTEMPTS = 3;

export { LINK_CODE_PATTERN } from "./identity-link-code";

export interface StartIdentityLinkInput {
  userId: string;
  organizationId: string;
  platform: IdentityLinkCodePlatform;
}

export interface StartIdentityLinkResult {
  /** Display form including the LINK- prefix the gateway matcher expects. */
  code: string;
  platform: IdentityLinkCodePlatform;
  expiresAt: Date;
}

export interface ConfirmIdentityLinkInput {
  /** Raw user-typed code; the LINK- prefix and case are both tolerated. */
  code: string;
  /** Provider derived from the transport (telegram/discord/whatsapp/phone). */
  platform: IdentityLinkCodePlatform;
  /** Gateway-attested platform handle of the sender. */
  platformId: string;
  platformName?: string;
}

export type ConfirmIdentityLinkResult =
  | { status: "linked"; userId: string; organizationId: string; platform: IdentityLinkCodePlatform }
  | { status: "code_not_found" }
  | { status: "expired" }
  | { status: "already_used" }
  | { status: "platform_mismatch"; expectedPlatform: IdentityLinkCodePlatform }
  | { status: "handle_conflict" };

function normalizeCode(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  const bare = trimmed.startsWith("LINK-") ? trimmed.slice(5) : trimmed;
  return /^[A-HJ-NP-Z2-9]{8}$/.test(bare) ? bare : null;
}

/**
 * Mints a fresh pending code for the session's user, superseding any earlier
 * pending code for the same (user, platform) so exactly one code is live.
 */
export async function startIdentityLink(
  input: StartIdentityLinkInput,
): Promise<StartIdentityLinkResult> {
  for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt++) {
    const code = mintIdentityLinkCode();
    try {
      return await dbWrite.transaction(async (tx) => {
        const [account] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, input.userId), eq(users.organization_id, input.organizationId)))
          .for("update")
          .limit(1);
        if (!account) {
          throw new ElizaError("IdentityLink: session account does not match its organization", {
            code: "IDENTITY_LINK_ACCOUNT_MISMATCH",
            context: { userId: input.userId, organizationId: input.organizationId },
          });
        }
        const now = new Date();
        const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
        await tx
          .update(identityLinkCodes)
          .set({ status: "expired", updated_at: now })
          .where(
            and(
              eq(identityLinkCodes.user_id, input.userId),
              eq(identityLinkCodes.platform, input.platform),
              eq(identityLinkCodes.status, "pending"),
            ),
          );
        const [row] = await tx
          .insert(identityLinkCodes)
          .values({
            code,
            user_id: input.userId,
            organization_id: input.organizationId,
            platform: input.platform,
            expires_at: expiresAt,
          })
          .returning();
        return { code: `LINK-${row.code}`, platform: input.platform, expiresAt: row.expires_at };
      });
    } catch (error) {
      // error-policy:J2 A unique-code collision is retried with a fresh code;
      // the final attempt rethrows with context so the boundary reports it.
      if (!isUniqueConstraintError(error)) throw error;
      if (attempt === MINT_ATTEMPTS) {
        throw new ElizaError("IdentityLink: failed to mint a unique link code", {
          code: "IDENTITY_LINK_CODE_MINT_FAILED",
          cause: error instanceof Error ? error : undefined,
          context: { userId: input.userId, platform: input.platform },
        });
      }
    }
  }
  throw new ElizaError("IdentityLink: unreachable mint fallthrough", {
    code: "IDENTITY_LINK_CODE_MINT_FAILED",
  });
}

/**
 * Confirms a code from the channel side and binds the attested handle to the
 * minting account. Locking the code serializes replay attempts; identity writes
 * and consumption share the transaction so neither can commit alone.
 */
export async function confirmIdentityLink(
  input: ConfirmIdentityLinkInput,
): Promise<ConfirmIdentityLinkResult> {
  const code = normalizeCode(input.code);
  if (!code) return { status: "code_not_found" };

  const platformId =
    input.platform === "phone" ? normalizePhoneNumber(input.platformId) : input.platformId.trim();
  if (!platformId || (input.platform === "phone" && !isValidE164(platformId))) {
    throw new ElizaError("IdentityLink: confirm received an unusable platform handle", {
      code: "IDENTITY_LINK_INVALID_HANDLE",
      context: { platform: input.platform },
    });
  }

  let result: ConfirmIdentityLinkResult;
  let replayInvalidation: { platform: "telegram" | "discord"; platformId: string } | undefined;
  try {
    result = await dbWrite.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(identityLinkCodes)
        .where(eq(identityLinkCodes.code, code))
        .for("update")
        .limit(1);
      if (!row) return { status: "code_not_found" };
      if (row.status === "linked") {
        if (
          row.platform === input.platform &&
          row.platform_id === platformId &&
          (row.platform === "telegram" || row.platform === "discord")
        ) {
          replayInvalidation = { platform: row.platform, platformId };
        }
        return { status: "already_used" };
      }
      if (row.status === "expired" || row.expires_at.getTime() <= Date.now()) {
        return { status: "expired" };
      }
      if (row.platform !== input.platform) {
        return { status: "platform_mismatch", expectedPlatform: row.platform };
      }

      const bound = await usersRepository.linkMessagingIdentityInTransaction(
        tx,
        row.user_id,
        row.platform,
        platformId,
        input.platformName,
      );
      if (bound.status === "handle_conflict") return { status: "handle_conflict" };
      if (bound.status === "user_not_found") {
        throw new ElizaError("IdentityLink: minting user disappeared before binding", {
          code: "IDENTITY_LINK_USER_MISSING",
          context: { userId: row.user_id, platform: input.platform },
        });
      }

      const now = new Date();
      await tx
        .update(identityLinkCodes)
        .set({ status: "linked", consumed_at: now, platform_id: platformId, updated_at: now })
        .where(eq(identityLinkCodes.id, row.id));
      return {
        status: "linked",
        userId: row.user_id,
        organizationId: row.organization_id,
        platform: row.platform,
      };
    });
  } catch (error) {
    // error-policy:J1 A uniqueness race means another account retained the
    // handle. The transaction rollback also restores this code to pending.
    if (isUniqueConstraintError(error)) return { status: "handle_conflict" };
    throw error;
  }

  const projectionInvalidation =
    result.status === "linked" && (result.platform === "telegram" || result.platform === "discord")
      ? { platform: result.platform, platformId }
      : replayInvalidation;
  if (projectionInvalidation) {
    await invalidateBoundPersonalDeliveryProjection(
      projectionInvalidation.platform,
      projectionInvalidation.platformId,
    );
  }

  if (result.status !== "linked") return result;

  logger.info("IdentityLink: platform handle bound to account", {
    userId: result.userId,
    organizationId: result.organizationId,
    platform: input.platform,
  });
  return result;
}

/** Housekeeping: flips pending rows past their TTL to expired. */
export async function expireStaleIdentityLinkCodes(): Promise<number> {
  const rows = await dbWrite
    .update(identityLinkCodes)
    .set({ status: "expired", updated_at: new Date() })
    .where(
      and(eq(identityLinkCodes.status, "pending"), lt(identityLinkCodes.expires_at, new Date())),
    )
    .returning({ id: identityLinkCodes.id });
  return rows.length;
}
