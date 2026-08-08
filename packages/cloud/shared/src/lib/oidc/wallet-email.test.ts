/**
 * Derivation rules for the wallet-backed no-reply identity, exercised through
 * the real functions with literal inputs. Pure, deterministic, no Worker, no
 * database, real WebCrypto.
 *
 * The cases are the ways this can silently produce a WRONG identity rather than
 * no identity: two distinct wallets folding onto one address (which is an
 * account takeover at a relying party that keys on the address), a domain the
 * deployment does not own (which makes the address registerable by somebody
 * else), and an address that a case-folding or length-limiting consumer would
 * rewrite on the way in.
 */

import { describe, expect, test } from "bun:test";

import {
  isOidcWalletEmailAddress,
  OIDC_WALLET_EMAIL_LOCAL_PREFIX,
  resolveOidcWalletEmailDomain,
  synthesizeOidcWalletEmail,
} from "./wallet-email";

const DOMAIN = "users.noreply.api.elizacloud.ai";
const EVM = "0x1234567890abcdef1234567890abcdef12345678";
/** The same wallet as `EVM`, in the EIP-55 form some writers store. */
const EVM_CHECKSUMMED = "0x1234567890AbcdEF1234567890aBcdef12345678";
/** Solana base58, which is case-SENSITIVE: folding it names a different key. */
const SOLANA = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";

function localPart(address: string): string {
  return address.slice(0, address.lastIndexOf("@"));
}

describe("address derivation", () => {
  test("is deterministic across calls for the same wallet", async () => {
    const first = await synthesizeOidcWalletEmail(EVM, DOMAIN);
    const second = await synthesizeOidcWalletEmail(EVM, DOMAIN);
    expect(first).toBe(second);
    // Forgejo turns this into a permanent account identity, so the exact bytes
    // are the contract — a change here re-identifies every wallet account.
    expect(first).toBe("wallet-d4f3c344e6eb25da702fd567072f6ce1@users.noreply.api.elizacloud.ai");
  });

  test("two different wallets never collide", async () => {
    const addresses = await Promise.all(
      [EVM, `${EVM.slice(0, -1)}9`, SOLANA, "0x0000000000000000000000000000000000000000"].map(
        (wallet) => synthesizeOidcWalletEmail(wallet, DOMAIN),
      ),
    );
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  test("a base58 case difference survives, because folding it would MERGE two wallets", async () => {
    // `7xKX…AsU` and `7xkx…asu` are different Solana keys. Case-folding the
    // digest input would map two distinct wallets onto one address, which at a
    // relying party keyed on the address is an account takeover.
    const upper = await synthesizeOidcWalletEmail(SOLANA, DOMAIN);
    const lower = await synthesizeOidcWalletEmail(SOLANA.toLowerCase(), DOMAIN);
    expect(upper).not.toBe(lower);
  });

  test("an EVM case difference does NOT survive, because it is one wallet", async () => {
    // The writers disagree about form: `/api/users/me/wallet/attach` and the
    // SIWE signup store an EIP-55 address lowercased, a Steward claim arrives in
    // whatever case Steward sent. Digesting the stored bytes would hand one
    // wallet two permanent identities depending on which surface wrote the row
    // last, so the input is canonicalized by the same `normalizeWallet` that
    // feeds `users.wallet_address_blind_index`.
    expect(await synthesizeOidcWalletEmail(EVM_CHECKSUMMED, DOMAIN)).toBe(
      await synthesizeOidcWalletEmail(EVM, DOMAIN),
    );
    expect(await synthesizeOidcWalletEmail(EVM.toUpperCase().replace("0X", "0x"), DOMAIN)).toBe(
      await synthesizeOidcWalletEmail(EVM, DOMAIN),
    );
  });

  test("surrounding whitespace is not a second wallet", async () => {
    expect(await synthesizeOidcWalletEmail(`  ${SOLANA} `, DOMAIN)).toBe(
      await synthesizeOidcWalletEmail(SOLANA, DOMAIN),
    );
  });

  test("the emitted address is a fixed point under case folding", async () => {
    // Forgejo/Gitea keeps a `lower_email` column for uniqueness, so an address
    // that was not already lowercase would be rewritten on the way in and stop
    // matching what this provider emits on the next login.
    const address = await synthesizeOidcWalletEmail(SOLANA, DOMAIN);
    expect(address).toBe(address.toLowerCase());
  });

  test("the local part is prefixed, hex, and inside RFC 5321's 64-octet limit", async () => {
    const address = await synthesizeOidcWalletEmail(EVM, DOMAIN);
    const local = localPart(address);
    expect(local.startsWith(OIDC_WALLET_EMAIL_LOCAL_PREFIX)).toBe(true);
    expect(local).toMatch(/^wallet-[0-9a-f]{32}$/);
    expect(local.length).toBeLessThanOrEqual(64);
    expect(address.length).toBeLessThanOrEqual(254);
  });

  test("the raw wallet address never appears in the emitted identity", async () => {
    // Git commit metadata is permanent and public; the address would publish a
    // wallet-to-commit-history link forever.
    const address = await synthesizeOidcWalletEmail(EVM, DOMAIN);
    expect(address).not.toContain(EVM);
    expect(address.toLowerCase()).not.toContain(EVM.slice(2, 12).toLowerCase());
  });
});

describe("the default domain", () => {
  test("is users.noreply.<issuer hostname>", () => {
    expect(resolveOidcWalletEmailDomain("api.elizacloud.ai")).toEqual({
      ok: true,
      domain: DOMAIN,
    });
  });

  test("takes the HOSTNAME, so a loopback port never lands in a domain", () => {
    // `OidcConfig.issuerHost` carries `localhost:8787`, which is not a legal
    // email domain. `localhost` is a reserved TLD that routes nowhere, so the
    // derived name is usable for local development.
    expect(resolveOidcWalletEmailDomain("localhost")).toEqual({
      ok: true,
      domain: "users.noreply.localhost",
    });
  });

  test("is unavailable — not wrong — when the issuer is an IP literal", () => {
    // An address literal has no DNS subtree this deployment can own, so there is
    // no honest default. `null` refuses every wallet-only sign-in with a reason.
    for (const host of ["127.0.0.1", "[::1]", "192.168.0.10"]) {
      expect(resolveOidcWalletEmailDomain(host)).toEqual({ ok: true, domain: null });
    }
  });
});

describe("an OIDC_WALLET_EMAIL_DOMAIN override", () => {
  test("is accepted only as a strict subdomain of the issuer hostname", () => {
    expect(resolveOidcWalletEmailDomain("api.elizacloud.ai", "noreply.api.elizacloud.ai")).toEqual({
      ok: true,
      domain: "noreply.api.elizacloud.ai",
    });
    expect(resolveOidcWalletEmailDomain("api.elizacloud.ai", DOMAIN)).toEqual({
      ok: true,
      domain: DOMAIN,
    });
  });

  test("refuses a domain the deployment cannot prove it owns", () => {
    // The whole guarantee is that no user can register a name there. A public
    // mail domain, a sibling, a parent, and the issuer hostname itself all fail
    // that test — the parent because the issuer proves nothing about names
    // ABOVE it, and the hostname itself because it is not a dedicated subtree.
    for (const override of [
      "gmail.com",
      "users.noreply.github.com",
      "users.noreply.elizacloud.ai",
      "api.elizacloud.ai",
      "evil-api.elizacloud.ai",
      "api.elizacloud.ai.attacker.example",
    ]) {
      const checked = resolveOidcWalletEmailDomain("api.elizacloud.ai", override);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.reason).toMatch(/strict subdomain|unusable DNS label/);
    }
  });

  test("refuses a name that is not a bare lowercase DNS domain", () => {
    for (const override of [
      "Users.Noreply.api.elizacloud.ai",
      "https://users.noreply.api.elizacloud.ai",
      "users noreply.api.elizacloud.ai",
      "-bad.api.elizacloud.ai",
      "x@users.noreply.api.elizacloud.ai",
      `${"a".repeat(210)}.api.elizacloud.ai`,
    ]) {
      const checked = resolveOidcWalletEmailDomain("api.elizacloud.ai", override);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.reason).toContain("OIDC_WALLET_EMAIL_DOMAIN");
    }
  });

  test("cannot be a subdomain of an IP-literal issuer either", () => {
    expect(resolveOidcWalletEmailDomain("127.0.0.1", "users.noreply.127.0.0.1").ok).toBe(false);
  });

  test("an empty or whitespace value falls back to the derived default", () => {
    expect(resolveOidcWalletEmailDomain("api.elizacloud.ai", "   ")).toEqual({
      ok: true,
      domain: DOMAIN,
    });
    expect(resolveOidcWalletEmailDomain("api.elizacloud.ai", null)).toEqual({
      ok: true,
      domain: DOMAIN,
    });
  });
});

describe("the reserved-domain guard", () => {
  test("recognizes a stored email squatting the synthesized domain", async () => {
    const synthesized = await synthesizeOidcWalletEmail(EVM, DOMAIN);
    expect(isOidcWalletEmailAddress(synthesized, DOMAIN)).toBe(true);
    // The attack is not limited to a well-formed synthesized address: any
    // address on the domain is unverifiable, so any address on it is refused.
    expect(isOidcWalletEmailAddress("anything@users.noreply.api.elizacloud.ai", DOMAIN)).toBe(true);
    expect(isOidcWalletEmailAddress("MiXeD@Users.Noreply.API.elizacloud.ai", DOMAIN)).toBe(true);
    expect(isOidcWalletEmailAddress("a@sub.users.noreply.api.elizacloud.ai", DOMAIN)).toBe(true);
  });

  test("leaves every real address alone", () => {
    for (const email of [
      "ada@example.com",
      "ada@elizacloud.ai",
      "ada@api.elizacloud.ai",
      "users.noreply.api.elizacloud.ai@example.com",
      "ada@notusers.noreply.api.elizacloud.ai",
      "wallet-not-a-digest@example.com",
      "wallet-d4f3c344e6eb25da702fd567072f6ce@example.com",
      "",
      null,
      undefined,
    ]) {
      expect(isOidcWalletEmailAddress(email, DOMAIN)).toBe(false);
    }
  });

  test("the FQDN trailing dot is the same host, not a way past the guard", () => {
    // `users.noreply.api.elizacloud.ai.` and `users.noreply.api.elizacloud.ai`
    // resolve to one mailbox everywhere mail is delivered. Comparing the raw
    // string would have let the root-dot spelling sit on the reserved domain
    // while reading here as some unrelated host.
    expect(isOidcWalletEmailAddress(`squat@${DOMAIN}.`, DOMAIN)).toBe(true);
    expect(isOidcWalletEmailAddress(`squat@${DOMAIN}..`, DOMAIN)).toBe(true);
    expect(isOidcWalletEmailAddress(`squat@sub.${DOMAIN}.`, DOMAIN)).toBe(true);
    expect(isOidcWalletEmailAddress(`  squat@${DOMAIN.toUpperCase()}.  `, DOMAIN)).toBe(true);
    // And it does not sweep in an address that merely ends with a dot.
    expect(isOidcWalletEmailAddress("ada@example.com.", DOMAIN)).toBe(false);
  });

  test("stays reserved after the domain that issued it stops being configured", async () => {
    // The squat guard cannot depend on the CURRENT configuration. Every address
    // this provider has issued stays computable forever, and the relying-party
    // accounts keyed on them keep existing, so an issuer or
    // OIDC_WALLET_EMAIL_DOMAIN change must not retroactively un-reserve them —
    // that rotation is the operator action most likely to FOLLOW an incident.
    const issued = await synthesizeOidcWalletEmail(EVM, DOMAIN);
    const rotated = "noreply.api2.elizacloud.ai";
    expect(isOidcWalletEmailAddress(issued, rotated)).toBe(true);
    expect(isOidcWalletEmailAddress(issued, null)).toBe(true);
    // The whole `users.noreply.` subtree too, whichever issuer minted it, so an
    // arbitrary local part on a previous default domain is refused as well.
    expect(isOidcWalletEmailAddress("anything@users.noreply.api.elizacloud.ai", null)).toBe(true);
    expect(isOidcWalletEmailAddress("anything@users.noreply.other.example", rotated)).toBe(true);
    // The synthesized LOCAL PART is reserved wherever it appears: that string is
    // what an attacker computes, and no human picks it as a mailbox name.
    expect(
      isOidcWalletEmailAddress("wallet-d4f3c344e6eb25da702fd567072f6ce1@example.com", null),
    ).toBe(true);
    expect(
      isOidcWalletEmailAddress("WALLET-D4F3C344E6EB25DA702FD567072F6CE1@example.com", DOMAIN),
    ).toBe(true);
  });

  test("guards the reserved shape when no domain is configured, and nothing else", () => {
    // An IP-literal issuer hosts no wallet-email domain, but a row squatting an
    // address a PREVIOUS issuer minted is still a squat.
    expect(isOidcWalletEmailAddress("ada@example.com", null)).toBe(false);
    expect(isOidcWalletEmailAddress("ada@api.elizacloud.ai", null)).toBe(false);
    expect(isOidcWalletEmailAddress("a@users.noreply.api.elizacloud.ai", null)).toBe(true);
  });
});
