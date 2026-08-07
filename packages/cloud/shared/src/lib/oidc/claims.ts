/**
 * The single place every OIDC claim in the Eliza Cloud SSO contract is
 * populated, scope-gated, and filtered by per-client policy.
 *
 * Claim sources and the reasoning behind each:
 *   - `sub` is `users.id`, NOT `steward_user_id`. The uuid primary key is
 *     stable, never recycled, and not derived from email; the Steward id
 *     belongs to an external identity service that could be replaced.
 *   - `email_verified` is read from the row and never fabricated. It is the
 *     gate the relying party uses before auto-creating an account, and
 *     `/authorize` refuses outright when a client requires it.
 *   - `groups` and `roles` are SYNTHESIZED. There is no `organization_members`
 *     or teams table anywhere in the schema: membership is the single
 *     `users.organization_id` FK plus the scalar `users.role`, so a user
 *     belongs to exactly one organization. Emitting the honest one-org shape
 *     is better than inventing team structure an RP would trust.
 *   - Account kind is a GROUP as well as its own claim. A relying party that
 *     admits agent-owned accounts on different terms expresses that as group
 *     membership — Forgejo's `--restricted-group` is the only knob it has — and
 *     a claim it does not read cannot drive it. `eliza-cloud:agents` and
 *     `eliza-cloud:services` are the native values an operator maps onto that
 *     configured name.
 *   - The implicit verified-`@elizalabs.ai` platform grant is emitted under its
 *     OWN role value (`platform_super_admin_implicit`), so a relying party can
 *     allowlist the wallet-backed grant without inheriting the email-domain
 *     one. Any RP that gates privileged operations on `roles` should list the
 *     value it means explicitly.
 *   - `tenant_id` is the Eliza TENANT boundary and is therefore per-organization
 *     (`organizations.steward_tenant_id` is `.unique()`). It is not, and cannot
 *     be, a deployment-wide admission marker. A relying party that gates login
 *     on one fixed claim value — Forgejo's `--required-claim-name/-value` pair
 *     accepts exactly one — needs `constant_claims` instead, which emits an
 *     operator-chosen name/value verbatim for every token issued to that client.
 *     Its value comes from the organization row, then the deployment default,
 *     and from nothing session-derived: `/userinfo` is reached with an access
 *     token and no session at all, so such a tier could only ever reach the ID
 *     token, and a tenant that changes between the two is how a relying party
 *     admits a login and then re-reads it as a different account.
 *
 * Provider-native `roles`/`groups` values are Eliza Cloud's own vocabulary. A
 * relying party almost never shares it, so each client may declare a
 * `claims_mapping` that translates those values into the names that RP is
 * configured to require. Mapping runs AFTER `roles_allowlist`, which still
 * filters the NATIVE vocabulary — allowlisting a mapped output name matches
 * nothing. Both sides of that translation are closed enough to check, so the
 * registry validates mapping keys against `OIDC_ROLE_VALUES` and
 * `isEmittableOidcGroup` and refuses a key nothing here can produce.
 *
 * Nothing here reads request state; callers pass an already-resolved snapshot
 * so `/authorize`, `/token`, and `/userinfo` all produce identical claims from
 * identical inputs.
 */

import type { OidcUserProfile } from "../../db/schemas/oidc";
import type { Organization } from "../../db/schemas/organizations";
import type { User } from "../../db/schemas/users";
import type { OidcClaimsMapping, OidcClient } from "./clients";

export type OidcAccountKind = "human" | "agent" | "service";

/**
 * Every value `buildOidcRoles` can produce. The set is closed — roles are
 * synthesized from `users.role` and the platform-admin grant, never stored — so
 * the client registry validates `roles_allowlist` and role-mapping keys against
 * it. A typo there would otherwise silently emit an empty `roles` claim, which
 * a relying party reads as "this user has no permissions".
 */
export const OIDC_ROLE_VALUES = [
  "org_owner",
  "org_admin",
  "org_member",
  "platform_super_admin",
  "platform_super_admin_implicit",
  "platform_moderator",
  "platform_viewer",
] as const;

/**
 * The group values that do not depend on a specific organization row.
 * `eliza-cloud:admins` and `eliza-cloud:agents` are the two an operator maps
 * onto a relying party's privileged and restricted group names.
 */
export const OIDC_STATIC_GROUP_VALUES = [
  "eliza-cloud:users",
  "eliza-cloud:admins",
  "eliza-cloud:agents",
  "eliza-cloud:services",
] as const;

/** Prefix of the per-organization values `org:<uuid>`, `org:<slug>`, `org:<uuid>:<role>`. */
export const OIDC_ORG_GROUP_PREFIX = "org:";

/**
 * Whether `buildOidcGroups` can ever produce this value, and therefore whether
 * a `claims_mapping.groups` key naming it can ever match.
 *
 * The organization half stays open (a uuid, a slug, and a role are all runtime
 * values), so this is a prefix test there and an exact test everywhere else.
 * It exists because a group mapping that matches nothing is invisible: the
 * relying party receives a well-formed token missing exactly the group its own
 * configuration gates on.
 */
export function isEmittableOidcGroup(value: string): boolean {
  if ((OIDC_STATIC_GROUP_VALUES as readonly string[]).includes(value)) return true;
  return value.startsWith(OIDC_ORG_GROUP_PREFIX) && value.length > OIDC_ORG_GROUP_PREFIX.length;
}

export interface OidcAdminStatus {
  isAdmin: boolean;
  role: "super_admin" | "moderator" | "viewer" | null;
  /** True when the grant came from the verified-@elizalabs.ai email rule. */
  implicit: boolean;
}

export interface OidcClaimsInput {
  user: User;
  organization: Organization | null;
  profile: Pick<OidcUserProfile, "username" | "account_kind" | "actor_id" | "agent_id"> | null;
  /** The frozen username; passed separately so allocation can happen at authorize. */
  username: string;
  adminStatus: OidcAdminStatus;
  /** Deployment-level tenant, used only when the organization carries none. */
  deploymentTenantId?: string | null;
  /** Live agent-sandbox ids owned by this user / org. Only read when policy allows. */
  agentIds?: string[];
  scopes: string[];
  client: OidcClient;
}

/** Claims carried by the ID token and echoed by `/userinfo` (minus `sub`). */
export type OidcProfileClaims = Record<string, unknown>;

const MAX_AGENT_IDS = 50;

function isAbsoluteHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    // error-policy:J3 a stored avatar that is not a URL (a data blob, a
    // relative path) is simply not emitted rather than shipped as `picture`.
    return false;
  }
}

function orgRoleName(role: string): string {
  if (role === "owner") return "org_owner";
  if (role === "admin") return "org_admin";
  return "org_member";
}

/**
 * Narrow the free-text `oidc_user_profiles.account_kind` column, failing CLOSED.
 *
 * An absent profile is `human` — that is the column default and the state every
 * console account starts in. A value that is present but unrecognized is read as
 * `service` instead, and never as `human`: `human` is the UNRESTRICTED answer at
 * a relying party (absence of a kind group is what Forgejo's `--restricted-group`
 * reads as "not restricted"), so guessing it would hand a non-human account the
 * terms a person gets. `service` is the conservative half of that choice — it
 * asserts only "not a person", where `agent` would additionally assert a bound
 * Eliza agent this row gives no evidence of — and both non-human kinds emit a
 * group from the restricted vocabulary an operator maps.
 *
 * Throwing was the wrong shape for the same fault. Nothing calls this before a
 * code is issued: claims are built at `/token` and `/userinfo`, so a raised error
 * would burn the authorization code and answer the relying party with a 5xx on
 * every retry — an account locked out of sign-in with no self-service repair,
 * for a stored value that is by construction not the user's doing.
 */
export function readOidcAccountKind(value: string | null | undefined): OidcAccountKind {
  if (value === undefined || value === null) return "human";
  if (value === "human" || value === "agent" || value === "service") return value;
  return "service";
}

/**
 * `["eliza-cloud:users", "org:<uuid>", "org:<slug>", "org:<uuid>:<role>"]`, plus
 * `eliza-cloud:admins` for a platform admin and `eliza-cloud:agents` /
 * `eliza-cloud:services` for a non-human account.
 *
 * The uuid-keyed entries are the stable ones — `organizations.slug` is mutable,
 * so an RP that maps teams from the slug silently breaks on a rename. A human
 * account gets no kind group at all: absence is what a relying party reads as
 * "not restricted", and emitting a `eliza-cloud:humans` value everybody carries
 * would only grow every token.
 */
export function buildOidcGroups(
  user: User,
  organization: Organization | null,
  adminStatus: OidcAdminStatus,
  accountKind: OidcAccountKind,
): string[] {
  const groups = ["eliza-cloud:users"];
  if (organization) {
    groups.push(`org:${organization.id}`);
    if (organization.slug) groups.push(`org:${organization.slug}`);
    groups.push(`org:${organization.id}:${user.role}`);
  }
  if (adminStatus.isAdmin) groups.push("eliza-cloud:admins");
  if (accountKind === "agent") groups.push("eliza-cloud:agents");
  if (accountKind === "service") groups.push("eliza-cloud:services");
  return groups;
}

/**
 * Organization role plus the separate platform-admin grant. Platform values are
 * namespaced so an RP allowlist can distinguish "owns an Eliza Cloud org" from
 * "administers the Eliza Cloud platform".
 */
export function buildOidcRoles(user: User, adminStatus: OidcAdminStatus): string[] {
  const roles = [orgRoleName(user.role)];
  if (adminStatus.role) {
    roles.push(
      adminStatus.implicit && adminStatus.role === "super_admin"
        ? "platform_super_admin_implicit"
        : `platform_${adminStatus.role}`,
    );
  }
  return roles;
}

/**
 * Translate a provider-native list into the relying party's vocabulary.
 *
 * `extend` keeps the native value and appends its targets, so an RP that
 * consumes both (Forgejo maps teams from `org:<uuid>` while gating login on a
 * mapped group) sees both. `replace` emits ONLY the mapped targets and DROPS an
 * unmapped native value, which is what keeps Eliza Cloud's internal org uuids
 * and platform-role names out of a token issued to a narrow resource server.
 */
export function applyOidcClaimMapping(
  values: string[],
  map: Record<string, string[]>,
  mode: OidcClaimsMapping["mode"],
): string[] {
  const out: string[] = [];
  const push = (value: string): void => {
    if (!out.includes(value)) out.push(value);
  };
  for (const value of values) {
    if (mode === "extend") push(value);
    // `Object.hasOwn`, not `map[value] ?? []`: the map is JSON the operator
    // supplied, so an inherited `constructor`/`toString` lookup would otherwise
    // return a function here instead of undefined.
    if (Object.hasOwn(map, value)) {
      for (const mapped of map[value]) push(mapped);
    }
  }
  return out;
}

/** `organizations.steward_tenant_id` → deployment tenant. Both are stored rows. */
export function resolveOidcTenantId(input: OidcClaimsInput): string | null {
  return input.organization?.steward_tenant_id ?? input.deploymentTenantId ?? null;
}

/**
 * Build the scope-gated, policy-filtered claim set. `sub` is always present;
 * every other claim is omitted rather than emitted as null, so a consumer can
 * tell "not granted" from "empty".
 */
export function buildOidcClaims(input: OidcClaimsInput): OidcProfileClaims {
  const { user, client, profile } = input;
  const scopes = new Set(input.scopes);
  const policy = client.claims_policy;
  const mapping = client.claims_mapping;
  // Constant claims are spread FIRST so a provider claim always wins a name
  // collision. The registry already refuses to load a reserved name, so this is
  // the second of two independent guards rather than the only one.
  const claims: OidcProfileClaims = { ...client.constant_claims, sub: user.id };
  const accountKind = readOidcAccountKind(profile?.account_kind);

  if (scopes.has("email")) {
    if (user.email) claims.email = user.email;
    claims.email_verified = user.email_verified === true;
  }

  if (scopes.has("profile")) {
    // `preferred_username` and `nickname` deliberately carry the SAME frozen
    // value: the RP's config selects one of them as the account name and the
    // two claims have swapped precedence across relying-party versions, so
    // emitting one allocated value for both makes the result deterministic.
    claims.preferred_username = input.username;
    claims.nickname = input.username;
    if (user.name) claims.name = user.name;
    if (isAbsoluteHttpUrl(user.avatar)) claims.picture = user.avatar;
  }

  if (scopes.has("groups")) {
    if (policy.groups) {
      claims.groups = applyOidcClaimMapping(
        buildOidcGroups(user, input.organization, input.adminStatus, accountKind),
        mapping.groups,
        mapping.mode,
      );
    }
    if (policy.roles) {
      const roles = buildOidcRoles(user, input.adminStatus);
      // The allowlist filters the NATIVE vocabulary; mapping translates what
      // survives. Reversing the order would make an allowlist entry have to name
      // a value this provider never produces.
      const permitted =
        client.roles_allowlist.length > 0
          ? roles.filter((role) => client.roles_allowlist.includes(role))
          : roles;
      claims.roles = applyOidcClaimMapping(permitted, mapping.roles, mapping.mode);
    }
  }

  if (policy.tenant_id) {
    const tenantId = resolveOidcTenantId(input);
    if (tenantId) claims.tenant_id = tenantId;
  }

  claims.eliza_account_kind = accountKind;
  claims.eliza_actor_id = profile?.actor_id ?? user.id;

  // A single bound agent id is part of an agent-owned account's identity and
  // travels with it. The org-wide SET is a different thing — unbounded, and
  // nothing a human's Forgejo login should carry — so it needs both an
  // explicit per-client policy and a non-default scope.
  if (profile?.agent_id) claims.eliza_agent_id = profile.agent_id;
  if (policy.eliza_agents && scopes.has("eliza_agents")) {
    const agentIds = (input.agentIds ?? []).slice(0, MAX_AGENT_IDS);
    if (agentIds.length > 0) claims.eliza_agent_ids = agentIds;
  }

  return claims;
}
