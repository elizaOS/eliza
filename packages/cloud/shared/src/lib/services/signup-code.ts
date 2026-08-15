/**
 * Signup code service: validate codes and grant bonus credits (one-time per org).
 *
 * WHY: Marketing/ads need shareable links that grant extra credits. Codes are
 * loaded from env (SIGNUP_CODES_JSON); one per org keeps abuse low.
 *
 * Env: SIGNUP_CODES_JSON — JSON string { "codes": { "code": amount, ... } }. If unset, defaults to {}.
 * See docs/signup-codes.md for design WHYs and API.
 */

import { creditTransactionsRepository } from "../../db/repositories/credit-transactions";
import { isUniqueConstraintError } from "../utils/db-errors";
import { logger } from "../utils/logger";
import { creditsService } from "./credits";

export const ERRORS = {
  INVALID_CODE: "Invalid signup code",
  ALREADY_USED: "Your account has already used a signup code",
};

interface SignupCodesConfig {
  codes?: Record<string, number>;
}

/** WHY default "{}": App must run when env is unset; no codes = feature disabled. */
function loadCodes(): Map<string, number> {
  const raw = process.env.SIGNUP_CODES_JSON ?? "{}";
  let data: SignupCodesConfig;
  try {
    data = JSON.parse(raw) as SignupCodesConfig;
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logger.warn(`[SignupCode] Invalid SIGNUP_CODES_JSON (${message}), using no codes`);
    return new Map();
  }
  const codes = data.codes;
  if (!codes || typeof codes !== "object") {
    return new Map();
  }
  const map = new Map<string, number>();
  for (const [code, amount] of Object.entries(codes)) {
    const normalized = code?.trim().toLowerCase();
    if (!normalized) continue;
    // The documented contract declares `amount` as a number; the string
    // branch is a defensive sanity check on malformed JSON and must be
    // strict — parseFloat accepts a numeric prefix ("25credits" -> 25) and
    // returns Infinity for "Infinity", which then passes an isNaN-only
    // guard and could reach addCredits as a non-finite grant (#20132).
    // Require a complete canonical non-negative decimal string and accept
    // only finite positive values on both branches.
    let num: number;
    if (typeof amount === "number") {
      num = amount;
    } else {
      const raw = String(amount).trim();
      if (!/^\d+(?:\.\d+)?$/.test(raw)) continue;
      num = Number(raw);
    }
    if (Number.isFinite(num) && num > 0) {
      map.set(normalized, num);
    }
  }
  return map;
}

/** Test hook: the codes map is cached per process; tests need to re-read env. */
export function resetSignupCodesCacheForTests(): void {
  cachedCodes = null;
}

/** WHY cache: Env is read once per process; no need to re-parse on every redeem. */
let cachedCodes: Map<string, number> | null = null;

function getCodes(): Map<string, number> {
  if (cachedCodes === null) {
    cachedCodes = loadCodes();
  }
  return cachedCodes;
}

export function getBonusForCode(code: string): number | undefined {
  if (!code?.trim()) return undefined;
  return getCodes().get(code.trim().toLowerCase());
}

export async function hasUsedSignupCode(organizationId: string): Promise<boolean> {
  return creditTransactionsRepository.hasSignupCodeBonus(organizationId);
}

function redactCode(code: string): string {
  const s = code.trim().toLowerCase();
  if (s.length <= 2) return "***";
  return s.slice(0, 2) + "***";
}

export async function redeemSignupCode(organizationId: string, code: string): Promise<number> {
  const bonus = getBonusForCode(code);
  if (bonus === undefined) {
    throw new Error(ERRORS.INVALID_CODE);
  }

  /* WHY check before addCredits: Avoid granting then failing on unique index; fail fast with clear ALREADY_USED. */
  const used = await hasUsedSignupCode(organizationId);
  if (used) {
    throw new Error(ERRORS.ALREADY_USED);
  }

  try {
    await creditsService.addCredits({
      organizationId,
      amount: bonus,
      description: "Signup code bonus",
      metadata: {
        type: "signup_code_bonus",
        code: redactCode(code),
      },
    });
  } catch (error) {
    /* WHY: Race — two concurrent redeems for same org; second insert hits partial unique index; surface as ALREADY_USED. */
    if (isUniqueConstraintError(error)) {
      throw new Error(ERRORS.ALREADY_USED);
    }
    throw error;
  }

  logger.info("[SignupCode] Redeemed", {
    organizationId,
    code: redactCode(code),
    bonus,
  });

  return bonus;
}
