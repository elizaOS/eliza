/**
 * Signed, expiring recovery links for the Dedicated fallback pay action
 * (#25146).
 *
 * A link is a compact ES256 JWS signed with the Cloud JWKS signing key and
 * bound to one withdrawal interval: organization, user, interval id,
 * generation and recovery action kind. It carries no payment details and
 * grants nothing by itself. The resolver only redirects to `/cloud/billing`
 * with the organization context, where the signed-in owner acts; payment is
 * still confirmed by the billing lifecycle, never by following a link.
 */

import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { errors as joseErrors, jwtVerify, SignJWT } from "jose";
import { dbWrite } from "../../db/helpers";
import {
  type PersonalDedicatedFallback,
  personalDedicatedFallbacks,
} from "../../db/schemas/personal-dedicated-fallbacks";
import { getAlgorithm, getKeyId, getPrivateKey, getPublicKey } from "../auth/jwks";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { getAppUrl } from "../utils/app-url";
import {
  PERSONAL_FALLBACK_RECOVERY_LINK_PATH,
  type PersonalFallbackRecoveryLink,
  type PersonalSharedFallbackAccountState,
} from "./shared-runtime/personal-fallback-account-state";

const ISSUER = "eliza-cloud";
const AUDIENCE = "eliza-cloud-personal-fallback-recovery";
/** Default lifetime: long enough to act on a connector message, short enough to go stale. */
export const PERSONAL_FALLBACK_RECOVERY_LINK_TTL_SECONDS = 72 * 60 * 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_TOKEN_CHARS = 2_048;

export type PersonalFallbackRecoveryKind =
  PersonalSharedFallbackAccountState["recoveryAction"]["kind"];

export interface PersonalFallbackRecoveryClaims {
  organizationId: string;
  userId: string;
  fallbackId: string;
  generation: number;
  kind: PersonalFallbackRecoveryKind;
  expiresAt: Date;
}

export class PersonalFallbackRecoveryLinkError extends ElizaError {
  override readonly name = "PersonalFallbackRecoveryLinkError";
  constructor(
    message: string,
    code:
      | "PERSONAL_FALLBACK_RECOVERY_LINK_UNCONFIGURED"
      | "PERSONAL_FALLBACK_RECOVERY_LINK_INVALID"
      | "PERSONAL_FALLBACK_RECOVERY_LINK_EXPIRED",
    context?: Record<string, unknown>,
  ) {
    super(message, { code, ...(context ? { context } : {}) });
  }
}

function recoveryKind(fallback: PersonalDedicatedFallback): PersonalFallbackRecoveryKind {
  return fallback.reason === "billing_suspended" ? "add_credits" : "restore_subscription";
}

/** Mints the pay-action link for one open withdrawal interval. */
export async function mintPersonalFallbackRecoveryLink(input: {
  fallback: PersonalDedicatedFallback;
  appUrl?: string;
  ttlSeconds?: number;
  now?: Date;
}): Promise<PersonalFallbackRecoveryLink> {
  const ttl = input.ttlSeconds ?? PERSONAL_FALLBACK_RECOVERY_LINK_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw new PersonalFallbackRecoveryLinkError(
      "Recovery link lifetime is out of range",
      "PERSONAL_FALLBACK_RECOVERY_LINK_INVALID",
      { ttl },
    );
  }
  let privateKey: CryptoKey;
  try {
    privateKey = await getPrivateKey();
  } catch (error) {
    throw new PersonalFallbackRecoveryLinkError(
      "Recovery link signing key is not configured",
      "PERSONAL_FALLBACK_RECOVERY_LINK_UNCONFIGURED",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const { fallback } = input;
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const expiresAt = issuedAt + ttl;
  const token = await new SignJWT({
    org: fallback.organization_id,
    fid: fallback.id,
    gen: fallback.generation,
    act: recoveryKind(fallback),
  })
    .setProtectedHeader({ alg: getAlgorithm(), kid: getKeyId(), typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(fallback.user_id)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(privateKey);
  const base = input.appUrl ?? getAppUrl(getCloudAwareEnv());
  return {
    url: `${base.replace(/\/$/, "")}${PERSONAL_FALLBACK_RECOVERY_LINK_PATH}${token}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

/**
 * Adds the signed link to an account state. A deployment without the signing
 * key keeps the signed-in `/cloud/billing` path and logs the gap through the
 * caller; any other failure propagates.
 */
export async function withPersonalFallbackRecoveryLink(
  accountState: PersonalSharedFallbackAccountState,
  fallback: PersonalDedicatedFallback,
  onUnconfigured: (error: PersonalFallbackRecoveryLinkError) => void,
): Promise<PersonalSharedFallbackAccountState> {
  try {
    const link = await mintPersonalFallbackRecoveryLink({ fallback });
    return { ...accountState, recoveryAction: { ...accountState.recoveryAction, link } };
  } catch (error) {
    if (
      error instanceof PersonalFallbackRecoveryLinkError &&
      error.code === "PERSONAL_FALLBACK_RECOVERY_LINK_UNCONFIGURED"
    ) {
      onUnconfigured(error);
      return accountState;
    }
    throw error;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verifies signature, issuer, audience, expiry and the exact claim shape. */
export async function verifyPersonalFallbackRecoveryToken(
  token: string,
  now?: Date,
): Promise<PersonalFallbackRecoveryClaims> {
  if (!token || token.length > MAX_TOKEN_CHARS) {
    throw new PersonalFallbackRecoveryLinkError(
      "Recovery link is malformed",
      "PERSONAL_FALLBACK_RECOVERY_LINK_INVALID",
    );
  }
  let publicKey: CryptoKey;
  try {
    publicKey = await getPublicKey();
  } catch (error) {
    throw new PersonalFallbackRecoveryLinkError(
      "Recovery link verification key is not configured",
      "PERSONAL_FALLBACK_RECOVERY_LINK_UNCONFIGURED",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, publicKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [getAlgorithm()],
      ...(now ? { currentDate: now } : {}),
    }));
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new PersonalFallbackRecoveryLinkError(
        "Recovery link has expired",
        "PERSONAL_FALLBACK_RECOVERY_LINK_EXPIRED",
      );
    }
    // error-policy:J3 untrusted token — every other verification failure is invalid input.
    throw new PersonalFallbackRecoveryLinkError(
      "Recovery link is invalid",
      "PERSONAL_FALLBACK_RECOVERY_LINK_INVALID",
    );
  }
  const { org, fid, gen, act, sub, exp } = payload;
  if (
    typeof org !== "string" ||
    !UUID.test(org) ||
    typeof sub !== "string" ||
    !UUID.test(sub) ||
    typeof fid !== "string" ||
    !UUID.test(fid) ||
    typeof gen !== "number" ||
    !Number.isSafeInteger(gen) ||
    gen < 1 ||
    (act !== "restore_subscription" && act !== "add_credits") ||
    typeof exp !== "number"
  ) {
    throw new PersonalFallbackRecoveryLinkError(
      "Recovery link claims are invalid",
      "PERSONAL_FALLBACK_RECOVERY_LINK_INVALID",
    );
  }
  return {
    organizationId: org,
    userId: sub,
    fallbackId: fid,
    generation: gen,
    kind: act,
    expiresAt: new Date(exp * 1000),
  };
}

/** The billing destination for a verified link: organization context only. */
export function personalFallbackRecoveryBillingUrl(
  claims: Pick<PersonalFallbackRecoveryClaims, "organizationId" | "kind">,
  appUrl?: string,
): string {
  const base = (appUrl ?? getAppUrl(getCloudAwareEnv())).replace(/\/$/, "");
  const url = new URL(`${base}/cloud/billing`);
  url.searchParams.set("organizationId", claims.organizationId);
  url.searchParams.set("action", claims.kind);
  return url.toString();
}

/**
 * Resolves a recovery link to its billing destination. The token must verify
 * and still name its exact withdrawal interval (organization, user,
 * generation); an interval that has since recovered still resolves, since the
 * billing page is harmless and shows the restored plan.
 */
export async function resolvePersonalFallbackRecoveryLink(
  token: string,
  options: { appUrl?: string; now?: Date } = {},
): Promise<{ billingUrl: string; claims: PersonalFallbackRecoveryClaims }> {
  const claims = await verifyPersonalFallbackRecoveryToken(token, options.now);
  const [row] = await dbWrite
    .select({ id: personalDedicatedFallbacks.id })
    .from(personalDedicatedFallbacks)
    .where(
      and(
        eq(personalDedicatedFallbacks.id, claims.fallbackId),
        eq(personalDedicatedFallbacks.organization_id, claims.organizationId),
        eq(personalDedicatedFallbacks.user_id, claims.userId),
        eq(personalDedicatedFallbacks.generation, claims.generation),
      ),
    )
    .limit(1);
  if (!row) {
    throw new PersonalFallbackRecoveryLinkError(
      "Recovery link no longer names an interval",
      "PERSONAL_FALLBACK_RECOVERY_LINK_INVALID",
      { fallbackId: claims.fallbackId },
    );
  }
  return { billingUrl: personalFallbackRecoveryBillingUrl(claims, options.appUrl), claims };
}
