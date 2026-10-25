/**
 * Derivation of a no-reply email identity from a cryptographically verified
 * wallet, for relying parties that cannot create an account without an address.
 *
 * Git requires an author email on every commit and Forgejo cannot create an
 * account without one, but an Eliza Cloud account may be wallet-only:
 * `users.email` is nullable while `users.wallet_address` is unique and
 * `users.wallet_verified` marks a wallet that an authenticating path bound to
 * the account. This module turns that wallet into an address that is syntactically
 * real, unique, stable, and routes nowhere — the same property GitHub relies on
 * for `user@users.noreply.github.com`, derived from the configured issuer rather
 * than hardcoded so a self-hosted deployment cannot emit addresses on a domain
 * it does not own. WHICH wallets are admissible is `./subject.ts`; this module
 * only derives, and derives from whatever it is handed.
 *
 * The digest input is the address CANONICALIZED by `normalizeWallet`, the same
 * function that feeds `users.wallet_address_blind_index`, so the identity layer
 * and the encryption layer answer "is this the same wallet?" with one rule
 * instead of two that can drift apart. The rule is chain-shaped: a `0x` address
 * is EVM hex and folds case, anything else is base58 and does not. Both halves
 * are load-bearing. Folding is required because nothing guarantees which of an
 * EVM address's two legal spellings a row holds: `/api/users/me/wallet/attach`
 * and `lib/services/wallet-signup.ts` lowercase the EIP-55 address they were
 * given, a Steward claim arrives in whatever case Steward sent, and the reader
 * that finds a row (`findByWalletAddress`) folds case to match any of them. A
 * digest over the stored bytes would hand one wallet two identities depending on
 * which surface last wrote the row. NOT folding base58
 * is equally required: `7xKX…AsU` and `7xkx…asu` are different Solana keys, so
 * case-folding them would merge two distinct wallets onto one address, which at
 * a relying party keyed on the address is an account takeover.
 *
 * `wallet_chain_type` is deliberately NOT an input, even though `normalizeWallet`
 * accepts one. It is mutable — a Steward sync rewrites it — and an identity that
 * moves when a background job rewrites a column is not an identity. Passing it
 * would change nothing anyway: for every address this provider can be handed the
 * `0x` test alone decides, because the two writers that record `evm` derive the
 * address from viem's `getAddress`. The gate in `./subject.ts` still reads the
 * column, for admission rather than derivation.
 *
 * The digest is obfuscation, not secrecy. A wallet address is public, so anyone
 * holding a candidate list can confirm which address belongs to which wallet. A
 * keyed HMAC would close that but would make every wallet user's account
 * identity depend on a secret whose loss rewrites it — disqualifying when the
 * address IS the identity at the relying party.
 *
 * ONE HUMAN MUST OWN ONE ROW, or this derives two identities for them. That is a
 * property of the wallet LOOKUP paths, not of anything here, and it is fragile
 * in one specific way: `usersRepository.findByWalletAddress*` and the
 * `usersService` readers over them lowercase their predicate, which is right for
 * EVM hex and wrong for base58. A folded base58 lookup misses the row that
 * already holds the wallet, the caller falls through to account creation, and
 * the same human acquires a second Cloud account — hence a second permanent git
 * author address at the forge. The two paths that can create a wallet account
 * therefore use `findBySolanaWalletAddressWithOrganization` for non-`0x`
 * addresses (`lib/steward-sync.ts`, `lib/services/wallet-signup.ts`); the folded
 * readers are reached only from EVM-shaped call sites. A future caller that
 * hands a base58 address to a folding reader reintroduces the split silently —
 * nothing fails, there are simply two accounts — so that is the invariant to
 * check when touching those readers.
 *
 * Re-binding a wallet (`/api/users/me/wallet/attach`) changes the derived
 * address. Forgejo links accounts by `sub` — its `ExternalLoginUser` row is
 * keyed on the OAuth2 subject, which is why the account survives a changed
 * address and the address re-syncs on the next login — but a stale row still
 * holding the old address collides with a later user who binds that wallet:
 * that fails closed at Forgejo's unique constraint, it does not hand over an
 * account. Both halves of that (`sub`-keyed linking, and acceptance of
 * `email_verified: false`) are relying-party properties this provider depends
 * on; see the header of `./claims.ts`.
 */

import { normalizeWallet } from "../../db/crypto/field-crypto";
import { sha256Hex } from "./crypto";

/** Local-part prefix, so a synthesized address is recognizable on sight. */
export const OIDC_WALLET_EMAIL_LOCAL_PREFIX = "wallet-";

/**
 * Domain separator with an explicit version tag, so a future format change is
 * distinguishable from a bare digest and can be migrated deliberately instead of
 * silently re-identifying every wallet account.
 */
export const OIDC_WALLET_EMAIL_DIGEST_CONTEXT = "eliza-oidc/wallet-email/v1\n";

/** Label prepended to the issuer hostname to form the default domain. */
export const OIDC_WALLET_EMAIL_SUBDOMAIN = "users.noreply";

/**
 * Hex characters of digest kept in the local part.
 *
 * RFC 5321 caps a local part at 64 octets and full SHA-256 hex is 64 characters,
 * so `wallet-` + the whole digest would be 71. 128 bits keeps second-preimage
 * work against a NAMED victim at 2^128; the 2^64 birthday bound only lets an
 * attacker collide two wallets they already own, which gains them nothing.
 */
const DIGEST_HEX_LENGTH = 32;

/** `wallet-` + 32 hex characters. Fixed, which is what makes the ceiling below exact. */
const LOCAL_PART_LENGTH = OIDC_WALLET_EMAIL_LOCAL_PREFIX.length + DIGEST_HEX_LENGTH;

/**
 * The local part of every address `synthesizeOidcWalletEmail` produces. It is
 * the half of the reserved shape that does not depend on any configuration, so
 * matching on it is what keeps a previously issued identity reserved after the
 * domain it was minted on stops being the configured one.
 */
const SYNTHESIZED_LOCAL_PART_RE = new RegExp(
  `^${OIDC_WALLET_EMAIL_LOCAL_PREFIX}[0-9a-f]{${DIGEST_HEX_LENGTH}}$`,
);

/**
 * Longest domain that keeps the whole address inside RFC 5321's 254-octet
 * ceiling. Tighter than the 253-octet DNS limit because the local part is fixed
 * length; checking it here means synthesis can never produce an address a strict
 * relying party would reject.
 */
const MAX_DOMAIN_LENGTH = 254 - LOCAL_PART_LENGTH - 1;

const MAX_LABEL_LENGTH = 63;
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const IPV4_LITERAL_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * A resolved wallet-email domain, or the sentence naming the rule an operator
 * broke. `domain: null` is the third state and is NOT a failure: it means the
 * deployment cannot host such a domain (an IP-literal issuer), so the feature is
 * simply unavailable and every wallet-only sign-in is refused with a reason.
 */
export type OidcWalletEmailDomainCheck =
  | { ok: true; domain: string | null }
  | { ok: false; reason: string };

/** Whether the issuer hostname is an address literal rather than a DNS name. */
function isIpLiteralHostname(hostname: string): boolean {
  return hostname.startsWith("[") || IPV4_LITERAL_RE.test(hostname);
}

/** `null` when the name is a usable lowercase DNS domain, else the violated rule. */
function describeInvalidDomain(domain: string): string | null {
  if (domain !== domain.toLowerCase()) {
    return "must be lowercase (an email domain is compared case-insensitively, and folding it here would change the identity an operator typed)";
  }
  if (domain.length > MAX_DOMAIN_LENGTH) {
    return `must be at most ${MAX_DOMAIN_LENGTH} characters so the ${LOCAL_PART_LENGTH}-character local part keeps the address inside RFC 5321's 254-octet limit`;
  }
  const labels = domain.split(".");
  if (labels.length < 2) {
    return "must have at least two DNS labels";
  }
  for (const label of labels) {
    if (label.length > MAX_LABEL_LENGTH || !DNS_LABEL_RE.test(label)) {
      return `has an unusable DNS label "${label}"; labels are 1-${MAX_LABEL_LENGTH} characters of [a-z0-9-] and may not start or end with "-"`;
    }
  }
  return null;
}

/**
 * The domain synthesized addresses live on: `users.noreply.<issuer hostname>` by
 * default, or an `OIDC_WALLET_EMAIL_DOMAIN` override that is a STRICT SUBDOMAIN
 * of that hostname.
 *
 * The subdomain rule is the whole security argument. DNS beneath the issuer
 * hostname is controlled by whoever controls the host serving the discovery
 * document, which is provably this deployment, so no user can register a name
 * there and no synthesized address can collide with one a user owns. Accepting
 * an arbitrary override would let a misconfiguration mint addresses on
 * `gmail.com`. The cost is that an operator on `api.example.com` who wants
 * `users.noreply.example.com` must use one more label instead; the alternative
 * needs a public-suffix list to be safe.
 *
 * Takes the URL HOSTNAME, never `OidcConfig.issuerHost`, which carries the port
 * for loopback origins and is not a legal email domain.
 */
export function resolveOidcWalletEmailDomain(
  issuerHostname: string,
  override?: string | null,
): OidcWalletEmailDomainCheck {
  const host = issuerHostname.trim().toLowerCase();
  const configured = typeof override === "string" ? override.trim() : "";

  if (configured) {
    if (isIpLiteralHostname(host)) {
      return {
        ok: false,
        reason: `OIDC_WALLET_EMAIL_DOMAIN "${configured}" cannot be verified against the issuer hostname "${host}", which is an address literal and owns no DNS subtree`,
      };
    }
    const invalid = describeInvalidDomain(configured);
    if (invalid) {
      return { ok: false, reason: `OIDC_WALLET_EMAIL_DOMAIN "${configured}" ${invalid}` };
    }
    if (!configured.endsWith(`.${host}`)) {
      return {
        ok: false,
        reason: `OIDC_WALLET_EMAIL_DOMAIN "${configured}" must be a strict subdomain of the issuer hostname "${host}"; only names below the issuer are provably unregisterable by a user`,
      };
    }
    return { ok: true, domain: configured };
  }

  // An address literal has no subtree this deployment can own, so there is no
  // honest default. The feature is unavailable rather than misconfigured, and
  // the eligibility refusal is what surfaces it.
  if (!host || isIpLiteralHostname(host)) return { ok: true, domain: null };

  const derived = `${OIDC_WALLET_EMAIL_SUBDOMAIN}.${host}`;
  if (describeInvalidDomain(derived)) return { ok: true, domain: null };
  return { ok: true, domain: derived };
}

/**
 * `wallet-<32 lowercase hex>@<domain>` for a wallet address the caller has
 * already confirmed is admissible.
 *
 * Canonicalization happens HERE rather than at the call site so no future caller
 * can derive an identity from an uncanonicalized column and hand the same wallet
 * a second address; `normalizeWallet` is idempotent, so a caller that already
 * canonicalized loses nothing.
 *
 * All-lowercase hex makes the local part a fixed point under case folding, which
 * matters concretely: Forgejo/Gitea keeps a `lower_email` column for uniqueness,
 * so an address that was not already lowercase would be folded on the way in and
 * stop matching what this provider emits.
 */
export async function synthesizeOidcWalletEmail(
  walletAddress: string,
  domain: string,
): Promise<string> {
  const canonical = normalizeWallet(walletAddress);
  const digest = await sha256Hex(`${OIDC_WALLET_EMAIL_DIGEST_CONTEXT}${canonical}`);
  return `${OIDC_WALLET_EMAIL_LOCAL_PREFIX}${digest.slice(0, DIGEST_HEX_LENGTH)}@${domain}`;
}

/**
 * The host half of an address, in the one spelling every comparison here uses.
 *
 * The trailing root dot is the spelling that matters. `users.noreply.api.example.`
 * and `users.noreply.api.example` are the same DNS name and every mail transport
 * resolves them to one mailbox, so a raw string comparison would let the FQDN
 * form sit on the reserved domain while reading as some other host — the guard
 * below is exactly the code an attacker would aim that at.
 */
function canonicalizeEmailHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  let end = host.length;
  while (end > 0 && host[end - 1] === ".") end -= 1;
  return host.slice(0, end);
}

/**
 * Whether a stored address occupies the reserved wallet-email namespace, and
 * must therefore be treated as absent everywhere in the OIDC layer.
 *
 * Without this a squatting attack works: the synthesized address is computable
 * by anyone who knows the victim's public wallet address, and `users.email` is a
 * unique, user-settable column. An attacker who writes the victim's synthesized
 * address into their own row and signs in at any client that does not require a
 * verified email would have a relying party create an account holding it —
 * locking the victim out and publishing git commits whose author address
 * resolves to the victim's wallet.
 *
 * Three arms, and the first two exist because a reservation that tracked only
 * the CURRENTLY configured domain would be undone by the operator action most
 * likely to follow an incident: changing `OIDC_ISSUER_URL` or
 * `OIDC_WALLET_EMAIL_DOMAIN`. Every address this provider has already issued
 * stays computable forever, so a rotation that narrowed the guard would
 * retroactively un-reserve all of them while the relying-party accounts keyed on
 * them still exist.
 *
 *  1. The synthesized LOCAL PART on any domain. This is the shape an attacker
 *     can compute, so it is reserved wherever it appears, including on a domain
 *     this deployment no longer configures.
 *  2. The `users.noreply.` subtree, whoever the issuer is. That label pair is
 *     what `resolveOidcWalletEmailDomain` derives for every issuer, so it covers
 *     an arbitrary local part on a domain a previous issuer minted on.
 *  3. The configured domain and everything below it, as before.
 *
 * Treating such a row as having no address is not a behaviour regression: a
 * no-reply domain accepts no mail by construction, so no address on one can ever
 * have been verified by delivery. That reasoning is what makes arms 1 and 2 safe
 * to apply beyond this deployment's own names — a `users.noreply.` address
 * issued by somebody else (GitHub's, say) is equally undeliverable and equally
 * unprovable, and an address in this provider's `wallet-<32 hex>` shape is not
 * one a human picks. Such a row keeps working everywhere else in Eliza Cloud; it
 * simply cannot be presented to a relying party as a proven mailbox.
 */
export function isOidcWalletEmailAddress(
  email: string | null | undefined,
  domain: string | null,
): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const host = canonicalizeEmailHost(email.slice(at + 1));
  if (!host) return false;

  // Folded, because every consumer that keys on an address folds it: Forgejo
  // keeps `lower_email`, so `WALLET-D4F3…` and `wallet-d4f3…` are one account
  // there and must be one reservation here.
  const local = email.slice(0, at).trim().toLowerCase();
  if (SYNTHESIZED_LOCAL_PART_RE.test(local)) return true;

  if (host === OIDC_WALLET_EMAIL_SUBDOMAIN || host.startsWith(`${OIDC_WALLET_EMAIL_SUBDOMAIN}.`)) {
    return true;
  }

  if (!domain) return false;
  const reserved = canonicalizeEmailHost(domain);
  if (!reserved) return false;
  return host === reserved || host.endsWith(`.${reserved}`);
}
