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
 *
 * Provider-native `roles`/`groups` values are Eliza Cloud's own vocabulary. A
 * relying party almost never shares it, so each client may declare a
 * `claims_mapping` that translates those values into the names that RP is
 * configured to require. Mapping runs AFTER `roles_allowlist`, which still
 * filters the NATIVE vocabulary — allowlisting a mapped output name matches
 * nothing.
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
 * The group values that do not depend on a specific organization row. The full
 * vocabulary is open — `org:<uuid>`, `org:<slug>`, and `org:<uuid>:<role>` are
 * per-tenant — so group-mapping keys cannot be validated against a closed set
 * the way role keys can.
 */
export const OIDC_STATIC_GROUP_VALUES = ["eliza-cloud:users", "eliza-cloud:admins"] as const;

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
  /** Verified Steward tenant of the authorizing session (may be `personal-<id>`). */
  sessionTenantId?: string | null;
  /** Deployment-level tenant, used only when nothing more specific exists. */
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
 * `["eliza-cloud:users", "org:<uuid>", "org:<slug>", "org:<uuid>:<role>"]`.
 *
 * The uuid-keyed entries are the stable ones — `organizations.slug` is mutable,
 * so an RP that maps teams from the slug silently breaks on a rename.
 */
export function buildOidcGroups(
  user: User,
  organization: Organization | null,
  adminStatus: OidcAdminStatus,
): string[] {
  const groups = ["eliza-cloud:users"];
  if (organization) {
    groups.push(`org:${organization.id}`);
    if (organization.slug) groups.push(`org:${organization.slug}`);
    groups.push(`org:${organization.id}:${user.role}`);
  }
  if (adminStatus.isAdmin) groups.push("eliza-cloud:admins");
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

/** `organizations.steward_tenant_id` → verified session tenant → deployment tenant. */
export function resolveOidcTenantId(input: OidcClaimsInput): string | null {
  return (
    input.organization?.steward_tenant_id ??
    input.sessionTenantId ??
    input.deploymentTenantId ??
    null
  );
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
        buildOidcGroups(user, input.organization, input.adminStatus),
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

  const accountKind: OidcAccountKind = (profile?.account_kind as OidcAccountKind) ?? "human";
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
