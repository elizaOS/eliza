/**
 * Registry-entry validation for the OpenID Connect provider, exercised through
 * the real parser (`parseOidcClientEntry`) with literal JSON — the same shape an
 * operator puts in the `OIDC_CLIENTS` secret. No environment, no mocks.
 *
 * The cases that matter are the ones that would otherwise load "successfully":
 * a policy the scope list silences, an allowlist or mapping keyed on a role this
 * provider cannot produce, a constant claim shadowing a derived one. Each emits
 * a token that verifies cleanly and is then rejected by the relying party for a
 * reason nothing here would log, so each must fail at parse time instead.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { _resetOidcClientCacheForTests, getOidcClient, parseOidcClientEntry } from "./clients";

const SECRET_HASH = "a".repeat(64);

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: "elizahub-forgejo",
    client_secret_sha256: SECRET_HASH,
    redirect_uris: ["https://hub.example/user/oauth2/elizacloud/callback"],
    allowed_scopes: ["openid", "email", "profile", "groups"],
    claims_policy: { groups: true, roles: true, tenant_id: true, eliza_agents: false },
    ...overrides,
  };
}

/**
 * Load a whole registry the way the Worker does. `getCloudAwareEnv()` falls
 * through to `process.env` outside a request, so this is the real load path —
 * memoized parse included, which is why the cache is dropped after each case.
 */
function loadRegistry(entries: Record<string, unknown>[]): void {
  process.env.OIDC_CLIENTS = JSON.stringify(entries);
  _resetOidcClientCacheForTests();
  getOidcClient(entries[0]?.client_id as string);
}

afterEach(() => {
  delete process.env.OIDC_CLIENTS;
  _resetOidcClientCacheForTests();
});

describe("defaults", () => {
  test("an entry with no mapping or constants parses to the identity behavior", () => {
    const client = parseOidcClientEntry(entry());
    expect(client.claims_mapping).toEqual({ roles: {}, groups: {}, mode: "extend" });
    expect(client.constant_claims).toEqual({});
    expect(client.resource_audiences).toEqual([]);
  });
});

describe("scope and claims_policy must agree", () => {
  test("granting roles without the groups scope that gates them is refused", () => {
    expect(() =>
      parseOidcClientEntry(
        entry({
          allowed_scopes: ["openid", "email", "profile"],
          claims_policy: { groups: false, roles: true, tenant_id: true, eliza_agents: false },
        }),
      ),
    ).toThrow(/groups.*scope/i);
  });

  test("allowing the groups scope while denying both claims is refused", () => {
    expect(() =>
      parseOidcClientEntry(
        entry({
          claims_policy: { groups: false, roles: false, tenant_id: true, eliza_agents: false },
        }),
      ),
    ).toThrow(/emits nothing/i);
  });

  test("a registry entry that simply omits claims_policy cannot ship silently", () => {
    // The default scope list includes `groups`; the default policy denies
    // everything. Left alone that pair issues tokens with no roles or groups.
    const { claims_policy: _policy, allowed_scopes: _scopes, ...rest } = entry();
    expect(() => parseOidcClientEntry(rest)).toThrow(/claims_policy/);
  });

  test("the eliza_agents scope and policy must be set together", () => {
    expect(() =>
      parseOidcClientEntry(entry({ allowed_scopes: ["openid", "groups", "eliza_agents"] })),
    ).toThrow(/eliza_agents/);
    expect(() =>
      parseOidcClientEntry(
        entry({
          claims_policy: { groups: true, roles: true, tenant_id: true, eliza_agents: true },
        }),
      ),
    ).toThrow(/eliza_agents/);
  });
});

describe("roles_allowlist", () => {
  test("a value this provider never emits is refused rather than filtering to nothing", () => {
    expect(() => parseOidcClientEntry(entry({ roles_allowlist: ["steward"] }))).toThrow(
      /not a role this provider emits/,
    );
  });

  test("an allowlist without the roles policy is refused", () => {
    expect(() =>
      parseOidcClientEntry(
        entry({
          roles_allowlist: ["org_owner"],
          claims_policy: { groups: true, roles: false, tenant_id: true, eliza_agents: false },
        }),
      ),
    ).toThrow(/roles_allowlist/);
  });

  test("native role values are accepted", () => {
    const client = parseOidcClientEntry(
      entry({ roles_allowlist: ["org_owner", "platform_super_admin"] }),
    );
    expect(client.roles_allowlist).toEqual(["org_owner", "platform_super_admin"]);
  });
});

describe("claims_mapping", () => {
  test("maps native roles and groups onto the relying party's vocabulary", () => {
    const client = parseOidcClientEntry(
      entry({
        claims_mapping: {
          mode: "replace",
          roles: { org_owner: ["steward", "maintainer"] },
          groups: { "eliza-cloud:users": ["eliza-team"] },
        },
      }),
    );
    expect(client.claims_mapping.mode).toBe("replace");
    expect(client.claims_mapping.roles.org_owner).toEqual(["steward", "maintainer"]);
    expect(client.claims_mapping.groups["eliza-cloud:users"]).toEqual(["eliza-team"]);
  });

  test("a mapping keyed on a role this provider cannot produce is refused", () => {
    expect(() =>
      parseOidcClientEntry(
        entry({ claims_mapping: { roles: { org_maintainer: ["maintainer"] }, groups: {} } }),
      ),
    ).toThrow(/not a role this provider emits/);
  });

  test("a mapping keyed on a group this provider cannot produce is refused", () => {
    // The failure mode this prevents: the key is the RP-side name (a target,
    // never a source) or a typo, the mapping matches nothing, and the token
    // arrives missing exactly the group the RP gates on. At Forgejo an absent
    // admin group demotes the user signing in.
    for (const key of ["eliza-admins", "eliza-agents", "eliza-cloud:admin"]) {
      expect(() =>
        parseOidcClientEntry(
          entry({ claims_mapping: { roles: {}, groups: { [key]: ["eliza-admins"] } } }),
        ),
      ).toThrow(/not a group this provider emits/);
    }
  });

  test("the group keys this provider does emit are accepted", () => {
    const client = parseOidcClientEntry(
      entry({
        claims_mapping: {
          roles: {},
          groups: {
            "eliza-cloud:users": ["eliza-team"],
            "eliza-cloud:admins": ["eliza-admins"],
            "eliza-cloud:agents": ["eliza-agents"],
            "eliza-cloud:services": ["eliza-agents"],
            "org:analytical-engines": ["engines"],
          },
        },
      }),
    );
    expect(client.claims_mapping.groups["eliza-cloud:agents"]).toEqual(["eliza-agents"]);
    expect(client.claims_mapping.groups["org:analytical-engines"]).toEqual(["engines"]);
  });

  test("a mapping for a claim the policy denies is refused", () => {
    expect(() =>
      parseOidcClientEntry(
        entry({
          claims_policy: { groups: true, roles: false, tenant_id: true, eliza_agents: false },
          claims_mapping: { roles: { org_owner: ["steward"] }, groups: {} },
        }),
      ),
    ).toThrow(/maps roles/);
  });

  test("replace with no mapping at all would empty both claims, so it is refused", () => {
    expect(() => parseOidcClientEntry(entry({ claims_mapping: { mode: "replace" } }))).toThrow(
      /would emit empty roles and groups/,
    );
  });

  test("an unknown mode is refused", () => {
    expect(() =>
      parseOidcClientEntry(
        entry({ claims_mapping: { mode: "merge", roles: { org_owner: ["steward"] } } }),
      ),
    ).toThrow(/extend.*replace/);
  });

  test("a target list must not be empty", () => {
    expect(() =>
      parseOidcClientEntry(entry({ claims_mapping: { roles: { org_owner: [] }, groups: {} } })),
    ).toThrow(/at least one value/);
  });
});

describe("constant_claims", () => {
  test("an operator-chosen name and value round-trips", () => {
    const client = parseOidcClientEntry(entry({ constant_claims: { tenant: "eliza" } }));
    expect(client.constant_claims).toEqual({ tenant: "eliza" });
  });

  test("a provider claim name is refused so a constant can never shadow identity", () => {
    for (const name of ["sub", "email", "email_verified", "roles", "groups", "tenant_id", "aud"]) {
      expect(() => parseOidcClientEntry(entry({ constant_claims: { [name]: "x" } }))).toThrow(
        /may not override the provider claim/,
      );
    }
  });

  test("the access-token envelope members are refused too", () => {
    for (const name of ["scope", "client_id", "jti", "nbf", "typ"]) {
      expect(() => parseOidcClientEntry(entry({ constant_claims: { [name]: "x" } }))).toThrow(
        /may not override the provider claim/,
      );
    }
  });

  test("an unusable claim name or empty value is refused", () => {
    expect(() => parseOidcClientEntry(entry({ constant_claims: { "not a claim": "x" } }))).toThrow(
      /unusable claim name/,
    );
    expect(() => parseOidcClientEntry(entry({ constant_claims: { tenant: "  " } }))).toThrow(
      /non-empty string/,
    );
    expect(() => parseOidcClientEntry(entry({ constant_claims: { tenant: 7 } }))).toThrow(
      /non-empty string/,
    );
  });
});

describe("client_id must never collide with a resource audience", () => {
  test("an entry that lists its own client_id as a resource audience is refused", () => {
    // aud on an ID token IS the client id, so this registration would make the
    // client's own ID token verify as an access token for that resource.
    expect(() => parseOidcClientEntry(entry({ resource_audiences: ["elizahub-forgejo"] }))).toThrow(
      /its own client_id/,
    );
  });

  test("a client_id that another entry declares as a resource audience is refused", () => {
    expect(() =>
      loadRegistry([
        entry({ client_id: "eliza-steward-console", resource_audiences: ["eliza-merge-steward"] }),
        entry({
          client_id: "eliza-merge-steward",
          redirect_uris: ["https://steward.example/oidc/callback"],
        }),
      ]),
    ).toThrow(/also declares as a resource audience/);
  });

  test("the registry order does not matter: the collision is refused either way", () => {
    expect(() =>
      loadRegistry([
        entry({
          client_id: "eliza-merge-steward",
          redirect_uris: ["https://steward.example/oidc/callback"],
        }),
        entry({ client_id: "eliza-steward-console", resource_audiences: ["eliza-merge-steward"] }),
      ]),
    ).toThrow(/also declares as a resource audience/);
  });

  test("distinct client ids and resource audiences still load", () => {
    loadRegistry([
      entry({ client_id: "eliza-steward-console", resource_audiences: ["eliza-merge-steward"] }),
      entry({ client_id: "elizahub-forgejo" }),
    ]);
    expect(getOidcClient("eliza-steward-console")?.resource_audiences).toEqual([
      "eliza-merge-steward",
    ]);
    expect(getOidcClient("eliza-merge-steward")).toBeNull();
  });
});

describe("the documented worked entries load", () => {
  test("the Forgejo login client from .env.example", () => {
    const client = parseOidcClientEntry(
      entry({
        name: "Eliza Hub",
        resource_audiences: [],
        claims_mapping: {
          mode: "extend",
          groups: {
            "eliza-cloud:users": ["eliza-team"],
            "eliza-cloud:admins": ["eliza-admins"],
          },
          roles: {},
        },
        constant_claims: { tenant: "eliza" },
      }),
    );
    expect(client.constant_claims.tenant).toBe("eliza");
    expect(client.resource_audiences).toEqual([]);
  });

  test("the steward-console client from .env.example", () => {
    const client = parseOidcClientEntry(
      entry({
        client_id: "eliza-steward-console",
        redirect_uris: ["https://console.example/oidc/callback"],
        resource_audiences: ["eliza-merge-steward"],
        require_pkce: true,
        claims_mapping: {
          mode: "replace",
          roles: {
            org_owner: ["steward", "maintainer"],
            org_admin: ["maintainer"],
            platform_super_admin: ["steward-admin"],
          },
          groups: {
            "eliza-cloud:users": ["eliza-team"],
            "eliza-cloud:admins": ["eliza-admins"],
          },
        },
        constant_claims: { tenant: "eliza" },
      }),
    );
    expect(client.resource_audiences).toEqual(["eliza-merge-steward"]);
    expect(client.claims_mapping.mode).toBe("replace");
  });
});
