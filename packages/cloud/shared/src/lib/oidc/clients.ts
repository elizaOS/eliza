/**
 * Relying-party registry for the OpenID Connect provider.
 *
 * The registry is a single `OIDC_CLIENTS` secret holding a JSON array (JSON or
 * base64-wrapped JSON), parsed once per isolate and memoized on the raw string
 * — the same cache-by-source shape the existing signing-key modules use, so a
 * `wrangler secret put` takes effect on the next request without a redeploy.
 * There is no `oidc_clients` table and no dynamic registration: this
 * deployment has a small fixed set of first-party RPs, and keeping the registry
 * in a SECRET makes the documented "secrets get wiped on redeploy" hazard fail
 * CLOSED (503 `oidc_not_configured`) instead of silently serving with an empty
 * or stale registry.
 *
 * Client secrets are stored ONLY as sha256 hex, mirroring `api_keys.key_hash`,
 * and compared with a timing-safe equality. `redirect_uris` are matched by
 * EXACT string — no prefix match, no wildcard, no scheme/host normalization.
 * That single rule is what keeps `/authorize` from becoming a token-exfiltration
 * primitive against every signed-in user.
 *
 * Parsing is strict in one further direction: an entry whose knobs contradict
 * each other REFUSES TO LOAD. A `claims_policy` that grants `roles` while
 * `allowed_scopes` withholds the `groups` scope that gates it, an allowlist or
 * mapping keyed on a role or group this provider cannot produce, a mapping for a
 * claim the policy denies — each of those emits a token that is well-formed, verifies
 * cleanly, and is then rejected by the relying party for a reason no log here
 * would explain. Failing the whole registry (503 `oidc_not_configured`) makes
 * the misconfiguration visible at deploy time instead.
 *
 * One of those contradictions is a privilege boundary rather than a usability
 * one: a `client_id` that is also a `resource_audiences` value anywhere in the
 * registry. An ID token's `aud` IS the client id, so that registration hands the
 * resource server behind the audience a token its client already holds. It is
 * refused across the whole registry, not per entry.
 */

import { timingSafeEqualSecret } from "../auth/cron";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { isEmittableOidcGroup, OIDC_ROLE_VALUES, OIDC_STATIC_GROUP_VALUES } from "./claims";
import { sha256Hex } from "./crypto";
import { OIDC_SUPPORTED_CLAIMS } from "./metadata";

export interface OidcClaimsPolicy {
  /** Emit `groups` (org membership). */
  groups: boolean;
  /** Emit `roles` (filtered by `roles_allowlist`). */
  roles: boolean;
  /** Emit `tenant_id`. */
  tenant_id: boolean;
  /** Emit `eliza_agent_id` / `eliza_agent_ids`. */
  eliza_agents: boolean;
}

/**
 * Translation from Eliza Cloud's own `roles`/`groups` vocabulary into the names
 * a relying party is configured to require. Without it an RP has to be
 * reconfigured around provider-internal values such as `org_owner` or
 * `org:<uuid>`, which is not possible when the RP's gate list is fixed by its
 * own deployment.
 */
export interface OidcClaimsMapping {
  /** Native role → the value(s) this client should see. */
  roles: Record<string, string[]>;
  /** Native group → the value(s) this client should see. */
  groups: Record<string, string[]>;
  /** `extend` keeps native values alongside mapped ones; `replace` drops them. */
  mode: "extend" | "replace";
}

export interface OidcClient {
  client_id: string;
  name: string;
  /** Accepted sha256 hex digests — more than one during a secret rotation. */
  secret_hashes: string[];
  redirect_uris: string[];
  allowed_scopes: string[];
  /** Extra `aud` values added to the ACCESS token (never the ID token). */
  resource_audiences: string[];
  require_pkce: boolean;
  require_verified_email: boolean;
  /**
   * NATIVE roles this client may see, applied before `claims_mapping`. Empty
   * means "every role this provider knows". Set it for any RP whose
   * authorization decisions branch on `roles`.
   */
  roles_allowlist: string[];
  claims_policy: OidcClaimsPolicy;
  claims_mapping: OidcClaimsMapping;
  /**
   * Fixed claims emitted verbatim in every token and `/userinfo` response for
   * this client. The reason this exists: a relying party may gate login on one
   * claim having one exact value for every admitted user — Forgejo's
   * `--required-claim-name` / `--required-claim-value` pair — and no claim
   * derived from the user's own row can satisfy that, because every such claim
   * varies per user or per organization by definition.
   */
  constant_claims: Record<string, string>;
  id_token_ttl_seconds: number;
  access_token_ttl_seconds: number;
}

const DEFAULT_SCOPES = ["openid", "email", "profile", "groups"];
const DEFAULT_TTL_SECONDS = 300;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const CLAIM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

/**
 * Names `constant_claims` may not take. Everything the provider itself emits is
 * listed, plus the JWT envelope members `stripReservedClaims` removes and the
 * two access-token members `mintOidcAccessToken` writes. A constant claim is
 * spread before the derived ones, so shadowing is already impossible at
 * build time; refusing the name here means the operator learns at deploy time
 * that the value would never have been used.
 *
 * `auth_time` is listed even though the provider no longer emits it: a fixed
 * constant would assert one authentication instant for every user forever,
 * which is the misrepresentation dropping the claim exists to avoid.
 */
const RESERVED_CLAIM_NAMES = new Set<string>([
  ...OIDC_SUPPORTED_CLAIMS,
  "auth_time",
  "nbf",
  "jti",
  "typ",
  "scope",
  "client_id",
]);

const NATIVE_ROLE_VALUES = new Set<string>(OIDC_ROLE_VALUES);

let cachedClients: Map<string, OidcClient> | null = null;
let cachedClientsSource: string | null = null;

function readSource(): string | undefined {
  const raw = getCloudAwareEnv().OIDC_CLIENTS;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function isOidcClientRegistryConfigured(): boolean {
  return Boolean(readSource());
}

function decodeSource(source: string): unknown {
  const text =
    source.startsWith("[") || source.startsWith("{")
      ? source
      : Buffer.from(source, "base64").toString("utf8");
  return JSON.parse(text) as unknown;
}

function stringList(value: unknown, field: string, clientId: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`OIDC_CLIENTS[${clientId}].${field} must be an array of strings`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`OIDC_CLIENTS[${clientId}].${field} must contain non-empty strings`);
    }
    return item.trim();
  });
}

function boolField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function ttlField(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(Math.floor(value), MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

function parseSecretHashes(raw: Record<string, unknown>, clientId: string): string[] {
  const value = raw.client_secret_sha256;
  const list =
    typeof value === "string" ? [value] : stringList(value, "client_secret_sha256", clientId);
  const normalized = list.map((hash) => hash.trim().toLowerCase());
  if (normalized.length === 0) {
    throw new Error(`OIDC_CLIENTS[${clientId}] is missing client_secret_sha256`);
  }
  for (const hash of normalized) {
    if (!SHA256_HEX_RE.test(hash)) {
      throw new Error(`OIDC_CLIENTS[${clientId}].client_secret_sha256 must be sha256 hex`);
    }
  }
  return normalized;
}

function parseRedirectUris(raw: Record<string, unknown>, clientId: string): string[] {
  const uris = stringList(raw.redirect_uris, "redirect_uris", clientId);
  if (uris.length === 0) {
    throw new Error(`OIDC_CLIENTS[${clientId}] must register at least one redirect_uri`);
  }
  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch (error) {
      // error-policy:J2 context-adding rethrow — a redirect URI that does not
      // parse can never be exact-matched, so the registry must not load at all.
      throw new Error(`OIDC_CLIENTS[${clientId}] has an unparseable redirect_uri`, {
        cause: error,
      });
    }
    if (parsed.hash) {
      throw new Error(`OIDC_CLIENTS[${clientId}] redirect_uri must not contain a fragment`);
    }
  }
  return uris;
}

function parseClaimsPolicy(value: unknown): OidcClaimsPolicy {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    groups: boolField(raw.groups, false),
    roles: boolField(raw.roles, false),
    tenant_id: boolField(raw.tenant_id, false),
    eliza_agents: boolField(raw.eliza_agents, false),
  };
}

function parseValueMap(value: unknown, field: string, clientId: string): Record<string, string[]> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OIDC_CLIENTS[${clientId}].${field} must be an object of string arrays`);
  }
  const map: Record<string, string[]> = {};
  for (const [key, targets] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) {
      throw new Error(`OIDC_CLIENTS[${clientId}].${field} has an empty key`);
    }
    const list = Array.isArray(targets)
      ? stringList(targets, `${field}["${key}"]`, clientId)
      : stringList([targets], `${field}["${key}"]`, clientId);
    if (list.length === 0) {
      throw new Error(
        `OIDC_CLIENTS[${clientId}].${field}["${key}"] must map to at least one value`,
      );
    }
    map[key.trim()] = list;
  }
  return map;
}

function parseClaimsMapping(value: unknown, clientId: string): OidcClaimsMapping {
  const raw = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<
    string,
    unknown
  >;
  const mode = raw.mode === undefined ? "extend" : raw.mode;
  if (mode !== "extend" && mode !== "replace") {
    throw new Error(`OIDC_CLIENTS[${clientId}].claims_mapping.mode must be "extend" or "replace"`);
  }
  const roles = parseValueMap(raw.roles, "claims_mapping.roles", clientId);
  for (const nativeRole of Object.keys(roles)) {
    if (!NATIVE_ROLE_VALUES.has(nativeRole)) {
      throw new Error(
        `OIDC_CLIENTS[${clientId}].claims_mapping.roles["${nativeRole}"] is not a role this provider emits (${[...NATIVE_ROLE_VALUES].join(", ")})`,
      );
    }
  }
  const groups = parseValueMap(raw.groups, "claims_mapping.groups", clientId);
  for (const nativeGroup of Object.keys(groups)) {
    // A group mapping is how an operator reaches a relying party's configured
    // admin or restricted group name. A key this provider never emits produces
    // no error at login time — the token simply lacks that group — and at
    // Forgejo an absent admin group DEMOTES the user signing in, which fails
    // outright when they are the last administrator.
    if (!isEmittableOidcGroup(nativeGroup)) {
      throw new Error(
        `OIDC_CLIENTS[${clientId}].claims_mapping.groups["${nativeGroup}"] is not a group this provider emits; keys are ${OIDC_STATIC_GROUP_VALUES.join(", ")} or an "org:" value`,
      );
    }
  }
  return { roles, groups, mode };
}

function parseConstantClaims(value: unknown, clientId: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OIDC_CLIENTS[${clientId}].constant_claims must be an object of strings`);
  }
  const claims: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!CLAIM_NAME_RE.test(name)) {
      throw new Error(`OIDC_CLIENTS[${clientId}].constant_claims has an unusable claim name`);
    }
    if (RESERVED_CLAIM_NAMES.has(name)) {
      throw new Error(
        `OIDC_CLIENTS[${clientId}].constant_claims may not override the provider claim "${name}"`,
      );
    }
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error(
        `OIDC_CLIENTS[${clientId}].constant_claims["${name}"] must be a non-empty string`,
      );
    }
    claims[name] = raw;
  }
  return claims;
}

/**
 * Refuse a client whose knobs cancel each other out. Every case here produces a
 * token that verifies but is missing a claim the operator plainly intended to
 * send, which surfaces at the relying party as an unexplained authorization
 * failure rather than anything this provider would log.
 */
function assertClientIsCoherent(client: OidcClient): void {
  const id = client.client_id;
  const groupsScope = client.allowed_scopes.includes("groups");
  const wantsGroupsOrRoles = client.claims_policy.groups || client.claims_policy.roles;

  if (wantsGroupsOrRoles && !groupsScope) {
    throw new Error(
      `OIDC_CLIENTS[${id}] grants groups/roles in claims_policy but omits the "groups" scope that gates them`,
    );
  }
  if (groupsScope && !wantsGroupsOrRoles) {
    throw new Error(
      `OIDC_CLIENTS[${id}] allows the "groups" scope but claims_policy denies both groups and roles, so the scope emits nothing`,
    );
  }
  if (client.allowed_scopes.includes("eliza_agents") !== client.claims_policy.eliza_agents) {
    throw new Error(
      `OIDC_CLIENTS[${id}] must allow the "eliza_agents" scope and set claims_policy.eliza_agents together`,
    );
  }
  if (client.roles_allowlist.length > 0 && !client.claims_policy.roles) {
    throw new Error(`OIDC_CLIENTS[${id}] sets roles_allowlist but claims_policy denies roles`);
  }
  for (const role of client.roles_allowlist) {
    if (!NATIVE_ROLE_VALUES.has(role)) {
      throw new Error(
        `OIDC_CLIENTS[${id}].roles_allowlist entry "${role}" is not a role this provider emits; the allowlist filters NATIVE roles and runs before claims_mapping`,
      );
    }
  }
  if (Object.keys(client.claims_mapping.roles).length > 0 && !client.claims_policy.roles) {
    throw new Error(`OIDC_CLIENTS[${id}] maps roles but claims_policy denies roles`);
  }
  if (Object.keys(client.claims_mapping.groups).length > 0 && !client.claims_policy.groups) {
    throw new Error(`OIDC_CLIENTS[${id}] maps groups but claims_policy denies groups`);
  }
  // `replace` with no map at all empties both claims outright.
  if (
    client.claims_mapping.mode === "replace" &&
    Object.keys(client.claims_mapping.roles).length === 0 &&
    Object.keys(client.claims_mapping.groups).length === 0
  ) {
    throw new Error(
      `OIDC_CLIENTS[${id}] sets claims_mapping.mode "replace" with no mapping, which would emit empty roles and groups`,
    );
  }
  if (client.resource_audiences.includes(id)) {
    throw new Error(
      `OIDC_CLIENTS[${id}].resource_audiences may not contain its own client_id: an ID token is minted with aud=client_id, so the resource server would accept it as an access token`,
    );
  }
}

/**
 * Refuse a registry where one client's id is another's resource audience.
 *
 * `aud` is the only thing a resource server has to tell "a token minted FOR me"
 * from "a token minted for somebody else". An ID token's `aud` is its client
 * id, so registering client `X` while some client declares `X` as a resource
 * audience makes every ID token issued to `X` — a token `X` itself holds and
 * logs — verify as an access token at the resource server behind `X`. The token
 * class check in `./tokens.ts` blocks that for consumers who use this
 * provider's verifier; this blocks it for the ones who do not.
 */
function assertNoAudienceCollisions(clients: Map<string, OidcClient>): void {
  const audienceOwners = new Map<string, string>();
  for (const client of clients.values()) {
    for (const audience of client.resource_audiences) {
      if (!audienceOwners.has(audience)) audienceOwners.set(audience, client.client_id);
    }
  }
  for (const clientId of clients.keys()) {
    const owner = audienceOwners.get(clientId);
    if (owner) {
      throw new Error(
        `OIDC_CLIENTS registers client_id "${clientId}", which OIDC_CLIENTS[${owner}] also declares as a resource audience; an ID token issued to "${clientId}" would verify as an access token for that resource`,
      );
    }
  }
}

function parseClient(raw: unknown, index: number): OidcClient {
  if (!raw || typeof raw !== "object") {
    throw new Error(`OIDC_CLIENTS[${index}] is not an object`);
  }
  const entry = raw as Record<string, unknown>;
  const clientId = typeof entry.client_id === "string" ? entry.client_id.trim() : "";
  if (!clientId) {
    throw new Error(`OIDC_CLIENTS[${index}] is missing client_id`);
  }
  const allowedScopes = stringList(entry.allowed_scopes, "allowed_scopes", clientId);
  const scopes = allowedScopes.length > 0 ? allowedScopes : [...DEFAULT_SCOPES];
  if (!scopes.includes("openid")) scopes.unshift("openid");

  const client: OidcClient = {
    client_id: clientId,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : clientId,
    secret_hashes: parseSecretHashes(entry, clientId),
    redirect_uris: parseRedirectUris(entry, clientId),
    allowed_scopes: scopes,
    resource_audiences: stringList(entry.resource_audiences, "resource_audiences", clientId),
    require_pkce: boolField(entry.require_pkce, false),
    require_verified_email: boolField(entry.require_verified_email, true),
    roles_allowlist: stringList(entry.roles_allowlist, "roles_allowlist", clientId),
    claims_policy: parseClaimsPolicy(entry.claims_policy),
    claims_mapping: parseClaimsMapping(entry.claims_mapping, clientId),
    constant_claims: parseConstantClaims(entry.constant_claims, clientId),
    id_token_ttl_seconds: ttlField(entry.id_token_ttl_seconds),
    access_token_ttl_seconds: ttlField(entry.access_token_ttl_seconds),
  };
  assertClientIsCoherent(client);
  return client;
}

/**
 * Validate one registry entry without touching the environment. The operator CLI
 * runs its generated entry through this before printing it, so a
 * `wrangler secret put` cannot ship a registry the Worker will refuse to load.
 */
export function parseOidcClientEntry(entry: unknown): OidcClient {
  return parseClient(entry, 0);
}

function loadClients(): Map<string, OidcClient> {
  const source = readSource();
  if (!source) {
    throw new Error("OIDC_CLIENTS is not configured");
  }
  if (cachedClients && cachedClientsSource === source) return cachedClients;

  let decoded: unknown;
  try {
    decoded = decodeSource(source);
  } catch (error) {
    // error-policy:J2 context-adding rethrow — never echo the raw value, which
    // is a secret, but do name the variable so the deploy is fixable.
    throw new Error("OIDC_CLIENTS is not valid JSON (or base64-wrapped JSON)", { cause: error });
  }

  const list = Array.isArray(decoded) ? decoded : [decoded];
  const map = new Map<string, OidcClient>();
  for (const [index, raw] of list.entries()) {
    const client = parseClient(raw, index);
    if (map.has(client.client_id)) {
      throw new Error(`OIDC_CLIENTS contains duplicate client_id "${client.client_id}"`);
    }
    map.set(client.client_id, client);
  }
  if (map.size === 0) {
    throw new Error("OIDC_CLIENTS must register at least one client");
  }
  assertNoAudienceCollisions(map);

  cachedClients = map;
  cachedClientsSource = source;
  return map;
}

export function getOidcClient(clientId: string | null | undefined): OidcClient | null {
  if (!clientId) return null;
  return loadClients().get(clientId) ?? null;
}

export function listOidcClients(): OidcClient[] {
  return [...loadClients().values()];
}

/** Exact string equality — no normalization, no prefix, no wildcard. */
export function isRegisteredRedirectUri(client: OidcClient, redirectUri: string | null): boolean {
  if (!redirectUri) return false;
  return client.redirect_uris.includes(redirectUri);
}

/**
 * Constant-time secret check against every accepted digest, so a rotation
 * window (old + new hash both listed) never leaks which one matched.
 */
export async function verifyOidcClientSecret(
  client: OidcClient,
  presented: string | null | undefined,
): Promise<boolean> {
  if (!presented) return false;
  const digest = await sha256Hex(presented);
  let matched = false;
  for (const hash of client.secret_hashes) {
    if (timingSafeEqualSecret(digest, hash)) matched = true;
  }
  return matched;
}

/** Granted scopes = requested ∩ allowed, order-preserved, deduplicated. */
export function intersectScopes(client: OidcClient, requested: string[]): string[] {
  const allowed = new Set(client.allowed_scopes);
  const granted: string[] = [];
  for (const scope of requested) {
    if (allowed.has(scope) && !granted.includes(scope)) granted.push(scope);
  }
  return granted;
}

/** Test-only: drop the memoized registry so a suite can swap `OIDC_CLIENTS`. */
export function _resetOidcClientCacheForTests(): void {
  cachedClients = null;
  cachedClientsSource = null;
}
