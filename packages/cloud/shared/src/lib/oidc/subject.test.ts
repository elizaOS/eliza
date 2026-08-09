/**
 * The admission gate for the OpenID Provider: which accounts may become an
 * identity at a relying party. Real `assertOidcSubjectEligible` against
 * constructed row literals — pure decision function, no database, no Worker.
 *
 * The matrix that matters is verified email / unverified email / verified wallet
 * / unverified wallet crossed with the per-client opt-in, because each cell is a
 * different kind of mistake: admitting an unverified wallet would hand out an
 * identity backed by nothing, and refusing a verified one is the lock-out this
 * change exists to fix. The last case is the squatting row — a stored address on
 * the reserved wallet-email domain, which `loadOidcSubject` neutralizes before
 * this function ever sees it, asserted here through the shape it produces.
 *
 * `readVerifiedWalletAddress` is the other half and is tested directly: it
 * decides which rows are even offered to the gate, and the rows it must refuse
 * are shapes real writers produce, not hypotheticals.
 */

import { describe, expect, test } from "bun:test";

import type { UserWithOrganization } from "../../db/repositories/users";
import { resolveOidcEmailIdentity } from "./claims";
import type { OidcClient } from "./clients";
import {
  assertOidcSubjectEligible,
  hasUsableOidcEmailIdentity,
  type OidcSubject,
  readVerifiedWalletAddress,
} from "./subject";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WALLET_EMAIL = "wallet-d4f3c344e6eb25da702fd567072f6ce1@users.noreply.api.elizacloud.ai";

function makeSubject(overrides: {
  user?: Partial<UserWithOrganization>;
  walletEmail?: string | null;
}): OidcSubject {
  return {
    user: {
      id: USER_ID,
      email: "ada@example.com",
      email_verified: true,
      wallet_address: null,
      wallet_chain_type: null,
      wallet_verified: false,
      is_anonymous: false,
      is_active: true,
      deleted_at: null,
      organization: null,
      ...overrides.user,
    } as UserWithOrganization,
    profile: null,
    adminStatus: { isAdmin: false, role: null, implicit: false },
    walletEmail: overrides.walletEmail ?? null,
  };
}

function makeClient(overrides: Partial<OidcClient> = {}): OidcClient {
  return {
    client_id: "elizahub-forgejo",
    name: "Eliza Hub",
    secret_hashes: ["0".repeat(64)],
    redirect_uris: ["https://hub.example/user/oauth2/elizacloud/callback"],
    allowed_scopes: ["openid", "email", "profile", "groups"],
    resource_audiences: [],
    require_pkce: false,
    require_verified_email: true,
    wallet_email_fallback: false,
    roles_allowlist: [],
    claims_policy: { groups: true, roles: true, tenant_id: true, eliza_agents: false },
    claims_mapping: { roles: {}, groups: {}, mode: "extend" },
    constant_claims: {},
    id_token_ttl_seconds: 300,
    access_token_ttl_seconds: 300,
    ...overrides,
  };
}

const WALLET_ONLY = {
  user: {
    email: null,
    email_verified: false,
    wallet_address: "0xabc",
    wallet_chain_type: "evm",
    wallet_verified: true,
  },
  walletEmail: WALLET_EMAIL,
};

describe("the account checks that run before any email rule", () => {
  test("anonymous, inactive, soft-deleted, and dead-org rows are refused first", () => {
    const client = makeClient({ wallet_email_fallback: true });
    expect(assertOidcSubjectEligible(makeSubject({ user: { is_anonymous: true } }), client)).toBe(
      "user_anonymous",
    );
    expect(assertOidcSubjectEligible(makeSubject({ user: { is_active: false } }), client)).toBe(
      "user_inactive",
    );
    expect(
      assertOidcSubjectEligible(makeSubject({ user: { deleted_at: new Date() } }), client),
    ).toBe("user_inactive");
    expect(
      assertOidcSubjectEligible(
        makeSubject({ user: { organization: { is_active: false } as never } }),
        client,
      ),
    ).toBe("organization_inactive");
  });

  test("a verified wallet does not rescue an account that failed one of them", () => {
    const client = makeClient({ wallet_email_fallback: true });
    expect(
      assertOidcSubjectEligible(
        makeSubject({ ...WALLET_ONLY, user: { ...WALLET_ONLY.user, is_anonymous: true } }),
        client,
      ),
    ).toBe("user_anonymous");
  });
});

describe("a client that did not opt in", () => {
  const client = makeClient();

  test("admits a verified email exactly as before", () => {
    expect(assertOidcSubjectEligible(makeSubject({}), client)).toBeNull();
  });

  test("refuses a wallet-only user with the original reason string", () => {
    // The reason travels to the relying party and into the audit log; changing
    // it for a registration that did not opt in would be a behaviour change.
    expect(assertOidcSubjectEligible(makeSubject(WALLET_ONLY), client)).toBe("email_unverified");
  });

  test("refuses an unverified email exactly as before", () => {
    expect(
      assertOidcSubjectEligible(makeSubject({ user: { email_verified: false } }), client),
    ).toBe("email_unverified");
  });

  test("does not consider the wallet identity usable at all", () => {
    expect(hasUsableOidcEmailIdentity(makeSubject(WALLET_ONLY), client)).toBe(false);
  });
});

describe("a client with wallet_email_fallback", () => {
  const client = makeClient({ wallet_email_fallback: true });

  test("admits a wallet-only user whose wallet is verified", () => {
    expect(assertOidcSubjectEligible(makeSubject(WALLET_ONLY), client)).toBeNull();
    expect(hasUsableOidcEmailIdentity(makeSubject(WALLET_ONLY), client)).toBe(true);
  });

  test("still refuses an UNVERIFIED wallet — an address proves nothing on its own", () => {
    // `loadOidcSubject` produces no walletEmail without `wallet_verified`, which
    // is what this cell asserts: the gate cannot be reached by storing a string.
    const subject = makeSubject({
      user: { email: null, email_verified: false, wallet_address: "0xabc", wallet_verified: false },
      walletEmail: null,
    });
    expect(assertOidcSubjectEligible(subject, client)).toBe("no_verified_identity");
  });

  test("refuses a user with neither a verified email nor any wallet", () => {
    const subject = makeSubject({ user: { email: null, email_verified: false } });
    expect(assertOidcSubjectEligible(subject, client)).toBe("no_verified_identity");
  });

  test("refuses when the deployment hosts no wallet-email domain", () => {
    // IP-literal issuer: the wallet is verified but there is no domain to mint
    // an address on, so there is nothing to admit the user with.
    const subject = makeSubject({ ...WALLET_ONLY, walletEmail: null });
    expect(assertOidcSubjectEligible(subject, client)).toBe("no_verified_identity");
  });

  test("changes nothing for a user who has a real verified email", () => {
    expect(assertOidcSubjectEligible(makeSubject({}), client)).toBeNull();
  });

  test("refuses an UNCONFIRMED stored address even when the wallet is verified", () => {
    // Admission is asked of the identity that will actually be EMITTED, and a
    // stored address takes precedence over the wallet. Admitting here would hand
    // a client that demanded a verified email an address nobody proved — the
    // collision the requirement exists to prevent — because the wallet address
    // is not what this subject's token would carry.
    const subject = makeSubject({
      user: {
        email: "ada@example.com",
        email_verified: false,
        wallet_address: "0xabc",
        wallet_chain_type: "evm",
        wallet_verified: true,
      },
      walletEmail: WALLET_EMAIL,
    });
    expect(hasUsableOidcEmailIdentity(subject, client)).toBe(false);
    // The address is unconfirmed, and confirming it is the fix — so the reason
    // is the one that says so, not the one that says there is no identity.
    expect(assertOidcSubjectEligible(subject, client)).toBe("email_unverified");
  });

  test("admission implies emission: every admitted subject has an address to send", () => {
    // The two were separate expressions and could disagree, which is how an
    // opted-in client came to admit a subject and then receive a token with no
    // `email` at all. Asserted over the whole matrix rather than a single row.
    for (const email of [null, "ada@example.com"]) {
      for (const emailVerified of [true, false]) {
        for (const walletEmail of [null, WALLET_EMAIL]) {
          const subject = makeSubject({
            user: { email, email_verified: emailVerified },
            walletEmail,
          });
          if (!hasUsableOidcEmailIdentity(subject, client)) continue;
          const identity = resolveOidcEmailIdentity(subject.user, walletEmail, client);
          expect(identity.email).not.toBeNull();
        }
      }
    }
  });
});

describe("which rows carry a wallet identity at all", () => {
  type WalletRow = Parameters<typeof readVerifiedWalletAddress>[0];

  function row(overrides: Partial<WalletRow> = {}): WalletRow {
    return {
      wallet_address: "0x1234567890abcdef1234567890abcdef12345678",
      wallet_chain_type: "evm",
      wallet_verified: true,
      ...overrides,
    } as WalletRow;
  }

  test("accepts every chain type a wallet-binding path records", () => {
    // `evm` from /api/users/me/wallet/attach and the SIWE signup, `solana` from
    // the SIWS signup and from a Steward claim, `ethereum` from a Steward claim.
    for (const chain of ["evm", "ethereum", "solana"]) {
      expect(readVerifiedWalletAddress(row({ wallet_chain_type: chain }))).toBe(
        "0x1234567890abcdef1234567890abcdef12345678",
      );
    }
  });

  test("refuses a verified flag with NO chain type — the service-bridge shape", () => {
    // `lib/auth/waifu-bridge.ts` provisioned rows from an address SUBSTRING of a
    // service token's subject: whoever holds the shared secret picks the
    // address, including a victim's public one. That path now records
    // `wallet_verified: false`, and this is the second lock: a row with no
    // recorded chain type has no recorded provenance, so it is not an identity
    // even if some later writer flips the flag.
    expect(readVerifiedWalletAddress(row({ wallet_chain_type: null }))).toBeNull();
    expect(readVerifiedWalletAddress(row({ wallet_chain_type: "" }))).toBeNull();
    expect(readVerifiedWalletAddress(row({ wallet_chain_type: "   " }))).toBeNull();
    expect(readVerifiedWalletAddress(row({ wallet_chain_type: "waifu" }))).toBeNull();
  });

  test("refuses an unverified wallet whatever else the row says", () => {
    expect(readVerifiedWalletAddress(row({ wallet_verified: false }))).toBeNull();
  });

  test("refuses an absent or blank address", () => {
    expect(readVerifiedWalletAddress(row({ wallet_address: null }))).toBeNull();
    expect(readVerifiedWalletAddress(row({ wallet_address: "   " }))).toBeNull();
  });

  test("returns the stored address, leaving canonicalization to the digest", () => {
    // Base58 is case-sensitive, so nothing here may fold the address; the digest
    // applies the chain-shaped rule once, in `synthesizeOidcWalletEmail`.
    const solana = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
    expect(
      readVerifiedWalletAddress(row({ wallet_address: solana, wallet_chain_type: "solana" })),
    ).toBe(solana);
  });
});

describe("a stored email squatting the reserved wallet-email domain", () => {
  test("counts for nothing, because loadOidcSubject strips it before the gate", () => {
    // The attacker's row reaches this function with BOTH fields cleared — the
    // guard is unconditional, so the squat cannot be laundered through a client
    // that does not require a verified email either. `email_verified` is cleared
    // beside the address rather than left behind: a lingering `true` would be an
    // assertion about a mailbox the same token declines to name.
    const stripped = makeSubject({
      user: { email: null, email_verified: false, wallet_address: null, wallet_verified: false },
    });
    expect(hasUsableOidcEmailIdentity(stripped, makeClient())).toBe(false);
    expect(assertOidcSubjectEligible(stripped, makeClient())).toBe("email_unverified");
    expect(assertOidcSubjectEligible(stripped, makeClient({ wallet_email_fallback: true }))).toBe(
      "no_verified_identity",
    );
  });
});
