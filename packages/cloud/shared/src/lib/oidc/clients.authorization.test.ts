/**
 * Runtime authorization for the OpenID Connect provider: redirect-URI matching,
 * client-secret verification across a rotation window, and scope intersection.
 *
 * These are the three decisions made on every authorize/token request, and the
 * first two are the classic OIDC attack surface — a redirect matcher that
 * normalizes or prefix-matches hands an attacker the authorization code, and a
 * secret check that stops at the first hash leaks which one is current.
 *
 * `isRegisteredRedirectUri` documents "Exact string equality — no
 * normalization, no prefix, no wildcard", so each of those three is asserted
 * separately rather than through one "rejects a bad URI" case.
 *
 * Registry entries are loaded through the real `OIDC_CLIENTS` parse path; no
 * mocks.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  _resetOidcClientCacheForTests,
  getOidcClient,
  intersectScopes,
  isOidcClientRegistryConfigured,
  isRegisteredRedirectUri,
  listOidcClients,
  type OidcClient,
  verifyOidcClientSecret,
} from "./clients";
import { sha256Hex } from "./crypto";

const CLIENT_ID = "elizahub-forgejo";
const CALLBACK = "https://hub.example/user/oauth2/elizacloud/callback";

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_secret_sha256: "a".repeat(64),
    redirect_uris: [CALLBACK],
    allowed_scopes: ["openid", "email", "profile", "groups"],
    claims_policy: { groups: true, roles: true, tenant_id: true, eliza_agents: false },
    ...overrides,
  };
}

/** Loads a registry the way the Worker does, then returns the parsed client. */
function loadClient(overrides: Record<string, unknown> = {}): OidcClient {
  process.env.OIDC_CLIENTS = JSON.stringify([entry(overrides)]);
  _resetOidcClientCacheForTests();
  const client = getOidcClient(CLIENT_ID);
  if (!client) throw new Error("fixture registry failed to load");
  return client;
}

afterEach(() => {
  delete process.env.OIDC_CLIENTS;
  delete process.env.OIDC_REDIRECT_URI_ALIASES;
  _resetOidcClientCacheForTests();
});

describe("isRegisteredRedirectUri is exact string equality", () => {
  test("accepts only the byte-identical registered callback", () => {
    const client = loadClient();
    expect(isRegisteredRedirectUri(client, CALLBACK)).toBe(true);
  });

  test("rejects an absent redirect_uri instead of defaulting to the registered one", () => {
    const client = loadClient();
    expect(isRegisteredRedirectUri(client, null)).toBe(false);
    expect(isRegisteredRedirectUri(client, "")).toBe(false);
  });

  test("no prefix matching: a registered callback is not a namespace", () => {
    const client = loadClient();
    for (const attacker of [
      `${CALLBACK}/../../evil`,
      `${CALLBACK}/evil`,
      `${CALLBACK}.evil.example`,
      `${CALLBACK}?next=https://evil.example`,
      `${CALLBACK}#evil`,
    ]) {
      expect(isRegisteredRedirectUri(client, attacker)).toBe(false);
    }
  });

  test("no normalization: trailing slash, case and encoding all differ", () => {
    const client = loadClient();
    for (const variant of [
      `${CALLBACK}/`,
      CALLBACK.replace("hub.example", "HUB.EXAMPLE"),
      CALLBACK.replace("https://", "HTTPS://"),
      CALLBACK.replace("/callback", "/call%62ack"),
      CALLBACK.replace("https://hub.example", "https://hub.example:443"),
    ]) {
      expect(isRegisteredRedirectUri(client, variant)).toBe(false);
    }
  });

  test("no wildcards: a wildcard redirect_uri is refused by the registry itself", () => {
    // Stronger than the matcher being exact — an operator cannot register a
    // wildcard at all, so the open-redirector shape never reaches the matcher.
    expect(() => loadClient({ redirect_uris: ["*"] })).toThrow(/redirect_uri/i);
  });

  test("a URL-shaped glob registers, but matches only itself", () => {
    // `https://hub.example/*` is a syntactically valid URL, so the registry
    // accepts it. The matcher must still treat it as a literal path and not as
    // a pattern covering the callbacks beneath it.
    const glob = "https://hub.example/*";
    const client = loadClient({ redirect_uris: [glob] });
    expect(isRegisteredRedirectUri(client, glob)).toBe(true);
    expect(isRegisteredRedirectUri(client, CALLBACK)).toBe(false);
    expect(isRegisteredRedirectUri(client, "https://hub.example/anything")).toBe(false);
  });

  test("every registered callback matches, not only the first", () => {
    const second = "https://hub.example/other/callback";
    const client = loadClient({ redirect_uris: [CALLBACK, second] });
    expect(isRegisteredRedirectUri(client, CALLBACK)).toBe(true);
    expect(isRegisteredRedirectUri(client, second)).toBe(true);
  });
});

describe("verifyOidcClientSecret", () => {
  const SECRET = "correct-horse-battery-staple";
  const OTHER = "rotated-next-secret";

  test("accepts the secret behind the registered digest", async () => {
    const client = loadClient({ client_secret_sha256: await sha256Hex(SECRET) });
    expect(await verifyOidcClientSecret(client, SECRET)).toBe(true);
  });

  test("rejects a wrong secret, and an absent one without hashing", async () => {
    const client = loadClient({ client_secret_sha256: await sha256Hex(SECRET) });
    expect(await verifyOidcClientSecret(client, `${SECRET}x`)).toBe(false);
    expect(await verifyOidcClientSecret(client, "")).toBe(false);
    expect(await verifyOidcClientSecret(client, null)).toBe(false);
    expect(await verifyOidcClientSecret(client, undefined)).toBe(false);
  });

  test("a rotation window accepts both the old and the new secret", async () => {
    // Order matters: the second listed digest must be reachable, which is what
    // makes a rotation window usable at all.
    const client = loadClient({
      client_secret_sha256: [await sha256Hex(SECRET), await sha256Hex(OTHER)],
    });
    expect(await verifyOidcClientSecret(client, SECRET)).toBe(true);
    expect(await verifyOidcClientSecret(client, OTHER)).toBe(true);
    expect(await verifyOidcClientSecret(client, "neither")).toBe(false);
  });

  test("the digest comparison is case-insensitive on the registered side only", async () => {
    // parseSecretHashes lowercases the registry value, so an operator pasting
    // an uppercase digest still works; the presented secret is never folded.
    const client = loadClient({ client_secret_sha256: (await sha256Hex(SECRET)).toUpperCase() });
    expect(await verifyOidcClientSecret(client, SECRET)).toBe(true);
    expect(await verifyOidcClientSecret(client, SECRET.toUpperCase())).toBe(false);
  });
});

describe("intersectScopes", () => {
  test("grants the intersection in the order the client requested", () => {
    const client = loadClient();
    expect(intersectScopes(client, ["profile", "openid", "email"])).toEqual([
      "profile",
      "openid",
      "email",
    ]);
  });

  test("drops scopes the registry did not allow rather than granting them", () => {
    const client = loadClient();
    expect(intersectScopes(client, ["openid", "eliza_agents", "admin"])).toEqual(["openid"]);
  });

  test("deduplicates a repeated request without reordering", () => {
    const client = loadClient();
    expect(intersectScopes(client, ["email", "openid", "email"])).toEqual(["email", "openid"]);
  });

  test("is a subset of the request, never the full allowlist", () => {
    // The canonical mistake is returning everything allowed when a narrow
    // request comes in; the result must never contain an unrequested scope.
    const client = loadClient();
    const granted = intersectScopes(client, ["openid"]);
    expect(granted).toEqual(["openid"]);
    expect(granted).not.toContain("profile");
    expect(intersectScopes(client, [])).toEqual([]);
  });
});

describe("registry presence helpers", () => {
  test("reports unconfigured when OIDC_CLIENTS is unset or blank", () => {
    delete process.env.OIDC_CLIENTS;
    _resetOidcClientCacheForTests();
    expect(isOidcClientRegistryConfigured()).toBe(false);
    process.env.OIDC_CLIENTS = "   ";
    _resetOidcClientCacheForTests();
    expect(isOidcClientRegistryConfigured()).toBe(false);
  });

  test("reports configured and lists every registered client once loaded", () => {
    loadClient();
    expect(isOidcClientRegistryConfigured()).toBe(true);
    const listed = listOidcClients();
    expect(listed.map((client) => client.client_id)).toEqual([CLIENT_ID]);
  });
});
