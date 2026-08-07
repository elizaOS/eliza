/**
 * Claim-mapping contract for the Eliza Cloud OpenID Provider, checked against
 * the table in `docs/eliza-cloud-sso-plan.md`. Pure builder, real inputs, no
 * mocks — the DB rows are constructed literals.
 *
 * The assertions that matter most: `sub` is the user uuid and never the email
 * or the external Steward id, `email_verified` reflects the row rather than a
 * hardcoded true, and a low-trust client sees nothing it was not explicitly
 * granted.
 */

import { describe, expect, test } from "bun:test";

import type { Organization } from "../../db/schemas/organizations";
import type { User } from "../../db/schemas/users";
import {
  buildOidcClaims,
  isEmittableOidcGroup,
  type OidcAdminStatus,
  type OidcClaimsInput,
  readOidcAccountKind,
  resolveOidcTenantId,
} from "./claims";
import type { OidcClient } from "./clients";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: USER_ID,
    email: "ada@example.com",
    email_verified: true,
    wallet_address: null,
    wallet_chain_type: null,
    wallet_verified: false,
    name: "Ada Lovelace",
    avatar: "https://cdn.example.com/ada.png",
    organization_id: ORG_ID,
    role: "owner",
    steward_user_id: "steward-abc",
    is_anonymous: false,
    is_active: true,
    nickname: "ada",
    deleted_at: null,
    ...overrides,
  } as User;
}

function makeOrg(overrides: Partial<Organization> = {}): Organization {
  return {
    id: ORG_ID,
    name: "Analytical Engines",
    slug: "analytical-engines",
    steward_tenant_id: "tenant-analytical",
    is_active: true,
    ...overrides,
  } as Organization;
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
    roles_allowlist: [],
    claims_policy: { groups: true, roles: true, tenant_id: true, eliza_agents: false },
    claims_mapping: { roles: {}, groups: {}, mode: "extend" },
    constant_claims: {},
    id_token_ttl_seconds: 300,
    access_token_ttl_seconds: 300,
    ...overrides,
  };
}

const NO_ADMIN: OidcAdminStatus = { isAdmin: false, role: null, implicit: false };

function build(overrides: Partial<OidcClaimsInput> = {}): Record<string, unknown> {
  return buildOidcClaims({
    user: makeUser(),
    organization: makeOrg(),
    profile: null,
    username: "ada",
    adminStatus: NO_ADMIN,
    scopes: ["openid", "email", "profile", "groups"],
    client: makeClient(),
    ...overrides,
  });
}

describe("sub", () => {
  test("is the user uuid — stable, never recycled, never derived from email", () => {
    const claims = build();
    expect(claims.sub).toBe(USER_ID);
    expect(claims.sub).not.toBe("ada@example.com");
    expect(claims.sub).not.toBe("steward-abc");
  });

  test("does not change when the email or display name changes", () => {
    const renamed = build({
      user: makeUser({ email: "ada@newdomain.example", name: "Ada Byron", nickname: "ab" }),
    });
    expect(renamed.sub).toBe(USER_ID);
  });
});

describe("email and email_verified", () => {
  test("email_verified mirrors the row when true", () => {
    expect(build().email_verified).toBe(true);
  });

  test("email_verified is false — not omitted, not hardcoded true — for an unverified row", () => {
    const claims = build({ user: makeUser({ email_verified: false }) });
    expect(claims.email_verified).toBe(false);
    expect(claims.email).toBe("ada@example.com");
  });

  test("a null email_verified column reads as false, never as true", () => {
    expect(build({ user: makeUser({ email_verified: null }) }).email_verified).toBe(false);
  });

  test("a missing email is OMITTED rather than emitted as an empty string", () => {
    // The plaintext column is nullable through the field-encryption rollout;
    // an empty string would look like a real address to a relying party.
    const claims = build({ user: makeUser({ email: null }) });
    expect(claims).not.toHaveProperty("email");
    expect(claims.email_verified).toBe(true);
  });

  test("neither claim appears without the email scope", () => {
    const claims = build({ scopes: ["openid", "profile"] });
    expect(claims).not.toHaveProperty("email");
    expect(claims).not.toHaveProperty("email_verified");
  });
});

describe("preferred_username and nickname", () => {
  test("both carry the same allocated value, so the RP's choice of claim is deterministic", () => {
    const claims = build({ username: "ada-lovelace" });
    expect(claims.preferred_username).toBe("ada-lovelace");
    expect(claims.nickname).toBe("ada-lovelace");
  });

  test("nickname is the ALLOCATED name, not the free-text users.nickname column", () => {
    const claims = build({
      user: makeUser({ nickname: "Ada 🦋 the Countess" }),
      username: "ada",
    });
    expect(claims.nickname).toBe("ada");
  });

  test("profile claims are absent without the profile scope", () => {
    const claims = build({ scopes: ["openid", "email"] });
    expect(claims).not.toHaveProperty("preferred_username");
    expect(claims).not.toHaveProperty("nickname");
    expect(claims).not.toHaveProperty("name");
    expect(claims).not.toHaveProperty("picture");
  });
});

describe("name and picture", () => {
  test("emitted from the row when present", () => {
    const claims = build();
    expect(claims.name).toBe("Ada Lovelace");
    expect(claims.picture).toBe("https://cdn.example.com/ada.png");
  });

  test("a non-URL avatar is omitted rather than shipped as picture", () => {
    for (const avatar of ["/uploads/ada.png", "data:image/png;base64,AAAA", ""]) {
      const claims = build({ user: makeUser({ avatar }) });
      expect(claims).not.toHaveProperty("picture");
    }
  });

  test("a null name is omitted", () => {
    expect(build({ user: makeUser({ name: null }) })).not.toHaveProperty("name");
  });
});

describe("groups", () => {
  test("carries the stable org uuid alongside the mutable slug", () => {
    const groups = build().groups as string[];
    expect(groups).toContain("eliza-cloud:users");
    expect(groups).toContain(`org:${ORG_ID}`);
    expect(groups).toContain("org:analytical-engines");
    expect(groups).toContain(`org:${ORG_ID}:owner`);
  });

  test("a user with no organization still gets the floor group and nothing invented", () => {
    const groups = build({
      user: makeUser({ organization_id: null }),
      organization: null,
    }).groups as string[];
    expect(groups).toEqual(["eliza-cloud:users"]);
  });

  test("admins are marked, non-admins are not", () => {
    expect(build().groups as string[]).not.toContain("eliza-cloud:admins");
    const adminGroups = build({
      adminStatus: { isAdmin: true, role: "moderator", implicit: false },
    }).groups as string[];
    expect(adminGroups).toContain("eliza-cloud:admins");
  });

  test("absent when the client is not granted the groups policy", () => {
    const claims = build({
      client: makeClient({
        claims_policy: { groups: false, roles: true, tenant_id: true, eliza_agents: false },
      }),
    });
    expect(claims).not.toHaveProperty("groups");
    expect(claims).toHaveProperty("roles");
  });

  test("an agent account carries its kind as a group; a human carries none", () => {
    // Forgejo's restricted group is a group name, not a claim it reads — an
    // agent account can only be admitted on different terms through this.
    const agent = build({
      profile: { username: "agent-7", account_kind: "agent", actor_id: null, agent_id: "agent-7" },
    }).groups as string[];
    expect(agent).toContain("eliza-cloud:agents");
    expect(agent).not.toContain("eliza-cloud:services");

    const service = build({
      profile: {
        username: "eliza-merge-steward",
        account_kind: "service",
        actor_id: null,
        agent_id: null,
      },
    }).groups as string[];
    expect(service).toContain("eliza-cloud:services");

    const human = build().groups as string[];
    expect(human).not.toContain("eliza-cloud:agents");
    expect(human).not.toContain("eliza-cloud:services");
  });

  test("an unknown account_kind reads as the restricted kind, never as a human", () => {
    // A legacy or hand-written value must not be admitted on a person's terms,
    // and must not lock the account out of sign-in either: claims are built at
    // `/token`, after the code is issued, so throwing here would answer the
    // relying party with a 5xx on every retry.
    for (const kind of ["bot", "HUMAN", "", "agent "]) {
      const claims = build({
        profile: { username: "mystery", account_kind: kind, actor_id: null, agent_id: null },
      });
      expect(claims.eliza_account_kind).toBe("service");
      const groups = claims.groups as string[];
      expect(groups).toContain("eliza-cloud:services");
      expect(groups).not.toContain("eliza-cloud:agents");
    }
  });

  test("readOidcAccountKind keeps the three known values and the absent-profile default", () => {
    expect(readOidcAccountKind(undefined)).toBe("human");
    expect(readOidcAccountKind(null)).toBe("human");
    expect(readOidcAccountKind("human")).toBe("human");
    expect(readOidcAccountKind("agent")).toBe("agent");
    expect(readOidcAccountKind("service")).toBe("service");
  });
});

describe("the group vocabulary a mapping key may name", () => {
  test("every static value this provider emits is mappable", () => {
    for (const group of [
      "eliza-cloud:users",
      "eliza-cloud:admins",
      "eliza-cloud:agents",
      "eliza-cloud:services",
    ]) {
      expect(isEmittableOidcGroup(group)).toBe(true);
    }
  });

  test("organization values stay open because uuid, slug, and role are runtime data", () => {
    expect(isEmittableOidcGroup(`org:${ORG_ID}`)).toBe(true);
    expect(isEmittableOidcGroup("org:analytical-engines")).toBe(true);
    expect(isEmittableOidcGroup(`org:${ORG_ID}:owner`)).toBe(true);
  });

  test("a name nothing here produces is not mappable", () => {
    // Including the RP-side names an operator might key the mapping on by
    // mistake: those are mapping TARGETS, never sources.
    for (const group of ["eliza-admins", "eliza-agents", "eliza-cloud:admin", "org:", ""]) {
      expect(isEmittableOidcGroup(group)).toBe(false);
    }
  });
});

describe("roles", () => {
  test("organization role is namespaced", () => {
    expect(build().roles).toEqual(["org_owner"]);
    expect(build({ user: makeUser({ role: "admin" }) }).roles).toEqual(["org_admin"]);
    expect(build({ user: makeUser({ role: "member" }) }).roles).toEqual(["org_member"]);
  });

  test("a wallet-backed platform grant is distinguishable from the implicit email-domain grant", () => {
    const explicit = build({
      adminStatus: { isAdmin: true, role: "super_admin", implicit: false },
    }).roles as string[];
    expect(explicit).toContain("platform_super_admin");
    expect(explicit).not.toContain("platform_super_admin_implicit");

    const implicit = build({
      adminStatus: { isAdmin: true, role: "super_admin", implicit: true },
    }).roles as string[];
    expect(implicit).toContain("platform_super_admin_implicit");
    expect(implicit).not.toContain("platform_super_admin");
  });

  test("the per-client allowlist filters what a relying party can act on", () => {
    const claims = build({
      adminStatus: { isAdmin: true, role: "super_admin", implicit: true },
      client: makeClient({ roles_allowlist: ["org_owner", "platform_super_admin"] }),
    });
    // The implicit grant is filtered out: an RP that allowlists the
    // wallet-backed role does not silently inherit the email-domain one.
    expect(claims.roles).toEqual(["org_owner"]);
  });

  test("absent when the client is not granted the roles policy", () => {
    const claims = build({
      client: makeClient({
        claims_policy: { groups: true, roles: false, tenant_id: true, eliza_agents: false },
      }),
    });
    expect(claims).not.toHaveProperty("roles");
  });
});

describe("tenant_id", () => {
  test("prefers the organization's Steward tenant", () => {
    expect(build({ deploymentTenantId: "elizacloud" }).tenant_id).toBe("tenant-analytical");
  });

  test("falls back to the deployment tenant", () => {
    const org = makeOrg({ steward_tenant_id: null });
    expect(build({ organization: org, deploymentTenantId: "elizacloud" }).tenant_id).toBe(
      "elizacloud",
    );
  });

  test("resolves from stored rows alone, so /token and /userinfo agree", () => {
    // Both inputs are readable without a session. `/userinfo` is reached with
    // an access token and nothing else, so a tier that needed one would appear
    // in the ID token and vanish on the relying party's next read.
    const inputs: OidcClaimsInput = {
      user: makeUser(),
      organization: makeOrg({ steward_tenant_id: null }),
      profile: null,
      username: "ada",
      adminStatus: NO_ADMIN,
      deploymentTenantId: "elizacloud",
      scopes: ["openid", "email", "profile", "groups"],
      client: makeClient(),
    };
    expect(buildOidcClaims(inputs)).toEqual(buildOidcClaims({ ...inputs }));
    expect(resolveOidcTenantId(inputs)).toBe("elizacloud");
  });

  test("is omitted, never fabricated, when no tenant exists anywhere", () => {
    const claims = build({ organization: makeOrg({ steward_tenant_id: null }) });
    expect(claims).not.toHaveProperty("tenant_id");
  });
});

describe("eliza-specific claims", () => {
  test("account kind defaults to human and actor id defaults to the sub", () => {
    const claims = build();
    expect(claims.eliza_account_kind).toBe("human");
    expect(claims.eliza_actor_id).toBe(USER_ID);
  });

  test("an operator-marked service account reports its own kind and actor id", () => {
    const claims = build({
      profile: {
        username: "eliza-merge-steward",
        account_kind: "service",
        actor_id: "steward-bot",
        agent_id: null,
      },
    });
    expect(claims.eliza_account_kind).toBe("service");
    expect(claims.eliza_actor_id).toBe("steward-bot");
  });

  test("a bound agent id travels with the account; the org-wide SET does not", () => {
    const claims = build({
      profile: { username: "agent-7", account_kind: "agent", actor_id: null, agent_id: "agent-7" },
      agentIds: ["a1", "a2"],
    });
    expect(claims.eliza_agent_id).toBe("agent-7");
    // Forgejo's fixed scope list never includes eliza_agents, so a human login
    // must not carry an unbounded list of the organization's agents.
    expect(claims).not.toHaveProperty("eliza_agent_ids");
  });

  test("the agent set requires BOTH the client policy and the scope", () => {
    const policyOnly = build({
      client: makeClient({
        claims_policy: { groups: true, roles: true, tenant_id: true, eliza_agents: true },
      }),
      agentIds: ["a1"],
    });
    expect(policyOnly).not.toHaveProperty("eliza_agent_ids");

    const both = build({
      client: makeClient({
        allowed_scopes: ["openid", "email", "profile", "groups", "eliza_agents"],
        claims_policy: { groups: true, roles: true, tenant_id: true, eliza_agents: true },
      }),
      scopes: ["openid", "eliza_agents"],
      agentIds: ["a1", "a2"],
    });
    expect(both.eliza_agent_ids).toEqual(["a1", "a2"]);
  });

  test("the agent set is capped so an ID token cannot grow without bound", () => {
    const many = Array.from({ length: 120 }, (_, i) => `agent-${i}`);
    const claims = build({
      client: makeClient({
        allowed_scopes: ["openid", "eliza_agents"],
        claims_policy: { groups: true, roles: true, tenant_id: true, eliza_agents: true },
      }),
      scopes: ["openid", "eliza_agents"],
      agentIds: many,
    });
    expect((claims.eliza_agent_ids as string[]).length).toBe(50);
  });
});

describe("constant_claims", () => {
  test("emits an operator-chosen fixed value a login gate can require", () => {
    // Forgejo admits a login only when one claim equals one exact value for
    // every user. tenant_id cannot do that job — it is per-organization.
    const claims = build({ client: makeClient({ constant_claims: { tenant: "eliza" } }) });
    expect(claims.tenant).toBe("eliza");
    expect(claims.tenant_id).toBe("tenant-analytical");
  });

  test("the same value is emitted regardless of organization or tenant", () => {
    const client = makeClient({ constant_claims: { tenant: "eliza" } });
    const other = build({
      client,
      organization: makeOrg({ id: "33333333-3333-4333-8333-333333333333", slug: "other" }),
    });
    const orgless = build({
      client,
      user: makeUser({ organization_id: null }),
      organization: null,
    });
    expect(other.tenant).toBe("eliza");
    expect(orgless.tenant).toBe("eliza");
  });

  test("a derived claim always wins the name, so a constant cannot forge identity", () => {
    // The registry refuses a reserved name outright; this is the second guard.
    const claims = build({
      client: makeClient({ constant_claims: { sub: "attacker", tenant: "eliza" } as never }),
    });
    expect(claims.sub).toBe(USER_ID);
    expect(claims.tenant).toBe("eliza");
  });
});

describe("claims_mapping", () => {
  test("extend keeps the native vocabulary and adds the relying party's", () => {
    const claims = build({
      client: makeClient({
        claims_mapping: {
          roles: { org_owner: ["steward", "maintainer"] },
          groups: { "eliza-cloud:users": ["eliza-team"] },
          mode: "extend",
        },
      }),
    });
    expect(claims.roles).toEqual(["org_owner", "steward", "maintainer"]);
    expect(claims.groups).toContain("eliza-cloud:users");
    expect(claims.groups).toContain("eliza-team");
    expect(claims.groups).toContain(`org:${ORG_ID}`);
  });

  test("replace emits only mapped values and drops the org uuid entirely", () => {
    const claims = build({
      adminStatus: { isAdmin: true, role: "super_admin", implicit: false },
      client: makeClient({
        claims_mapping: {
          roles: { org_owner: ["steward", "maintainer"], platform_super_admin: ["steward-admin"] },
          groups: { "eliza-cloud:users": ["eliza-team"], "eliza-cloud:admins": ["eliza-admins"] },
          mode: "replace",
        },
      }),
    });
    expect(claims.roles).toEqual(["steward", "maintainer", "steward-admin"]);
    expect(claims.groups).toEqual(["eliza-team", "eliza-admins"]);
    expect(JSON.stringify(claims.groups)).not.toContain(ORG_ID);
  });

  test("the allowlist filters NATIVE roles and runs before the mapping", () => {
    const claims = build({
      adminStatus: { isAdmin: true, role: "super_admin", implicit: true },
      client: makeClient({
        roles_allowlist: ["org_owner"],
        claims_mapping: {
          roles: {
            org_owner: ["maintainer"],
            platform_super_admin_implicit: ["steward-admin"],
          },
          groups: {},
          mode: "replace",
        },
      }),
    });
    // The implicit platform grant never reaches the mapping, so its target is
    // not emitted either.
    expect(claims.roles).toEqual(["maintainer"]);
  });

  test("an inherited Object member is not treated as a mapping entry", () => {
    // `groups` contains operator-supplied strings looked up in operator-supplied
    // JSON; a prototype hit here would throw inside token minting.
    const claims = build({
      organization: makeOrg({ slug: "constructor" }),
      client: makeClient({
        claims_mapping: {
          roles: {},
          groups: { "eliza-cloud:users": ["eliza-team"] },
          mode: "extend",
        },
      }),
    });
    expect(claims.groups).toContain("org:constructor");
    expect(claims.groups).toContain("eliza-team");
  });

  test("both groups a Forgejo login source is configured with are reachable", () => {
    // `forgejo admin auth add-oauth --admin-group eliza-admins
    // --restricted-group eliza-agents` decides administrator and restricted
    // status from these two names alone. An admin group it never receives makes
    // Forgejo DEMOTE the user signing in, which fails outright on the last
    // administrator — so the mapping has to be able to produce it.
    const forgejo = makeClient({
      claims_mapping: {
        roles: {},
        groups: {
          "eliza-cloud:users": ["eliza-team"],
          "eliza-cloud:admins": ["eliza-admins"],
          "eliza-cloud:agents": ["eliza-agents"],
          "eliza-cloud:services": ["eliza-agents"],
        },
        mode: "extend",
      },
    });

    const admin = build({
      adminStatus: { isAdmin: true, role: "super_admin", implicit: false },
      client: forgejo,
    }).groups as string[];
    expect(admin).toContain("eliza-admins");
    expect(admin).not.toContain("eliza-agents");

    const agent = build({
      profile: { username: "agent-7", account_kind: "agent", actor_id: null, agent_id: "agent-7" },
      client: forgejo,
    }).groups as string[];
    expect(agent).toContain("eliza-agents");
    expect(agent).not.toContain("eliza-admins");

    const human = build({ client: forgejo }).groups as string[];
    expect(human).toContain("eliza-team");
    expect(human).not.toContain("eliza-admins");
    expect(human).not.toContain("eliza-agents");
  });

  test("two native values mapping onto one target emit it once", () => {
    const claims = build({
      user: makeUser({ role: "admin" }),
      adminStatus: { isAdmin: true, role: "moderator", implicit: false },
      client: makeClient({
        claims_mapping: {
          roles: { org_admin: ["maintainer"], platform_moderator: ["maintainer"] },
          groups: {},
          mode: "replace",
        },
      }),
    });
    expect(claims.roles).toEqual(["maintainer"]);
  });
});

describe("a low-trust client sees only what it was granted", () => {
  test("default-deny claims policy withholds groups, roles, and tenant", () => {
    const claims = build({
      client: makeClient({
        claims_policy: { groups: false, roles: false, tenant_id: false, eliza_agents: false },
      }),
    });
    expect(claims).not.toHaveProperty("groups");
    expect(claims).not.toHaveProperty("roles");
    expect(claims).not.toHaveProperty("tenant_id");
    // Identity still resolves: sub, email, and the profile claims remain.
    expect(claims.sub).toBe(USER_ID);
    expect(claims.email).toBe("ada@example.com");
  });
});
