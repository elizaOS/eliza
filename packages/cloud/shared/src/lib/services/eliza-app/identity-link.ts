/**
 * Mints and confirms the short-lived link codes that bind a messaging-platform
 * handle (iMessage/phone, WhatsApp, Telegram, Discord) to an authenticated
 * eliza.app account (#17344, design doc "Authenticated Identity Linking").
 *
 * `start` runs under the caller's own session; `confirm` runs under gateway
 * internal auth with a platform identity the gateway itself attests — the code
 * is the proof the two sides belong to the same person. Consumption is
 * single-use via a conditional UPDATE on `status='pending'`, so a replayed
 * confirm reports `already_used` instead of re-binding. Cross-account
 * takeovers are rejected before consumption: a handle already resolving to a
 * different cloud user never re-binds through a link code.
 */
import { randomBytes } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, lt, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../../../db/client";
import { usersRepository } from "../../../db/repositories/users";
import {
  type IdentityLinkCode,
  type IdentityLinkCodePlatform,
  identityLinkCodes,
} from "../../../db/schemas/identity-link-codes";
import { logger } from "../../utils/logger";
import { isValidE164, normalizePhoneNumber } from "../../utils/phone-normalization";

/** Unambiguous alphabet (no 0/O, 1/I/L) so codes survive being typed by hand. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000;
const MINT_ATTEMPTS = 3;

/** How the code is presented to and typed by the user, e.g. `LINK-7KQ2M4XW`. */
export const LINK_CODE_PATTERN = /\bLINK-([A-HJ-NP-Z2-9]{8})\b/i;

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

function mintCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

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
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  await dbWrite
    .update(identityLinkCodes)
    .set({ status: "expired", updated_at: new Date() })
    .where(
      and(
        eq(identityLinkCodes.user_id, input.userId),
        eq(identityLinkCodes.platform, input.platform),
        eq(identityLinkCodes.status, "pending"),
      ),
    );

  for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt++) {
    const code = mintCode();
    try {
      const [row] = await dbWrite
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
    } catch (error) {
      // error-policy:J2 A unique-code collision is retried with a fresh code;
      // the final attempt rethrows with context so the boundary reports it.
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
 * minting account. The conditional consume (status='pending' AND unexpired) is
 * the single-use gate; classification of the losing paths is read afterwards
 * so replay, expiry, and unknown codes each surface as their own status.
 */
export async function confirmIdentityLink(
  input: ConfirmIdentityLinkInput,
): Promise<ConfirmIdentityLinkResult> {
  const code = normalizeCode(input.code);
  if (!code) return { status: "code_not_found" };

  const [row] = await dbRead
    .select()
    .from(identityLinkCodes)
    .where(eq(identityLinkCodes.code, code))
    .limit(1);
  if (!row) return { status: "code_not_found" };
  if (row.status === "linked") return { status: "already_used" };
  if (row.status === "expired" || row.expires_at.getTime() <= Date.now()) {
    return { status: "expired" };
  }
  if (row.platform !== input.platform) {
    return { status: "platform_mismatch", expectedPlatform: row.platform };
  }

  const platformId =
    input.platform === "phone" ? normalizePhoneNumber(input.platformId) : input.platformId.trim();
  if (!platformId || (input.platform === "phone" && !isValidE164(platformId))) {
    throw new ElizaError("IdentityLink: confirm received an unusable platform handle", {
      code: "IDENTITY_LINK_INVALID_HANDLE",
      context: { platform: input.platform },
    });
  }

  // Never silently merge identities across users: a handle that already
  // resolves to a different cloud account keeps its owner.
  const existing = await usersRepository.resolveIdentity(platformId, input.platform);
  if (existing && existing.user.id !== row.user_id) {
    return { status: "handle_conflict" };
  }

  const now = new Date();
  const consumed = await dbWrite
    .update(identityLinkCodes)
    .set({ status: "linked", consumed_at: now, platform_id: platformId, updated_at: now })
    .where(
      and(
        eq(identityLinkCodes.id, row.id),
        eq(identityLinkCodes.status, "pending"),
        sql`${identityLinkCodes.expires_at} > now()`,
      ),
    )
    .returning();
  if (consumed.length === 0) {
    // A concurrent confirm won the conditional update (or expiry crossed the
    // boundary between read and write); report the closest terminal state.
    return row.expires_at.getTime() <= Date.now()
      ? { status: "expired" }
      : { status: "already_used" };
  }

  const bound = await bindHandle(row, platformId, input.platformName);
  if (!bound) {
    throw new ElizaError("IdentityLink: minting user disappeared before binding", {
      code: "IDENTITY_LINK_USER_MISSING",
      context: { userId: row.user_id, platform: input.platform },
    });
  }

  logger.info("IdentityLink: platform handle bound to account", {
    userId: row.user_id,
    organizationId: row.organization_id,
    platform: input.platform,
  });
  return {
    status: "linked",
    userId: row.user_id,
    organizationId: row.organization_id,
    platform: row.platform,
  };
}

async function bindHandle(
  row: IdentityLinkCode,
  platformId: string,
  platformName: string | undefined,
): Promise<boolean> {
  switch (row.platform) {
    case "telegram":
      return Boolean(
        await usersRepository.linkTelegramIdentity(row.user_id, {
          telegram_id: platformId,
          telegram_username: platformName ?? null,
        }),
      );
    case "discord":
      return Boolean(
        await usersRepository.linkDiscordIdentity(row.user_id, {
          discord_id: platformId,
          discord_username: platformName ?? platformId,
        }),
      );
    case "whatsapp":
      return Boolean(
        await usersRepository.linkWhatsAppIdentity(row.user_id, {
          whatsapp_id: platformId,
          whatsapp_name: platformName ?? null,
        }),
      );
    case "phone":
      return Boolean(await usersRepository.linkVerifiedPhone(row.user_id, platformId));
  }
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
