/**
 * Resolves canonical Network membership from a trusted, authenticated Cloud account.
 * Server owners supply fresh account and organization projections; this boundary
 * performs no account creation, inference, or automatic runtime loading.
 */

import { createHash } from "node:crypto";
import { MediaFetchError, readResponseWithLimit } from "@elizaos/core";
import type { UUID } from "@elizaos/core/protocol";
import { ElizaError, uuidFromString } from "@elizaos/core/protocol";
import type { Organization } from "../../../db/schemas/organizations";
import type { User } from "../../../db/schemas/users";
import type { AuthedUser } from "../../../types/cloud-worker-env";
import { DEFAULT_REST_RESPONSE_MAX_BYTES } from "../../utils/owned-bounded-fetch";
import { isValidE164, validatePhoneForAPI } from "../../utils/phone-normalization";

// Wire projection of the private Network apps owner; cross-repository integration
// checks keep this transport boundary aligned with platform/src/apps.ts.
export type NetworkAppId = "ntwrk" | "slop" | "peon" | "friends";

export function isNetworkAppId(value: unknown): value is NetworkAppId {
  return value === "ntwrk" || value === "slop" || value === "peon" || value === "friends";
}

/** A server service binding, never a caller-selected URL or public fetch fallback. */
export interface NetworkMembershipFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface NetworkMembershipAccount {
  authenticatedUser: Pick<
    AuthedUser,
    "id" | "organization_id" | "organization" | "is_active" | "is_anonymous"
  >;
  user: Pick<
    User,
    | "id"
    | "organization_id"
    | "is_active"
    | "is_anonymous"
    | "account_lifecycle_state"
    | "account_deletion_request_id"
    | "auth_fenced_at"
    | "deleted_at"
    | "phone_number"
    | "phone_verified"
  >;
  organization: Pick<
    Organization,
    "id" | "is_active" | "account_lifecycle_state" | "account_deletion_request_id"
  >;
}

export interface NetworkMembershipBinding {
  cloudUserId: string;
  organizationId: string;
  app: NetworkAppId;
  personId: string;
  memberId: string;
  /** App-bound authorization identity; never a conversation or history room. */
  scopeId: UUID;
}

/** Derives app authorization scope without choosing or changing a conversation. */
export function networkMembershipScopeId(binding: Omit<NetworkMembershipBinding, "scopeId">): UUID {
  return uuidFromString(
    JSON.stringify([
      "network-membership-scope",
      binding.app,
      binding.organizationId,
      binding.cloudUserId,
      binding.personId,
      binding.memberId,
    ]),
    (value) => createHash("sha1").update(value).digest(),
  );
}

/** Minimal self-context returned by Network's authenticated private owner. */
export interface NetworkMemberContext {
  app: NetworkAppId;
  memberId: string;
  firstName: string;
  city: string;
  state: "open" | "busy" | "traveling" | "paused";
  stateFrom?: string | null;
  stateUntil: string | null;
  facets: string[];
  activeItems: Array<{ kind: string; summary: string }> | null;
}

/** Shared wire parser for the private HTTP and trusted coordinator boundaries. */
export function parseNetworkMemberContext(
  body: unknown,
  app: NetworkAppId,
  memberId: string,
): NetworkMemberContext | null {
  if (
    typeof body !== "object" ||
    body === null ||
    !("app" in body) ||
    body.app !== app ||
    !("memberId" in body) ||
    body.memberId !== memberId ||
    !("firstName" in body) ||
    typeof body.firstName !== "string" ||
    !("city" in body) ||
    typeof body.city !== "string" ||
    !("state" in body) ||
    (body.state !== "open" &&
      body.state !== "busy" &&
      body.state !== "traveling" &&
      body.state !== "paused") ||
    ("stateFrom" in body && body.stateFrom !== null && typeof body.stateFrom !== "string") ||
    !("stateUntil" in body) ||
    (body.stateUntil !== null && typeof body.stateUntil !== "string") ||
    !("facets" in body) ||
    !Array.isArray(body.facets) ||
    body.facets.some((facet) => typeof facet !== "string") ||
    !("activeItems" in body) ||
    (body.activeItems !== null &&
      (!Array.isArray(body.activeItems) ||
        body.activeItems.some(
          (item) =>
            typeof item !== "object" ||
            item === null ||
            typeof item.kind !== "string" ||
            typeof item.summary !== "string" ||
            Object.keys(item).length !== 2,
        ))) ||
    Object.keys(body).some(
      (key) =>
        ![
          "app",
          "memberId",
          "firstName",
          "city",
          "state",
          "stateFrom",
          "stateUntil",
          "facets",
          "activeItems",
        ].includes(key),
    )
  ) {
    return null;
  }
  return body as NetworkMemberContext;
}

function invalidAccount(): never {
  throw new ElizaError("Network membership requires an active verified Cloud account", {
    code: "NETWORK_MEMBERSHIP_ACCOUNT_INVALID",
  });
}

function canonicalIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s|[\u0000-\u001f\u007f]/u.test(value);
}

function verifiedAccountPhone(account: NetworkMembershipAccount): string {
  const { authenticatedUser: auth, user, organization: org } = account;
  if (
    !canonicalIdentifier(auth.id) ||
    !canonicalIdentifier(org.id) ||
    auth.id !== user.id ||
    auth.organization_id !== org.id ||
    auth.organization?.id !== org.id ||
    user.organization_id !== org.id ||
    auth.is_active !== true ||
    auth.organization.is_active !== true ||
    auth.is_anonymous !== false ||
    user.is_active !== true ||
    user.is_anonymous !== false ||
    user.account_lifecycle_state !== "active" ||
    user.account_deletion_request_id !== null ||
    user.auth_fenced_at !== null ||
    user.deleted_at !== null ||
    org.is_active !== true ||
    org.account_lifecycle_state !== "active" ||
    org.account_deletion_request_id !== null ||
    user.phone_verified !== true ||
    typeof user.phone_number !== "string" ||
    !isValidE164(user.phone_number)
  ) {
    invalidAccount();
  }
  const phone = validatePhoneForAPI(user.phone_number);
  if (!phone.valid || phone.normalized !== user.phone_number) invalidAccount();
  return user.phone_number;
}

/** The constructor accepts only server-owned binding configuration. */
export class NetworkMembershipClient {
  readonly #fetcher: NetworkMembershipFetcher;
  readonly #credential: string;

  constructor(fetcher: NetworkMembershipFetcher, serverCredential: string) {
    if (!serverCredential || /\s|[\u0000-\u001f\u007f]/u.test(serverCredential)) {
      throw new ElizaError("Network membership server credential is unavailable", {
        code: "NETWORK_MEMBERSHIP_CONFIGURATION_INVALID",
      });
    }
    this.#fetcher = fetcher;
    this.#credential = serverCredential;
  }

  /** Null means the private owner returned 404; every other failure stays explicit. */
  async resolve(
    account: NetworkMembershipAccount,
    appId: NetworkAppId,
    signal?: AbortSignal,
  ): Promise<NetworkMembershipBinding | null> {
    signal?.throwIfAborted();
    if (!isNetworkAppId(appId)) {
      throw new ElizaError("Network membership requires an explicit supported app", {
        code: "NETWORK_MEMBERSHIP_APP_INVALID",
      });
    }
    // Snapshot identity before awaiting I/O so mutable caller projections cannot
    // bind a lookup performed for one account to another account's room.
    const cloudUserId = account.user.id;
    const organizationId = account.organization.id;
    const result = await this.#read(verifiedAccountPhone(account), appId, "membership", signal);
    if (!result.available) return null;
    const body = result.body;
    if (
      typeof body !== "object" ||
      body === null ||
      !("app" in body) ||
      !("personId" in body) ||
      !("memberId" in body) ||
      Object.keys(body).length !== 3 ||
      body.app !== appId ||
      !canonicalIdentifier(body.personId) ||
      !canonicalIdentifier(body.memberId)
    ) {
      throw new ElizaError("Network membership response was outside the canonical scope", {
        code: "NETWORK_MEMBERSHIP_RESPONSE_INVALID",
      });
    }
    return {
      cloudUserId,
      organizationId,
      app: appId,
      personId: body.personId,
      memberId: body.memberId,
      scopeId: networkMembershipScopeId({
        cloudUserId,
        organizationId,
        app: appId,
        personId: body.personId,
        memberId: body.memberId,
      }),
    };
  }

  /** Uses Network's canonical read-only routing owner; Cloud defines no keyword map. */
  async resolveForText(
    account: NetworkMembershipAccount,
    text: string,
    signal?: AbortSignal,
  ): Promise<NetworkMembershipBinding | null> {
    signal?.throwIfAborted();
    if (typeof text !== "string" || !text.trim()) {
      throw new ElizaError("Network routing requires a complete user message", {
        code: "NETWORK_ROUTE_INPUT_INVALID",
      });
    }
    const cloudUserId = account.user.id;
    const organizationId = account.organization.id;
    // Both hops assert the same verified phone, even if a caller projection changes during I/O.
    const e164 = verifiedAccountPhone(account);
    const eligibility = await this.#read(e164, undefined, "membership-status", signal);
    if (!eligibility.available) return null;
    const status = eligibility.body;
    if (
      typeof status !== "object" ||
      status === null ||
      !("active" in status) ||
      typeof status.active !== "boolean" ||
      Object.keys(status).length !== 1
    ) {
      throw new ElizaError("Network membership status response was invalid", {
        code: "NETWORK_MEMBERSHIP_RESPONSE_INVALID",
      });
    }
    if (!status.active) return null;
    const result = await this.#read(e164, undefined, "route", signal, text);
    if (!result.available) return null;
    const body = result.body;
    if (
      typeof body !== "object" ||
      body === null ||
      !("app" in body) ||
      !isNetworkAppId(body.app) ||
      !("personId" in body) ||
      !canonicalIdentifier(body.personId) ||
      !("memberId" in body) ||
      !canonicalIdentifier(body.memberId) ||
      Object.keys(body).length !== 3
    ) {
      throw new ElizaError("Network routing returned an invalid membership binding", {
        code: "NETWORK_MEMBERSHIP_RESPONSE_INVALID",
      });
    }
    const binding = {
      cloudUserId,
      organizationId,
      app: body.app,
      personId: body.personId,
      memberId: body.memberId,
    };
    return { ...binding, scopeId: networkMembershipScopeId(binding) };
  }

  /** Reads self-context only after a matching membership binding has been resolved. */
  async resolveContext(
    account: NetworkMembershipAccount,
    membership: NetworkMembershipBinding,
    signal?: AbortSignal,
  ): Promise<NetworkMemberContext | null> {
    if (
      membership.cloudUserId !== account.user.id ||
      membership.organizationId !== account.organization.id
    ) {
      invalidAccount();
    }
    signal?.throwIfAborted();
    const result = await this.#read(
      verifiedAccountPhone(account),
      membership.app,
      "context",
      signal,
    );
    if (!result.available) return null;
    const body = result.body;
    const context = parseNetworkMemberContext(body, membership.app, membership.memberId);
    if (!context) {
      throw new ElizaError(
        "Network self-context response was outside the resolved membership scope",
        {
          code: "NETWORK_CONTEXT_RESPONSE_INVALID",
        },
      );
    }
    return context;
  }

  async #read(
    e164: string,
    appId: NetworkAppId | undefined,
    operation: "membership" | "context" | "route" | "membership-status",
    signal?: AbortSignal,
    routeText?: string,
  ): Promise<{ available: false } | { available: true; body: unknown }> {
    signal?.throwIfAborted();
    const unscoped = operation === "route" || operation === "membership-status";
    if (!unscoped && !isNetworkAppId(appId)) {
      throw new ElizaError("Network membership requires an explicit supported app", {
        code: "NETWORK_MEMBERSHIP_APP_INVALID",
      });
    }
    const request = new Request(
      `https://network.internal/agent/${operation}${unscoped ? "" : `?app=${appId}`}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#credential}`,
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify(operation === "route" ? { e164, text: routeText } : { e164 }),
        redirect: "error",
        cache: "no-store",
        signal,
      },
    );
    let response: Response;
    try {
      response = await this.#fetcher.fetch(request);
    } catch {
      // error-policy:J1 transport failures are sanitized at the credential boundary;
      // arbitrary binding errors may contain authorization headers or phone data.
      signal?.throwIfAborted();
      throw new ElizaError("Network membership transport failed", {
        code: "NETWORK_MEMBERSHIP_TRANSPORT_FAILED",
      });
    }
    signal?.throwIfAborted();
    if (response.redirected || (response.status !== 200 && response.status !== 404)) {
      throw new ElizaError("Network membership owner rejected the lookup", {
        code: "NETWORK_MEMBERSHIP_LOOKUP_FAILED",
        context: { status: response.status },
      });
    }
    if (response.status === 404) return { available: false };
    let body: unknown;
    try {
      // Use the shared REST byte ceiling, never truncate individual approved facts.
      body = JSON.parse(
        (await readResponseWithLimit(response, DEFAULT_REST_RESPONSE_MAX_BYTES)).toString("utf8"),
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof MediaFetchError && error.code === "max_bytes") {
        throw new ElizaError("Network membership response exceeded the bounded-body contract", {
          code: "NETWORK_MEMBERSHIP_RESPONSE_TOO_LARGE",
        });
      }
      // error-policy:J3 invalid JSON is an explicit protocol failure without body leakage.
      throw new ElizaError("Network membership response was not JSON", {
        code: "NETWORK_MEMBERSHIP_RESPONSE_INVALID",
      });
    }
    signal?.throwIfAborted();
    return { available: true, body };
  }
}
