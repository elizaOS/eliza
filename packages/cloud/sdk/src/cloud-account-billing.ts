/**
 * Credential-bound reader for a signed-in device's Eliza Cloud account billing: the plan
 * fallback and organization credit state from `GET /api/v1/billing/limits`
 * (account-billing-snapshot v2), the signed subscription entitlement and its public keys,
 * subscription code redemption with an idempotency key, and self-revocation of the presented key.
 *
 * Every authenticated read is bound to the saved credential it started with: the host transport
 * presents exactly that credential, and the answer is used only if the same credential is still
 * saved (and unexpired) afterwards. A changed account is refused (`account-changed`) rather than
 * shown or applied to the new one. Nothing here stores, logs or returns a credential secret, and no
 * request is retried except one redemption replay with the same idempotency key after a transport
 * failure.
 *
 * Ports keep it host-neutral: the host owns HTTP, timeouts and secure storage. Only this package's
 * pure subscription-entitlement helpers and the snapshot types are used, so a product can project
 * these files from the pinned source (no parameter properties, so type stripping loads them).
 */
import type {
  AccountBalanceSnapshot,
  Observed,
} from "./account-billing-snapshot.js";
import {
  BILLING_LIMITS_PATH,
  ENTITLEMENT_KEYS_PATH,
  ENTITLEMENT_PATH,
  type EntitlementSource,
  entitlementFromResponse,
  entitlementKeysFromResponse,
  type FallbackPlan,
  fallbackPlanFromLimits,
  normalizeSubscriptionCode,
  type OrganizationCreditBalance,
  organizationCreditFromLimits,
  REDEEM_PATH,
  type RedeemResult,
  redeemFailureForStatus,
  redeemResultFromResponse,
  SubscriptionRedeemError,
} from "./subscription-entitlement.js";

/** Cloud's self-revocation route for the presented API key. */
export const CURRENT_API_KEY_PATH = "/api/v1/api-keys/current";

/** The `data.v2.balance` observation this reader interprets (account-billing-snapshot v2). */
export type BillingLimitsBalanceObservation = Observed<AccountBalanceSnapshot>;

/** A saved Cloud sign-in as the host stores it. Only `credentialId` is required to read billing. */
export interface CloudBillingCredential {
  /** Local generation identifier, never an authentication credential. */
  credentialId?: string;
  token?: string;
  credentialReference?: string;
  expiresAt?: number;
  userId?: string;
  organizationId?: string;
}

export type CloudBillingErrorCode =
  | "http"
  | "invalid-response"
  | "credentials-missing"
  | "account-changed"
  | "expired";

/** A refused or unusable billing read. HTTP refusals keep the status, body and Retry-After. */
export class CloudBillingError extends Error {
  readonly code: CloudBillingErrorCode;
  readonly status?: number;
  readonly data?: unknown;
  readonly retryAfter?: string;
  // Explicit fields (no parameter properties) so type-stripping consumers can load this file.
  constructor(
    code: CloudBillingErrorCode,
    status?: number,
    data?: unknown,
    retryAfter?: string,
  ) {
    super(`Cloud billing ${code}${status ? ` (${status})` : ""}`);
    this.name = "CloudBillingError";
    this.code = code;
    this.status = status;
    this.data = data;
    this.retryAfter = retryAfter;
  }
}

export interface CloudBillingRequest {
  path: string;
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  /** The saved credential this request must present; absent for a public read. */
  credential?: CloudBillingCredential;
  signal: AbortSignal;
}
export interface CloudBillingResponse {
  status: number;
  data: unknown;
  /** Raw Retry-After header of an error response, when present. */
  retryAfter?: string;
}

export interface CloudAccountBillingPorts {
  /** The saved credential for this account's environment, or null when signed out. */
  readCredential(): Promise<CloudBillingCredential | null>;
  /**
   * Sends one request with redirects refused. An authenticated request must present exactly
   * `credential` and must throw (not send) when the store no longer holds it. Network failures
   * throw; HTTP answers resolve with their status.
   */
  request(input: CloudBillingRequest): Promise<CloudBillingResponse>;
  /** Whether a thrown transport error may be replayed once for redemption. Default: any error. */
  replayable?(error: unknown): boolean;
  /** Whether the transport can send DELETE (self-revocation). Default false. */
  deleteRequests?: boolean;
  /** Waits before the single redemption replay; the default waits one second. */
  delay?(ms: number, signal: AbortSignal): Promise<void>;
  now?(): number;
}

/** Server-side revocation of the presented key. `supported:false` means nothing was confirmed. */
export type CloudKeyRevocation =
  | {
      supported: true;
      revoked: true;
      credentialId: string | null;
      revokedAt: string | null;
    }
  | { supported: false; reason: "transport" | "server" | "no-credential" };

const ABSENT_ROUTE = new Set([404, 405, 501]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CloudBillingError("invalid-response");
  return value as Record<string, unknown>;
}

function binding(credential: CloudBillingCredential): string {
  return JSON.stringify([
    credential.credentialId,
    credential.credentialReference,
    credential.token,
    credential.userId,
    credential.organizationId,
  ]);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class CloudAccountBillingClient {
  private readonly ports: CloudAccountBillingPorts;
  constructor(ports: CloudAccountBillingPorts) {
    this.ports = ports;
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** The saved credential a read is bound to. */
  private async bound(signal: AbortSignal): Promise<CloudBillingCredential> {
    signal.throwIfAborted();
    const credential = await this.ports.readCredential();
    signal.throwIfAborted();
    if (!credential?.credentialId)
      throw new CloudBillingError("credentials-missing");
    if (
      credential.expiresAt !== undefined &&
      credential.expiresAt <= this.now()
    )
      throw new CloudBillingError("expired");
    return credential;
  }

  /** The answer belongs to the credential still saved, unexpired; otherwise it is discarded. */
  private async assertSame(
    credential: CloudBillingCredential,
    signal: AbortSignal,
    exact = false,
  ): Promise<void> {
    const current = await this.ports.readCredential();
    signal.throwIfAborted();
    if (
      !current ||
      current.credentialId !== credential.credentialId ||
      (exact && binding(current) !== binding(credential))
    )
      throw new CloudBillingError("account-changed");
    if (current.expiresAt !== undefined && current.expiresAt <= this.now())
      throw new CloudBillingError("expired");
  }

  private async send(
    path: string,
    signal: AbortSignal,
    options: {
      method?: CloudBillingRequest["method"];
      body?: unknown;
      credential?: CloudBillingCredential;
    } = {},
  ): Promise<unknown> {
    const response = await this.ports.request({
      path,
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.credential ? { credential: options.credential } : {}),
      signal,
    });
    signal.throwIfAborted();
    if (response.status < 200 || response.status >= 300)
      throw new CloudBillingError(
        "http",
        response.status,
        response.data,
        response.retryAfter,
      );
    return response.data;
  }

  /**
   * Plan state from the billing snapshot, used while the signed entitlement route is absent.
   * `null` when the snapshot route is absent too or does not report a known plan state.
   */
  async fallbackPlan(signal: AbortSignal): Promise<FallbackPlan | null> {
    const credential = await this.bound(signal);
    let data: Record<string, unknown>;
    try {
      data = record(
        await this.send(BILLING_LIMITS_PATH, signal, { credential }),
      );
    } catch (error) {
      if (
        error instanceof CloudBillingError &&
        error.code === "http" &&
        ABSENT_ROUTE.has(error.status ?? 0)
      )
        return null;
      throw error;
    }
    await this.assertSame(credential, signal);
    if (data.success !== true) return null;
    return fallbackPlanFromLimits(data);
  }

  /**
   * The organization credit balance (zero, funded or unavailable) for the exact saved sign-in.
   * A read-only account fact: never a top-up meter and never a grant of spending authority.
   */
  async credits(signal: AbortSignal): Promise<OrganizationCreditBalance> {
    const credential = await this.bound(signal);
    const payload = await this.send(BILLING_LIMITS_PATH, signal, {
      credential,
    });
    record(payload);
    await this.assertSame(credential, signal, true);
    return organizationCreditFromLimits(payload, this.now());
  }

  /**
   * Short-lived signed subscription entitlement for the saved sign-in. `null` means the deployed
   * Cloud does not offer the route (404/405/501).
   */
  async entitlement(signal: AbortSignal): Promise<string | null> {
    const credential = await this.bound(signal);
    let data: unknown;
    try {
      data = record(await this.send(ENTITLEMENT_PATH, signal, { credential }));
    } catch (error) {
      if (
        error instanceof CloudBillingError &&
        error.code === "http" &&
        ABSENT_ROUTE.has(error.status ?? 0)
      )
        return null;
      throw error;
    }
    await this.assertSame(credential, signal);
    const entitlement = entitlementFromResponse(data);
    if (entitlement === null) throw new CloudBillingError("invalid-response");
    return entitlement;
  }

  /** Public ES256 verification keys for entitlements. Never private material; unauthenticated. */
  async entitlementKeys(signal: AbortSignal): Promise<JsonWebKey[]> {
    const keys = entitlementKeysFromResponse(
      record(await this.send(ENTITLEMENT_KEYS_PATH, signal)),
    );
    if (keys === null) throw new CloudBillingError("invalid-response");
    return keys;
  }

  /** Entitlement ports for `checkEntitlement`, bound to this reader. */
  entitlementSource(issuer: string, audience?: string): EntitlementSource {
    return {
      issuer,
      ...(audience === undefined ? {} : { audience }),
      entitlement: (signal) => this.entitlement(signal),
      entitlementKeys: (signal) => this.entitlementKeys(signal),
      fallbackPlan: (signal) => this.fallbackPlan(signal),
    };
  }

  /**
   * Redeems a subscription grant code for the saved sign-in. `idempotencyKey` is fresh for each
   * owner submission; a transport failure (the request may have arrived) is replayed once with the
   * same key, which Cloud answers with the original grant. HTTP refusals are never retried and map
   * to the owner's redemption copy; 401 stays a `CloudBillingError` (a rejected sign-in). The code
   * is never logged, stored or put in an error.
   */
  async redeem(
    code: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<RedeemResult> {
    signal.throwIfAborted();
    const normalized = normalizeSubscriptionCode(code);
    if (!normalized) throw new SubscriptionRedeemError("invalid");
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
      throw new TypeError("Invalid idempotency key");
    const credential = await this.bound(signal);
    let data: unknown;
    for (let attempt = 0; data === undefined; attempt++) {
      try {
        data = record(
          await this.send(REDEEM_PATH, signal, {
            credential,
            body: { code: normalized, idempotencyKey },
          }),
        );
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CloudBillingError) {
          if (error.code !== "http") throw error;
          throw (
            redeemFailureForStatus(
              error.status ?? 0,
              error.data,
              error.retryAfter,
            ) ?? error
          );
        }
        if (this.ports.replayable && !this.ports.replayable(error)) throw error;
        // Transport failure: the request may have reached Cloud. One replay with the same key.
        if (attempt >= 1) throw new SubscriptionRedeemError("unavailable");
        await (this.ports.delay ?? wait)(1000, signal);
      }
    }
    await this.assertSame(credential, signal);
    return redeemResultFromResponse(data);
  }

  /**
   * Revokes `credential` with Cloud's self-revocation route (`DELETE /api/v1/api-keys/current`).
   * One attempt, never retried. The host clears its local copy whatever the answer.
   */
  async revoke(
    credential: CloudBillingCredential | null,
    signal: AbortSignal,
  ): Promise<CloudKeyRevocation> {
    signal.throwIfAborted();
    if (!credential) return { supported: false, reason: "no-credential" };
    if (!this.ports.deleteRequests)
      return { supported: false, reason: "transport" };
    let data: unknown;
    try {
      data = await this.send(CURRENT_API_KEY_PATH, signal, {
        method: "DELETE",
        credential,
      });
    } catch (error) {
      if (
        error instanceof CloudBillingError &&
        error.code === "http" &&
        ABSENT_ROUTE.has(error.status ?? 0)
      )
        return { supported: false, reason: "server" };
      throw error;
    }
    const result = record(data);
    if (
      result.success !== true ||
      (result.status !== undefined && result.status !== "revoked")
    )
      throw new CloudBillingError("invalid-response");
    return {
      supported: true,
      revoked: true,
      credentialId:
        typeof result.credentialId === "string" ? result.credentialId : null,
      revokedAt: typeof result.revokedAt === "string" ? result.revokedAt : null,
    };
  }
}
