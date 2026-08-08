/**
 * Unit coverage for the discovery document against a real `OidcConfig`. Pure
 * input to output, no harness.
 *
 * The advertised signing set is the contract a relying party pins its verifier
 * to, so the cases below are the ways that set can be wrong: an algorithm this
 * provider signs with but does not advertise, an algorithm no verifier will
 * accept, and a document that names none at all.
 */

import { describe, expect, test } from "bun:test";

import { resolveOidcConfig } from "./config";
import { buildOidcDiscoveryDocument } from "./metadata";

const config = resolveOidcConfig({
  OIDC_ENABLED: "true",
  OIDC_ISSUER_URL: "https://api.elizacloud.test",
  ELIZA_CLOUD_URL: "https://console.elizacloud.test",
});
if (!config) throw new Error("test config did not resolve");

function algorithms(ring: string[]): string[] {
  return buildOidcDiscoveryDocument(config as NonNullable<typeof config>, ring)
    .id_token_signing_alg_values_supported;
}

describe("id_token_signing_alg_values_supported", () => {
  test("advertises the ring's algorithms, deduplicated and signer-first", () => {
    // Order is the ring's, so the active signer's algorithm leads; a retired
    // key's algorithm has to stay listed or a pinned verifier rejects the
    // tokens it signed before the rotation.
    expect(algorithms(["RS256", "PS256", "RS256"])).toEqual(["RS256", "PS256"]);
  });

  test("RS256 is advertised even when the ring holds no RSA key", () => {
    // OpenID Connect Discovery makes RS256 mandatory to advertise, and a
    // relying party restricted to it must still be able to configure this OP.
    expect(algorithms(["ES256"])).toEqual(["ES256", "RS256"]);
  });

  test("`none` is refused rather than advertised as acceptable", () => {
    // An `alg: none` entry would tell relying parties that an UNSIGNED ID token
    // is one this provider issues.
    expect(() => algorithms(["none"])).toThrow(/none/);
    expect(() => algorithms(["RS256", "none"])).toThrow(/none/);
  });

  test("an empty ring refuses to produce a document", () => {
    // Advertising no algorithm pins a relying party to a provider whose tokens
    // it can never accept; the route turns this into oidc_not_configured.
    expect(() => algorithms([])).toThrow(/no algorithm/);
  });
});

describe("advertised capabilities", () => {
  test("prompt_values_supported names only the value the provider honors", () => {
    const document = buildOidcDiscoveryDocument(config, ["RS256"]);
    expect(document.prompt_values_supported).toEqual(["none"]);
  });

  test("auth_time is not advertised — nothing here can source it", () => {
    const document = buildOidcDiscoveryDocument(config, ["RS256"]);
    expect(document.claims_supported).not.toContain("auth_time");
  });

  test("eliza_email_source is advertised, and is therefore reserved from constant_claims", () => {
    // `clients.ts` builds RESERVED_CLAIM_NAMES from this list, so advertising the
    // claim is also what stops an operator registering a constant that the
    // provider would then silently override.
    const document = buildOidcDiscoveryDocument(config, ["RS256"]);
    expect(document.claims_supported).toContain("eliza_email_source");
  });

  test("operator-registered constant claims are added once", () => {
    const document = buildOidcDiscoveryDocument(config, ["RS256"], ["tenant", "tenant", "sub"]);
    expect(document.claims_supported.filter((c) => c === "tenant")).toHaveLength(1);
    expect(document.claims_supported.filter((c) => c === "sub")).toHaveLength(1);
  });
});
