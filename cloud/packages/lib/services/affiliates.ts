import { nanoid } from "nanoid";
import { affiliatesRepository } from "@/db/repositories/affiliates";
import type { AffiliateCode, UserAffiliate } from "@/db/schemas/affiliates";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { logger } from "@/lib/utils/logger";

// Error codes for consistent error handling
export const ERRORS = {
  INVALID_CODE: "Invalid affiliate code",
  CODE_NOT_FOUND: "Affiliate code not found",
  ALREADY_LINKED: "User is already linked to an affiliate",
  SELF_REFERRAL: "Users cannot refer themselves",
} as const;

function normalizeAffiliateCode(code: string): string {
  return code.trim().toUpperCase();
}

function isUniqueViolation(error: unknown): boolean {
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return (
    code === "23505" || (error instanceof Error && error.message.includes("unique constraint"))
  );
}

/**
 * Affiliate (revenue-share) service. WHY separate from referrals: Referrals split
 * purchase revenue (50/40/10) at signup attribution; affiliates get a markup added
 * to what the customer pays (auto top-up, MCP). So we never apply both to the same
 * transaction, avoiding over-payout. getReferrer() is used by auto-top-up and
 * user-mcps to resolve markup; linkUserToAffiliateCode is used at signup or via API.
 */
export class AffiliatesService {
  /**
   * Returns the user's affiliate code if it exists. Read-only; does not create.
   */
  async getAffiliateCode(userId: string): Promise<AffiliateCode | null> {
    const cacheKey = CacheKeys.affiliate.codeByUserId(userId);
    const cached = await cache.get<AffiliateCode | { __none: true }>(cacheKey);
    if (cached) {
      return "__none" in cached ? null : (cached as AffiliateCode);
    }

    const code = await affiliatesRepository.getAffiliateCodeByUserId(userId);
    await cache.set(cacheKey, code || { __none: true }, CacheTTL.affiliate.data);
    return code;
  }

  /**
   * Generates or returns an existing affiliate code for the user.
   */
  async getOrCreateAffiliateCode(userId: string, markupPercent?: number): Promise<AffiliateCode> {
    let affiliateCode = await this.getAffiliateCode(userId);
    if (affiliateCode) {
      if (markupPercent !== undefined && Number(affiliateCode.markup_percent) !== markupPercent) {
        return this.updateMarkup(userId, markupPercent);
      }
      return affiliateCode;
    }

    // WHY default 20%: Balances affiliate incentive with customer acceptance; can be overridden per code.
    const markup = markupPercent ?? 20.0;
    if (markup < 0 || markup > 1000) {
      throw new Error("Markup percent must be between 0 and 1000");
    }
    let attempts = 0;
    while (attempts < 10) {
      const code = `AFF-${nanoid(8).toUpperCase()}`;

      try {
        affiliateCode = await affiliatesRepository.createAffiliateCodeIfNotExists({
          user_id: userId,
          code,
          markup_percent: markup.toFixed(2) as string,
        });

        if (affiliateCode) {
          await cache.del(CacheKeys.affiliate.codeByUserId(userId));
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          affiliateCode = await affiliatesRepository.getAffiliateCodeByUserId(userId);
          if (affiliateCode) {
            logger.info("[Affiliates] Using concurrently created affiliate code", {
              userId,
            });
            break;
          }
          attempts++;
          continue;
        }
        throw error;
      }

      if (!affiliateCode) {
        affiliateCode = await affiliatesRepository.getAffiliateCodeByUserId(userId);
        if (affiliateCode) {
          logger.info("[Affiliates] Using concurrently created affiliate code", {
            userId,
          });
          break;
        }
        throw new Error("Failed to create or retrieve affiliate code");
      }

      logger.info("[Affiliates] Created new affiliate code", { userId, code });
      break;
    }

    if (!affiliateCode) {
      throw new Error("Failed to generate a unique affiliate code");
    }

    if (markupPercent !== undefined && Number(affiliateCode.markup_percent) !== markupPercent) {
      return this.updateMarkup(userId, markupPercent);
    }

    return affiliateCode;
  }

  /**
   * Updates the markup percentage for an affiliate code
   */
  async updateMarkup(userId: string, markupPercent: number): Promise<AffiliateCode> {
    if (markupPercent < 0 || markupPercent > 1000) {
      throw new Error("Markup percent must be between 0 and 1000");
    }

    const existing = await affiliatesRepository.getAffiliateCodeByUserId(userId);
    if (!existing) {
      throw new Error(ERRORS.CODE_NOT_FOUND);
    }

    const updated = await affiliatesRepository.updateAffiliateCode(existing.id, {
      markup_percent: markupPercent.toFixed(2) as string,
    });

    if (!updated) {
      throw new Error("Failed to update affiliate code");
    }

    // Invalidate code cache
    await cache.del(CacheKeys.affiliate.codeById(existing.id));
    await cache.del(CacheKeys.affiliate.codeByUserId(existing.user_id));
    await cache.del(CacheKeys.affiliate.codeByCode(existing.code));

    logger.info("[Affiliates] Updated affiliate markup", {
      userId,
      markupPercent,
    });
    return updated;
  }

  /**
   * Links a user to an affiliate code (invoked during signup)
   */
  async linkUserToAffiliateCode(userId: string, code: string): Promise<UserAffiliate> {
    const normalizedCode = normalizeAffiliateCode(code);

    // Check cache for affiliate code by code string
    const codeCacheKey = CacheKeys.affiliate.codeByCode(normalizedCode);
    let affiliateCode = await cache.get<AffiliateCode | { __none: true }>(codeCacheKey);

    if (!affiliateCode) {
      const dbCode = await affiliatesRepository.getAffiliateCodeByCode(normalizedCode);
      affiliateCode = dbCode || { __none: true };
      await cache.set(codeCacheKey, affiliateCode, CacheTTL.affiliate.data);
    }

    if ("__none" in affiliateCode) {
      throw new Error(ERRORS.INVALID_CODE);
    }

    if (!affiliateCode.is_active) {
      throw new Error(ERRORS.INVALID_CODE);
    }

    if (affiliateCode.user_id === userId) {
      throw new Error(ERRORS.SELF_REFERRAL);
    }

    const existingLink = await affiliatesRepository.getUserAffiliate(userId);
    if (existingLink) {
      if (existingLink.affiliate_code_id === affiliateCode.id) {
        return existingLink;
      }
      throw new Error(ERRORS.ALREADY_LINKED);
    }

    let link: UserAffiliate;
    try {
      link = await affiliatesRepository.linkUserToAffiliate({
        user_id: userId,
        affiliate_code_id: affiliateCode.id,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrentLink = await affiliatesRepository.getUserAffiliate(userId);
        if (concurrentLink?.affiliate_code_id === affiliateCode.id) {
          return concurrentLink;
        }
        throw new Error(ERRORS.ALREADY_LINKED);
      }
      throw error;
    }

    // Invalidate link cache for this user
    await cache.del(CacheKeys.affiliate.linkByUserId(userId));

    logger.info("[Affiliates] Linked user to affiliate code", {
      userId,
      code: normalizedCode,
    });
    return link;
  }

  /**
   * Retrieves the affiliate who referred the user (if any). Used by auto-top-up
   * and MCP to add markup to the charge and pay the affiliate from it.
   */
  async getReferrer(userId: string): Promise<AffiliateCode | null> {
    const linkCacheKey = CacheKeys.affiliate.linkByUserId(userId);
    let link = await cache.get<UserAffiliate | { __none: true }>(linkCacheKey);

    if (!link) {
      const dbLink = await affiliatesRepository.getUserAffiliate(userId);
      link = dbLink || { __none: true };
      await cache.set(linkCacheKey, link, CacheTTL.affiliate.data);
    }

    if ("__none" in link) {
      return null;
    }

    const linkData = link as UserAffiliate;
    const codeId = linkData.affiliate_code_id;
    const codeCacheKey = CacheKeys.affiliate.codeById(codeId);
    let affiliateCode = await cache.get<AffiliateCode | { __none: true }>(codeCacheKey);

    if (!affiliateCode) {
      const dbCode = await affiliatesRepository.getAffiliateCodeById(codeId);
      affiliateCode = dbCode || { __none: true };
      await cache.set(codeCacheKey, affiliateCode, CacheTTL.affiliate.data);
    }

    if ("__none" in affiliateCode || !(affiliateCode as AffiliateCode).is_active) {
      return null;
    }

    return affiliateCode as AffiliateCode;
  }
}

export const affiliatesService = new AffiliatesService();
