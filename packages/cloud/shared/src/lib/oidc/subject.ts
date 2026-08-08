/**
 * Resolution of an Eliza Cloud user into everything the OIDC claim builder
 * needs, plus the eligibility rules that decide whether that user may become an
 * identity at a relying party at all.
 *
 * Reads go through `usersRepository` (not the cached service) because both
 * `/token` and `/userinfo` must observe a deactivation that happened after the
 * code was issued. `assertOidcSubjectEligible` is the gate: it refuses
 * anonymous, inactive, and soft-deleted rows, and — for a client that requires
 * it — a row with no identity this provider is willing to hand over.
 *
 * "Identity" is a verified email by default, and that check is deliberately
 * "verified AND present". The field-level encryption rollout leaves
 * `users.email` nullable while ciphertext columns fill in, and a relying party
 * configured for automatic account creation would otherwise silently start
 * creating accounts with no address. Failing the authorization loudly is the
 * safe direction.
 *
 * A client that sets `wallet_email_fallback` widens that gate — and only that
 * gate — to also accept a VERIFIED wallet, which `./wallet-email.ts` turns into
 * a deterministic no-reply address, for a user who has no stored address of
 * their own. The widening is admission policy; it asserts nothing about a
 * mailbox, and `email_verified` stays false for the synthesized address (see
 * `./claims.ts`). An unverified `wallet_address` proves nothing and never
 * produces an identity.
 *
 * The gate reads `resolveOidcEmailIdentity`, the same function that builds the
 * `email` claim, so admission cannot be granted on the strength of an identity
 * emission would not produce. That coupling is why a user who holds an
 * UNCONFIRMED stored address is refused by a client requiring a verified email
 * even when their wallet is verified: the stored address is what a token would
 * carry, and it is not one anybody proved. The registry refuses the other half
 * of the same gap — `wallet_email_fallback` with `require_verified_email` off
 * (see `./clients.ts`).
 *
 * "Verified" is `readVerifiedWalletAddress` below rather than `wallet_verified`
 * alone, because a boolean cannot say who asserted it. Read off the writers: the
 * SIWE/SIWS sign-ins, the signed wallet-auth header and
 * `/api/users/me/wallet/attach` set it from a nonce-bound signature this
 * deployment checked; `lib/steward-sync.ts` sets it from a claim in the Steward
 * session token, which is the authority establishing who the browser is for
 * `/authorize` at all and whose email claim already sets `email_verified` beside
 * it. Two writers asserted it from an address they were merely handed, and both
 * are corrected at the source: `lib/services/wallet-signup.ts` now records what
 * its caller proved (x402 topup and agent provisioning prove nothing), and
 * `lib/auth/waifu-bridge.ts`, which read the address out of a service token's
 * subject, records `false`. The chain-type condition below is the second,
 * independent lock: provenance a row does not record is provenance this provider
 * does not credit.
 *
 * One guard here is unconditional, applying to every client including those with
 * no flag set: a stored `users.email` in the reserved wallet-email namespace is
 * treated as ABSENT everywhere downstream — claims, eligibility, and the
 * username seed. Such a domain routes no mail by construction, so no address on
 * it can have been verified by delivery; a row carrying one is a squatting
 * attempt against the synthesized address of whoever owns the matching wallet,
 * not a user. Making it conditional on the flag would leave the attack open
 * through any client that does not require a verified email. `email_verified` is
 * cleared with the address rather than left behind, so the scrub subtracts a
 * squatted value and adds no assertion of its own.
 */

import { oidcRepository } from "../../db/repositories/oidc";
import { type UserWithOrganization, usersRepository } from "../../db/repositories/users";
import type { OidcUserProfile } from "../../db/schemas/oidc";
import { adminService, isElizaLabsAdminEmail } from "../services/admin";
import { type OidcAdminStatus, resolveOidcEmailIdentity } from "./claims";
import type { OidcClient } from "./clients";
import type { OidcConfig } from "./config";
import { isOidcWalletEmailAddress, synthesizeOidcWalletEmail } from "./wallet-email";

export interface OidcSubject {
  user: UserWithOrganization;
  profile: OidcUserProfile | null;
  adminStatus: OidcAdminStatus;
  /**
   * Deterministic no-reply address derived from a VERIFIED wallet, or `null`
   * when the wallet is unverified, absent, of unrecorded provenance, or the
   * deployment hosts no wallet-email domain. Non-null does not mean it will be
   * emitted: only a client with `wallet_email_fallback` ever sees it.
   */
  walletEmail: string | null;
}

/**
 * `wallet_chain_type` values that only a wallet-binding path writes, checked
 * against every writer of the column: `evm` from `/api/users/me/wallet/attach`
 * and the SIWE branch of `lib/services/wallet-signup.ts`, `solana` from its SIWS
 * branch and from `lib/steward-sync.ts`, `ethereum` from `lib/steward-sync.ts`.
 *
 * Requiring one is the second, independent condition on a wallet identity. A
 * row can hold `wallet_verified: true` with NO chain type — that is exactly the
 * shape `lib/auth/waifu-bridge.ts` produced from a self-named address — so the
 * absence of provenance is treated as absence of a wallet, and the gate stays
 * closed even if some later writer sets the flag without recording how.
 */
const WALLET_PROVING_CHAIN_TYPES: ReadonlySet<string> = new Set(["evm", "ethereum", "solana"]);

/**
 * The wallet address this account may be identified by, or `null` when nothing
 * on the row establishes one.
 *
 * Returns the STORED address; `synthesizeOidcWalletEmail` canonicalizes it, so
 * two rows that differ only in EVM letter case cannot become two identities.
 */
export function readVerifiedWalletAddress(
  user: Pick<UserWithOrganization, "wallet_address" | "wallet_verified" | "wallet_chain_type">,
): string | null {
  if (user.wallet_verified !== true) return null;
  const chainType =
    typeof user.wallet_chain_type === "string" ? user.wallet_chain_type.trim().toLowerCase() : "";
  if (!WALLET_PROVING_CHAIN_TYPES.has(chainType)) return null;
  const address = typeof user.wallet_address === "string" ? user.wallet_address.trim() : "";
  return address.length > 0 ? address : null;
}

export type OidcIneligibleReason =
  | "user_inactive"
  | "user_anonymous"
  | "email_unverified"
  | "no_verified_identity"
  | "organization_inactive";

/** Live read of the user, org, OIDC profile, platform-admin grant, and wallet identity. */
export async function loadOidcSubject(
  userId: string,
  config: OidcConfig,
): Promise<OidcSubject | null> {
  const found = await usersRepository.findWithOrganization(userId);
  if (!found) return null;

  const walletEmailDomain = config.walletEmailDomain;
  // Applied before anything reads the row, so the squatted address cannot reach
  // the claim builder, the eligibility gate, or the username allocator.
  //
  // `email_verified` is cleared WITH the address, never after it. Dropping the
  // address alone left the row asserting a confirmed mailbox it then declined to
  // name: `email_verified: true` with no `email`, in every token, for every
  // client including the ones that never opted into any of this. Clearing both
  // makes a scrubbed row indistinguishable from a row that simply has no
  // address, so the guard removes the squatted value and changes nothing else.
  const user: UserWithOrganization = isOidcWalletEmailAddress(found.email, walletEmailDomain)
    ? { ...found, email: null, email_verified: false }
    : found;

  const verifiedWalletAddress = readVerifiedWalletAddress(user);

  const [profile, adminStatus, walletEmail] = await Promise.all([
    oidcRepository.findProfile(user.id),
    adminService.getAdminStatusForUser(user),
    walletEmailDomain && verifiedWalletAddress
      ? synthesizeOidcWalletEmail(verifiedWalletAddress, walletEmailDomain)
      : Promise.resolve(null),
  ]);

  return {
    user,
    profile: profile ?? null,
    adminStatus: {
      isAdmin: adminStatus.isAdmin,
      role: adminStatus.role,
      // The @elizalabs.ai rule grants super_admin with no `admin_users` row.
      // Distinguishing it lets a relying party allowlist the wallet-backed
      // grant without inheriting the email-domain one.
      implicit:
        adminStatus.role === "super_admin" &&
        isElizaLabsAdminEmail(user.email) &&
        user.email_verified === true &&
        !user.wallet_address,
    },
    walletEmail,
  };
}

/**
 * Whether this subject carries an address this client may be handed.
 *
 * Asked of `resolveOidcEmailIdentity` — the same function the claim builder uses
 * — rather than of the row directly, so admission cannot describe a different
 * identity than emission will produce. Gating them on separate expressions is
 * how a client came to admit a subject and then receive a token whose `email`
 * was absent or was an address the gate had never looked at.
 *
 * Given a resolved identity the rule is one line: there must be an address, and
 * it must be one somebody proved. A wallet-derived address qualifies even though
 * it carries `email_verified: false` — the proof is the signature over the
 * wallet, which `eliza_email_source` names — while a stored address qualifies
 * only once the mailbox was confirmed.
 *
 * For a client without `wallet_email_fallback` no identity can ever have
 * `source: "wallet"`, so this reduces to "a present, verified `users.email`",
 * which is the original expression exactly.
 */
export function hasUsableOidcEmailIdentity(subject: OidcSubject, client: OidcClient): boolean {
  const identity = resolveOidcEmailIdentity(subject.user, subject.walletEmail, client);
  if (!identity.email) return false;
  return identity.source === "wallet" || identity.emailVerified;
}

/** `null` when the subject may authorize; otherwise the refusal reason. */
export function assertOidcSubjectEligible(
  subject: OidcSubject,
  client: OidcClient,
): OidcIneligibleReason | null {
  const { user } = subject;
  if (user.is_anonymous) return "user_anonymous";
  if (!user.is_active || user.deleted_at) return "user_inactive";
  if (user.organization && !user.organization.is_active) return "organization_inactive";
  if (client.require_verified_email && !hasUsableOidcEmailIdentity(subject, client)) {
    // `no_verified_identity` is for an opted-in client that refused a subject
    // with nothing to offer at all, which `email_unverified` would misreport as
    // a problem the user could fix by confirming an address. When the row DOES
    // hold an unconfirmed address, confirming it is exactly the fix — the stored
    // address takes precedence over the wallet either way — so the original
    // reason is the accurate one even for an opted-in client.
    if (!client.wallet_email_fallback || subject.user.email) return "email_unverified";
    return "no_verified_identity";
  }
  return null;
}
