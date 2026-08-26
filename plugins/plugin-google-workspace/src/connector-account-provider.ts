/**
 * Google ConnectorAccountManager provider.
 *
 * Bridges plugin-google-workspace to the @elizaos/core ConnectorAccountManager so the
 * generic HTTP CRUD + OAuth surface (packages/agent/src/api/connector-account-routes.ts)
 * can list, create, patch, delete, and run the OAuth flow for Google accounts
 * using a single consolidated grant covering Gmail, Calendar, Drive, and Meet.
 *
 * Single OAuth grant per account: callers must pass an explicit `scopes`
 * capability subset to the manager's startOAuth. Omitted or empty scope lists
 * fail closed instead of expanding to every supported capability. Granted
 * capabilities are recorded on the returned account so downstream consumers
 * know which surfaces are usable.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  type ConnectorAccount,
  type ConnectorAccountCredentialRefRecord,
  type ConnectorAccountManager,
  type ConnectorAccountPatch,
  type ConnectorAccountProvider,
  type ConnectorAccountPurpose,
  type ConnectorAccountRole,
  type ConnectorOAuthCallbackRequest,
  type ConnectorOAuthCallbackResult,
  type ConnectorOAuthStartRequest,
  type ConnectorOAuthStartResult,
  ElizaError,
  type IAgentRuntime,
  logger,
  type UUID,
} from "@elizaos/core";
import { OAuth2Client } from "google-auth-library";
import { GOOGLE_OAUTH_PROVIDER_METADATA } from "./auth.js";
import {
  buildConnectorCredentialVaultRef,
  CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES,
  CONNECTOR_VAULT_SERVICE_TYPES,
  persistConnectorCredentialRefs,
} from "./connector-credential-refs.js";
import { createGmailMessageConnector } from "./gmail-message-connector.js";
import { resolveGoogleConnectorOAuthCallbackUrl } from "./google-oauth-callback.js";
import {
  GOOGLE_CAPABILITIES,
  GOOGLE_IDENTITY_SCOPES,
  type GoogleCapability,
  type GoogleCapabilityGroup,
  isGoogleCapability,
  scopesForGoogleCapabilities,
} from "./scopes.js";
import { GOOGLE_SERVICE_NAME } from "./types.js";

const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_OAUTH_REVOKED_AT_METADATA_KEY = "oauthRevokedAt";

/** Maximum time allowed for one Google OAuth or userinfo request. */
export const GOOGLE_OAUTH_FETCH_TIMEOUT_MS = 15_000;

const GROUP_PURPOSE: Record<GoogleCapabilityGroup, ConnectorAccountPurpose> = {
  gmail: "messaging" as ConnectorAccountPurpose,
  calendar: "calendar" as ConnectorAccountPurpose,
  drive: "drive" as ConnectorAccountPurpose,
  meet: "meet" as ConnectorAccountPurpose,
  people: "contacts" as ConnectorAccountPurpose,
};

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

interface GoogleIdentity {
  sub?: string;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
}

interface GoogleIdTokenVerifier {
  verifyIdToken(options: { idToken: string; audience: string }): Promise<{ getPayload(): unknown }>;
}

interface GoogleCalendarWatchRevocationService {
  revokeGoogleCalendarWatchesByAccount(accountId: string): Promise<void>;
}

function isGoogleCalendarWatchRevocationService(
  value: unknown
): value is GoogleCalendarWatchRevocationService {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<GoogleCalendarWatchRevocationService>)
      .revokeGoogleCalendarWatchesByAccount === "function"
  );
}

function createCodeVerifier(): string {
  return randomBytes(64).toString("base64url");
}

function createOidcNonce(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Derives the durable connector-account key for a newly authorized Google
 * identity. The provider subject is stable across email/name changes, while
 * the role keeps an owner grant distinct from an intentionally separate agent
 * grant for the same Google account.
 */
export function stableGoogleConnectorAccountId(
  subject: string,
  role: ConnectorAccountRole
): string {
  const digest = createHash("sha256").update(`${role}\u0000${subject}`).digest("hex").slice(0, 32);
  return `acct_google_${digest}`;
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ResolvedCredentialSecret {
  secret: string;
  remove(): Promise<void>;
}

type OAuthCredentialRefSnapshot = ConnectorAccountCredentialRefRecord;

function credentialAdapter(runtime: IAgentRuntime) {
  return runtime.adapter as typeof runtime.adapter & {
    deleteConnectorAccountCredentialRefs(params: { accountId: UUID }): Promise<number>;
  };
}

async function restoreCredentialRefs(
  runtime: IAgentRuntime,
  accountId: string,
  refs: OAuthCredentialRefSnapshot[]
): Promise<void> {
  await credentialAdapter(runtime).deleteConnectorAccountCredentialRefs({
    accountId: accountId as UUID,
  });
  for (const ref of refs) {
    await runtime.adapter.setConnectorAccountCredentialRef({
      accountId: accountId as UUID,
      credentialType: ref.credentialType,
      vaultRef: ref.vaultRef,
      ...(ref.metadata ? { metadata: ref.metadata } : {}),
      ...(ref.expiresAt != null ? { expiresAt: ref.expiresAt } : {}),
      ...(ref.lastVerifiedAt != null ? { lastVerifiedAt: ref.lastVerifiedAt } : {}),
    });
  }
}

async function removeCredentialIfPresent(runtime: IAgentRuntime, vaultRef: string): Promise<void> {
  try {
    const stored = await resolveCredentialSecret(runtime, vaultRef);
    await stored.remove();
  } catch (error) {
    // error-policy:J4 A failed OAuth commit may not have reached the vault;
    // absence is the expected rollback state, while every other cleanup error
    // remains fatal to compensation.
    if (error instanceof ElizaError && error.code === "GOOGLE_OAUTH_CREDENTIAL_NOT_FOUND") return;
    throw error;
  }
}

async function compensateOAuthCompletion(args: {
  runtime: IAgentRuntime;
  manager: ConnectorAccountManager;
  tokens: GoogleTokenResponse;
  originalError: unknown;
  existingAccount: ConnectorAccount | null;
  priorCredentialRefs: OAuthCredentialRefSnapshot[];
  pendingAccountId?: string;
  attemptedVaultRef?: string;
}): Promise<never> {
  const compensationErrors: unknown[] = [];
  const revocationToken = nonEmptyString(args.tokens.refresh_token) ?? args.tokens.access_token;
  try {
    await revokeGoogleOAuthGrantWithFetch(revocationToken);
  } catch (error) {
    // error-policy:J2 Retain remote compensation failure alongside the
    // original post-exchange failure so a live grant is never reported as
    // successfully rolled back.
    compensationErrors.push(error);
  }

  if (args.attemptedVaultRef) {
    try {
      await removeCredentialIfPresent(args.runtime, args.attemptedVaultRef);
    } catch (error) {
      // error-policy:J2 Local secret cleanup failure is accumulated with the
      // authoritative completion failure and any remote revocation failure.
      compensationErrors.push(error);
    }
  }

  if (args.pendingAccountId) {
    try {
      await restoreCredentialRefs(args.runtime, args.pendingAccountId, args.priorCredentialRefs);
      if (args.existingAccount) {
        await args.manager.getStorage().upsertAccount(args.existingAccount);
      } else {
        await args.manager.getStorage().deleteAccount(GOOGLE_SERVICE_NAME, args.pendingAccountId);
      }
    } catch (error) {
      // error-policy:J2 Account/ref restoration failure is retained; callers
      // must see that compensation was incomplete rather than the initial
      // validation or writer failure alone.
      compensationErrors.push(error);
    }
  }

  if (compensationErrors.length === 0) throw args.originalError;
  throw new ElizaError("Google OAuth completion failed and compensation was incomplete.", {
    code: "GOOGLE_OAUTH_COMPLETION_COMPENSATION_FAILED",
    cause: new AggregateError(
      [args.originalError, ...compensationErrors],
      "Google OAuth completion and compensation failed"
    ),
    context: {
      accountId: args.pendingAccountId,
      compensationFailureCount: compensationErrors.length,
    },
    severity: "fatal",
  });
}

function runtimeService(runtime: IAgentRuntime, names: readonly string[]): unknown {
  for (const name of names) {
    const service = runtime.getService?.(name);
    if (service) return service;
  }
  return null;
}

async function resolveCredentialSecret(
  runtime: IAgentRuntime,
  vaultRef: string
): Promise<ResolvedCredentialSecret> {
  const candidates = [
    runtimeService(runtime, CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES),
    runtimeService(runtime, CONNECTOR_VAULT_SERVICE_TYPES),
  ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  const errors: unknown[] = [];
  for (const candidate of candidates) {
    const store = candidate as {
      get?: (
        key: string,
        options?: { reveal?: boolean; caller?: string }
      ) => Promise<string | null> | string | null;
      reveal?: (key: string, caller?: string) => Promise<string> | string;
      has?: (key: string) => Promise<boolean> | boolean;
      remove?: (key: string) => Promise<void> | void;
    };
    if (typeof store.remove !== "function") continue;
    try {
      if (typeof store.has === "function" && !(await store.has(vaultRef))) {
        continue;
      }
      const value =
        typeof store.reveal === "function"
          ? await store.reveal(vaultRef, "plugin-google-workspace:disconnect")
          : await store.get?.(vaultRef, {
              reveal: true,
              caller: "plugin-google-workspace:disconnect",
            });
      if (typeof value === "string" && value.length > 0) {
        return {
          secret: value,
          remove: async () => {
            await store.remove?.(vaultRef);
          },
        };
      }
    } catch (error) {
      // error-policy:J2 Every candidate failure is retained and the final
      // typed error identifies the ref without exposing credential material.
      errors.push(error);
    }
  }
  if (candidates.length > 0 && errors.length === 0) {
    throw new ElizaError("Google connector credential was already removed.", {
      code: "GOOGLE_OAUTH_CREDENTIAL_NOT_FOUND",
      context: { vaultRef },
    });
  }
  throw new ElizaError("Google connector credential could not be read for secure deletion.", {
    code: "GOOGLE_OAUTH_CREDENTIAL_CLEANUP_UNAVAILABLE",
    context: { vaultRef, candidateCount: candidates.length },
    cause: errors[0],
    severity: "fatal",
  });
}

function revocationTokenFromSecret(secret: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch (error) {
    // error-policy:J3 Stored credential material is untrusted at this boundary;
    // malformed data becomes a typed failure and is never treated as revoked.
    throw new ElizaError("Google OAuth credential payload is malformed.", {
      code: "GOOGLE_OAUTH_CREDENTIAL_MALFORMED",
      cause: error,
      severity: "fatal",
    });
  }
  if (!isRecord(parsed)) {
    throw new ElizaError("Google OAuth credential payload is malformed.", {
      code: "GOOGLE_OAUTH_CREDENTIAL_MALFORMED",
      severity: "fatal",
    });
  }
  const token = nonEmptyString(parsed.refresh_token) ?? nonEmptyString(parsed.access_token);
  if (!token) {
    throw new ElizaError("Google OAuth credential has no revocable token.", {
      code: "GOOGLE_OAUTH_REVOCATION_TOKEN_MISSING",
      severity: "fatal",
    });
  }
  return token;
}

export async function revokeGoogleOAuthGrantWithFetch(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = GOOGLE_OAUTH_FETCH_TIMEOUT_MS
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_OAUTH_PROVIDER_METADATA.revokeEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // error-policy:J2 Network and timeout failures must remain distinguishable
    // from a confirmed revocation, while preserving their original cause.
    throw new ElizaError("Google OAuth revocation request failed.", {
      code: "GOOGLE_OAUTH_REVOCATION_REQUEST_FAILED",
      cause: error,
      severity: "fatal",
    });
  }
  if (!response.ok) {
    let errorCode: string | undefined;
    try {
      const body: unknown = await response.json();
      errorCode = isRecord(body) ? nonEmptyString(body.error) : undefined;
    } catch {
      // error-policy:J3 A malformed provider error body never becomes success.
      errorCode = undefined;
    }
    // Google's documented invalid_token response means the token is expired
    // or already revoked, so the grant no longer authorizes API access and the
    // idempotent disconnect may safely continue local cleanup.
    if (errorCode === "invalid_token") return;
    throw new ElizaError(`Google OAuth revocation failed with ${response.status}.`, {
      code: "GOOGLE_OAUTH_REVOCATION_FAILED",
      context: { status: response.status, errorCode },
      severity: "fatal",
    });
  }
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  return nonEmptyString(runtime.getSetting?.(key));
}

function readClientConfig(
  runtime: IAgentRuntime,
  servedOrigin?: string
): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = readSetting(runtime, "GOOGLE_CLIENT_ID");
  const clientSecret = readSetting(runtime, "GOOGLE_CLIENT_SECRET");
  const redirectUri = resolveGoogleConnectorOAuthCallbackUrl(
    runtime,
    servedOrigin ? { servedOrigin } : undefined
  );
  if (!clientId || !clientSecret) {
    throw new Error(
      "Google OAuth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to be configured."
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/**
 * Re-auth of an existing account that OMITS `scopes` defaults to exactly the
 * account's recorded granted capabilities — least privilege, re-requesting
 * what was granted and never expanding it (#18543).
 *
 * Branch on property semantics, not length: an explicitly supplied array
 * (including an empty `[]`) is returned unchanged so it flows to
 * normalizeRequestedCapabilities, which fails closed on empty. Per #18454 an
 * explicit empty selection is NOT consent to restore prior authority; only a
 * genuinely omitted field consults the account. New-account starts (no usable
 * `accountId`, no recorded grant) also keep failing closed downstream.
 */
async function resolveRequestedScopes(
  request: ConnectorOAuthStartRequest,
  manager: ConnectorAccountManager
): Promise<readonly string[] | undefined> {
  if (request.scopes !== undefined) {
    return request.scopes;
  }
  const accountId = nonEmptyString(request.accountId);
  if (!accountId) {
    return request.scopes;
  }
  const account = await manager.getAccount(GOOGLE_SERVICE_NAME, accountId);
  const recorded = (account?.metadata as Record<string, unknown> | undefined)?.grantedCapabilities;
  if (!Array.isArray(recorded)) {
    return request.scopes;
  }
  const granted = recorded.filter((value): value is GoogleCapability => isGoogleCapability(value));
  return granted.length > 0 ? granted : request.scopes;
}

function normalizeRequestedCapabilities(scopes: readonly string[] | undefined): GoogleCapability[] {
  if (!scopes || scopes.length === 0) {
    throw new ElizaError(
      "Google OAuth requires an explicit Gmail, Calendar, Drive, or Meet capability selection.",
      {
        code: "GOOGLE_OAUTH_CAPABILITY_REQUIRED",
        context: { scopes: scopes ?? null },
        severity: "fatal",
      }
    );
  }
  // The caller passes either capability identifiers (e.g. "gmail.read") OR raw
  // OAuth scope URLs. Both shapes are accepted so the manager's startOAuth API
  // surface stays uniform with other providers (which use raw scopes).
  const requested = new Set<GoogleCapability>();
  const identityScopes = new Set<string>(
    GOOGLE_IDENTITY_SCOPES.map((scope) => scope.toLowerCase())
  );
  for (const value of scopes) {
    if (isGoogleCapability(value)) {
      requested.add(value);
      continue;
    }
    const matched = matchCapabilityFromScope(value);
    if (matched) {
      requested.add(matched);
      continue;
    }
    if (identityScopes.has(value.trim().toLowerCase())) {
      continue;
    }
    throw new ElizaError(`Google OAuth capability or scope is not recognized: ${value}`, {
      code: "GOOGLE_OAUTH_SCOPE_UNRECOGNIZED",
      context: { scope: value },
      severity: "fatal",
    });
  }
  if (requested.size === 0) {
    throw new ElizaError(
      "Google OAuth requires at least one Gmail, Calendar, Drive, or Meet capability.",
      {
        code: "GOOGLE_OAUTH_CAPABILITY_REQUIRED",
        context: { scopes: [...scopes] },
        severity: "fatal",
      }
    );
  }
  return [...requested];
}

function normalizeGrantedCapabilities(scopes: readonly string[]): {
  capabilities: GoogleCapability[];
  ignoredScopes: string[];
} {
  const capabilities = new Set<GoogleCapability>();
  const grantedScopeSet = new Set<string>();
  const ignoredScopes: string[] = [];
  const identityScopes = new Set(GOOGLE_IDENTITY_SCOPES.map((scope) => scope.toLowerCase()));

  // error-policy:J3 Provider-returned scopes are untrusted external input. Keep
  // exact recognized capabilities, retain unknown scopes as metadata, and make
  // an empty connector grant an explicit failure instead of inventing access.
  for (const scope of scopes) {
    const normalized = scope.trim();
    if (!normalized) continue;
    if (isGoogleCapability(normalized)) {
      capabilities.add(normalized);
      continue;
    }
    const normalizedScope = normalized.toLowerCase();
    if (identityScopes.has(normalizedScope)) {
      continue;
    }
    if (matchCapabilityFromScope(normalized)) {
      grantedScopeSet.add(normalizedScope);
      continue;
    }
    ignoredScopes.push(normalized);
  }

  for (const capability of GOOGLE_CAPABILITIES) {
    if (capabilities.has(capability)) continue;
    const capabilityScopes = scopesForGoogleCapabilities([capability], {
      includeIdentityScopes: false,
    });
    if (capabilityScopes.every((scope) => grantedScopeSet.has(scope.toLowerCase()))) {
      capabilities.add(capability);
    }
  }

  return { capabilities: [...capabilities], ignoredScopes };
}

function matchCapabilityFromScope(scope: string): GoogleCapability | undefined {
  // Scope URL → capability ID mapping. Pulls from the canonical capability
  // metadata so additions to scopes.ts propagate automatically.
  const trimmed = scope.trim().toLowerCase();
  for (const capability of GOOGLE_CAPABILITIES) {
    const capabilityScopes = scopesForGoogleCapabilities([capability], {
      includeIdentityScopes: false,
    });
    if (capabilityScopes.some((value) => value.toLowerCase() === trimmed)) {
      return capability;
    }
  }
  return undefined;
}

function purposesForCapabilities(
  capabilities: readonly GoogleCapability[]
): ConnectorAccountPurpose[] {
  const groups = new Set<GoogleCapabilityGroup>();
  for (const capability of capabilities) {
    groups.add(capability.split(".")[0] as GoogleCapabilityGroup);
  }
  return [...groups].map((group) => GROUP_PURPOSE[group]);
}

function parseScopeString(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new ElizaError("Google token exchange returned an invalid scope field.", {
      code: "GOOGLE_OAUTH_SCOPE_PAYLOAD_INVALID",
      context: { valueType: typeof value },
      severity: "fatal",
    });
  }
  return value
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function requestedScopesFromMetadata(metadata: unknown): string[] {
  if (!isRecord(metadata) || metadata.requestedScopes === undefined) {
    throw new ElizaError(
      "Google OAuth callback is missing the scopes bound to the authorization request.",
      {
        code: "GOOGLE_OAUTH_REQUESTED_SCOPES_MISSING",
        severity: "fatal",
      }
    );
  }
  const scopes = metadata.requestedScopes;
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
    throw new ElizaError("Google OAuth callback contains invalid requested-scope metadata.", {
      code: "GOOGLE_OAUTH_REQUESTED_SCOPES_INVALID",
      context: {
        valueType: Array.isArray(scopes) ? "array-with-non-string" : typeof scopes,
      },
      severity: "fatal",
    });
  }
  return scopes;
}

function roleFromMetadata(metadata: unknown): ConnectorAccountRole {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  // Cloud OAuth writes `connectionRole` (uppercase canonical) and a legacy
  // lowercase `agentGoogleSide`. Local UI flows pass `role`/`accountRole`/
  // `requestedRole`. Accept all five shapes so the role survives whichever
  // path the OAuth start metadata came through.
  //
  // Precedence: most-explicit cloud field first, then the original local
  // fields in their original order (`role` first, `requestedRole` last so a
  // stale earlier-step value can't override a later correction), then the
  // legacy `agentGoogleSide` as the final fallback.
  const raw = nonEmptyString(
    record.connectionRole ??
      record.role ??
      record.accountRole ??
      record.requestedRole ??
      record.agentGoogleSide
  );
  if (!raw) {
    throw new ElizaError("Google connector account role is required.", {
      code: "GOOGLE_CONNECTOR_ROLE_REQUIRED",
      severity: "fatal",
    });
  }
  const normalized = raw.toUpperCase();
  if (normalized === "OWNER" || normalized === "AGENT" || normalized === "TEAM") {
    return normalized;
  }
  throw new ElizaError("Google connector account role is invalid.", {
    code: "GOOGLE_CONNECTOR_ROLE_INVALID",
    context: { role: raw },
    severity: "fatal",
  });
}

async function resolveOAuthRoleAtStart(
  request: ConnectorOAuthStartRequest,
  manager: ConnectorAccountManager
): Promise<ConnectorAccountRole> {
  const accountId = nonEmptyString(request.accountId);
  if (!accountId) {
    return roleFromMetadata(request.metadata);
  }
  const account = await manager.getAccount(GOOGLE_SERVICE_NAME, accountId);
  if (!account) {
    throw new ElizaError(
      "Google OAuth cannot reauthorize a connector account that no longer exists.",
      {
        code: "GOOGLE_OAUTH_REAUTH_ACCOUNT_NOT_FOUND",
        context: { accountId },
        severity: "fatal",
      }
    );
  }
  return roleFromMetadata({ role: account.role });
}

function parseIdTokenHeader(idToken: string): Record<string, unknown> {
  const segments = idToken.split(".");
  if (segments.length !== 3) {
    throw new ElizaError("Google ID token is malformed.", {
      code: "GOOGLE_OAUTH_ID_TOKEN_INVALID",
      severity: "fatal",
    });
  }
  try {
    const header: unknown = JSON.parse(
      Buffer.from(segments[0] ?? "", "base64url").toString("utf-8")
    );
    if (!isRecord(header)) {
      throw new Error("ID token header is not an object.");
    }
    return header;
  } catch (error) {
    // error-policy:J3 A malformed JWT header is untrusted provider input.
    throw new ElizaError("Google ID token header is invalid.", {
      code: "GOOGLE_OAUTH_ID_TOKEN_INVALID",
      cause: error,
      severity: "fatal",
    });
  }
}

export async function verifyGoogleIdTokenWithVerifier(
  args: {
    idToken: string;
    clientId: string;
    expectedNonce: string;
    nowMs?: number;
  },
  verifier: GoogleIdTokenVerifier = new OAuth2Client() as GoogleIdTokenVerifier
): Promise<GoogleIdentity> {
  const header = parseIdTokenHeader(args.idToken);
  if (header.alg !== "RS256" || !nonEmptyString(header.kid)) {
    throw new ElizaError("Google ID token uses an unsupported signing header.", {
      code: "GOOGLE_OAUTH_ID_TOKEN_INVALID",
      context: {
        algorithm: nonEmptyString(header.alg),
        hasKeyId: Boolean(nonEmptyString(header.kid)),
      },
      severity: "fatal",
    });
  }

  let payload: unknown;
  try {
    const ticket = await verifier.verifyIdToken({
      idToken: args.idToken,
      audience: args.clientId,
    });
    payload = ticket.getPayload();
  } catch (error) {
    // error-policy:J2 Preserve the signature/JWKS verifier as the typed cause.
    throw new ElizaError("Google ID token signature verification failed.", {
      code: "GOOGLE_OAUTH_ID_TOKEN_INVALID",
      cause: error,
      severity: "fatal",
    });
  }
  if (!isRecord(payload)) {
    throw new ElizaError("Google ID token payload is missing.", {
      code: "GOOGLE_OAUTH_ID_TOKEN_INVALID",
      severity: "fatal",
    });
  }

  const issuer = nonEmptyString(payload.iss);
  const audience = nonEmptyString(payload.aud);
  const expiration = typeof payload.exp === "number" ? payload.exp : Number.NaN;
  const issuedAt = typeof payload.iat === "number" ? payload.iat : Number.NaN;
  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000);
  if (
    (issuer !== "https://accounts.google.com" && issuer !== "accounts.google.com") ||
    audience !== args.clientId ||
    !Number.isSafeInteger(expiration) ||
    expiration <= nowSeconds ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt > nowSeconds + 300
  ) {
    throw new ElizaError("Google ID token claims are invalid.", {
      code: "GOOGLE_OAUTH_ID_TOKEN_INVALID",
      context: {
        issuer,
        audienceMatches: audience === args.clientId,
        hasValidExpiration: Number.isSafeInteger(expiration) && expiration > nowSeconds,
        hasValidIssuedAt: Number.isSafeInteger(issuedAt) && issuedAt <= nowSeconds + 300,
      },
      severity: "fatal",
    });
  }
  if (nonEmptyString(payload.nonce) !== args.expectedNonce) {
    throw new ElizaError("Google OAuth identity nonce did not match the authorization request.", {
      code: "GOOGLE_OAUTH_NONCE_MISMATCH",
      severity: "fatal",
    });
  }

  return {
    sub: nonEmptyString(payload.sub),
    nonce: nonEmptyString(payload.nonce),
    email: nonEmptyString(payload.email),
    email_verified:
      typeof payload.email_verified === "boolean" ? payload.email_verified : undefined,
    name: nonEmptyString(payload.name),
    given_name: nonEmptyString(payload.given_name),
    family_name: nonEmptyString(payload.family_name),
    picture: nonEmptyString(payload.picture),
    locale: nonEmptyString(payload.locale),
  };
}

export async function fetchGoogleUserInfoWithFetch(
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = GOOGLE_OAUTH_FETCH_TIMEOUT_MS,
  callerSignal?: AbortSignal
): Promise<GoogleIdentity> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline,
  });
  if (!response.ok) {
    throw new Error(`Google userinfo request failed with ${response.status}`);
  }
  const parsed = (await response.json()) as GoogleIdentity;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Google userinfo returned an invalid payload.");
  }
  return parsed;
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleIdentity> {
  return fetchGoogleUserInfoWithFetch(accessToken);
}

export async function exchangeAuthorizationCodeWithFetch(
  args: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier?: string;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = GOOGLE_OAUTH_FETCH_TIMEOUT_MS,
  callerSignal?: AbortSignal
): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: "authorization_code",
    code: args.code,
  });
  if (args.codeVerifier) {
    params.set("code_verifier", args.codeVerifier);
  }

  const deadline = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(GOOGLE_OAUTH_PROVIDER_METADATA.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google token exchange failed with ${response.status}: ${body}`);
  }
  const parsed = (await response.json()) as GoogleTokenResponse;
  if (!parsed.access_token || !Number.isFinite(parsed.expires_in)) {
    throw new Error("Google token exchange returned an invalid payload.");
  }
  return parsed;
}

async function exchangeAuthorizationCode(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier?: string;
}): Promise<GoogleTokenResponse> {
  return exchangeAuthorizationCodeWithFetch(args);
}

/**
 * Build the Google ConnectorAccountManager provider. Exposes listAccounts (from
 * manager-owned storage), CRUD adapters, and a single consolidated PKCE OAuth
 * flow that returns a Google account hydrated with the granted capabilities,
 * scopes, and userinfo identity.
 */
export function createGoogleConnectorAccountProvider(
  runtime: IAgentRuntime
): ConnectorAccountProvider {
  return {
    provider: GOOGLE_SERVICE_NAME,
    label: GOOGLE_OAUTH_PROVIDER_METADATA.label,

    // Registering the provider also registers Gmail as a MESSAGE send
    // connector, so `op=send source=gmail` (aliases "email"/"mail") routes to
    // Gmail compose+send instead of SOURCE_CONNECTOR_NOT_FOUND.
    messageConnector: createGmailMessageConnector(runtime),

    listAccounts: async (manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      return manager.getStorage().listAccounts(GOOGLE_SERVICE_NAME);
    },

    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      // Persistence is owned by the manager; this adapter just normalizes the
      // patch into a Google-shaped account so role/purpose/status defaults are
      // sensible when an upstream caller creates the row before OAuth runs.
      return {
        ...input,
        provider: GOOGLE_SERVICE_NAME,
        role: roleFromMetadata({ role: input.role }),
        purpose: input.purpose ?? ["messaging", "calendar", "drive", "meet"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },

    patchAccount: async (
      accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager
    ) => {
      if (patch.status === "revoked" || patch.status === "disabled") {
        const calendarService = runtime.getService("calendar");
        if (isGoogleCalendarWatchRevocationService(calendarService)) {
          await calendarService.revokeGoogleCalendarWatchesByAccount(accountId);
        }
      }
      return { ...patch, provider: GOOGLE_SERVICE_NAME };
    },

    deleteAccount: async (accountId: string, manager: ConnectorAccountManager): Promise<void> => {
      const account = await manager.getAccount(GOOGLE_SERVICE_NAME, accountId);
      if (!account) {
        return;
      }
      const calendarService = runtime.getService("calendar");
      if (isGoogleCalendarWatchRevocationService(calendarService)) {
        await calendarService.revokeGoogleCalendarWatchesByAccount(accountId);
      }
      const metadata = isRecord(account.metadata) ? account.metadata : {};
      const alreadyRevoked = Boolean(
        nonEmptyString(metadata[GOOGLE_OAUTH_REVOKED_AT_METADATA_KEY])
      );
      const refs = await runtime.adapter.listConnectorAccountCredentialRefs({
        accountId: account.id as UUID,
      });
      const hasOAuthTokenRef = refs.some((ref) => ref.credentialType === "oauth.tokens");
      if (!alreadyRevoked && hasOAuthTokenRef) {
        const resolved = await Promise.all(
          refs.map(async (ref) => ({
            ref,
            stored: await resolveCredentialSecret(runtime, ref.vaultRef),
          }))
        );
        const oauth = resolved.find(({ ref }) => ref.credentialType === "oauth.tokens");
        if (!oauth) {
          throw new ElizaError("Connected Google account has no persisted OAuth token set.", {
            code: "GOOGLE_OAUTH_CREDENTIAL_REF_MISSING",
            context: { accountId },
            severity: "fatal",
          });
        }
        await revokeGoogleOAuthGrantWithFetch(revocationTokenFromSecret(oauth.stored.secret));
        await manager.getStorage().upsertAccount({
          ...account,
          status: "error",
          metadata: {
            ...metadata,
            [GOOGLE_OAUTH_REVOKED_AT_METADATA_KEY]: new Date().toISOString(),
          },
          updatedAt: Date.now(),
        });
        for (const { stored } of resolved) {
          await stored.remove();
        }
      } else if (account.status === "connected" && !alreadyRevoked) {
        throw new ElizaError("Connected Google account has no persisted OAuth token set.", {
          code: "GOOGLE_OAUTH_CREDENTIAL_REF_MISSING",
          context: { accountId },
          severity: "fatal",
        });
      } else if (refs.length > 0) {
        for (const ref of refs) {
          let stored: ResolvedCredentialSecret;
          try {
            stored = await resolveCredentialSecret(runtime, ref.vaultRef);
          } catch (error) {
            // error-policy:J4 An already-revoked retry may encounter a secret
            // removed by its prior attempt; the durable ref deletion below is
            // the authoritative local cleanup and remains mandatory.
            if (
              !alreadyRevoked ||
              !(error instanceof ElizaError) ||
              error.code !== "GOOGLE_OAUTH_CREDENTIAL_NOT_FOUND"
            ) {
              throw error;
            }
            continue;
          }
          await stored.remove();
        }
      }
      const deletedRefs = await credentialAdapter(runtime).deleteConnectorAccountCredentialRefs({
        accountId: account.id as UUID,
      });
      if (deletedRefs !== refs.length) {
        throw new ElizaError("Google connector credential refs were not deleted completely.", {
          code: "GOOGLE_OAUTH_CREDENTIAL_REF_CLEANUP_INCOMPLETE",
          context: { accountId, expected: refs.length, deleted: deletedRefs },
          severity: "fatal",
        });
      }
      // The manager removes the now-revoked account row only after this
      // provider callback confirms remote and local credential cleanup.
    },

    startOAuth: async (
      request: ConnectorOAuthStartRequest,
      manager: ConnectorAccountManager
    ): Promise<ConnectorOAuthStartResult> => {
      // The manager forwards the served origin captured at the HTTP boundary
      // (Settings route) or by LifeOps; callback validation runs against it so
      // an unreachable callback fails here instead of stranding the grant.
      const config = readClientConfig(runtime, request.servedOrigin);
      const redirectUri = config.redirectUri;
      // Validate authorization before issuing a consent URL. A new grant must
      // carry an explicit role; reauthorization retains only the stored role.
      const requestedRole = await resolveOAuthRoleAtStart(request, manager);
      const capabilities = normalizeRequestedCapabilities(
        await resolveRequestedScopes(request, manager)
      );
      const oauthScopes = scopesForGoogleCapabilities(capabilities);
      const codeVerifier = createCodeVerifier();
      const codeChallenge = createCodeChallenge(codeVerifier);
      const oidcNonce = createOidcNonce();

      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: oauthScopes.join(" "),
        state: request.flow.state,
        nonce: oidcNonce,
        access_type: "offline",
        prompt: "consent",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        include_granted_scopes: "false",
      });

      return {
        authUrl: `${GOOGLE_OAUTH_PROVIDER_METADATA.authorizationEndpoint}?${params.toString()}`,
        // Provider-owned canonical callback: the manager persists
        // result.redirectUri ?? flow.redirectUri, so returning it keeps the
        // stored flow callback populated when the caller supplies none.
        redirectUri,
        codeVerifier,
        metadata: {
          ...request.metadata,
          requestedRole,
          requestedCapabilities: capabilities,
          requestedScopes: oauthScopes,
          redirectUri,
          oidcNonce,
        },
      };
    },

    completeOAuth: async (
      request: ConnectorOAuthCallbackRequest,
      manager: ConnectorAccountManager
    ): Promise<ConnectorOAuthCallbackResult> => {
      const code = nonEmptyString(request.code);
      if (!code) {
        throw new Error("Google OAuth callback is missing an authorization code.");
      }

      const config = readClientConfig(runtime);
      const redirectUri =
        nonEmptyString(request.flow.redirectUri) ??
        nonEmptyString(
          (request.flow.metadata as Record<string, unknown> | undefined)?.redirectUri
        ) ??
        config.redirectUri;

      const requestedAccountId = nonEmptyString(request.flow.accountId);
      const existingAccount = requestedAccountId
        ? await manager.getAccount(GOOGLE_SERVICE_NAME, requestedAccountId)
        : null;
      if (requestedAccountId && !existingAccount) {
        throw new ElizaError(
          "Google OAuth cannot reauthorize a connector account that no longer exists.",
          {
            code: "GOOGLE_OAUTH_REAUTH_ACCOUNT_NOT_FOUND",
            context: { accountId: requestedAccountId },
            severity: "fatal",
          }
        );
      }
      const priorCredentialRefs: OAuthCredentialRefSnapshot[] = requestedAccountId
        ? await runtime.adapter.listConnectorAccountCredentialRefs({
            accountId: requestedAccountId as UUID,
          })
        : [];

      const tokens = await exchangeAuthorizationCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri,
        code,
        codeVerifier: request.flow.codeVerifier,
      });

      let pendingAccountId: string | undefined;
      let attemptedVaultRef: string | undefined;
      try {
        const grantedScopes = parseScopeString(tokens.scope);
        const normalizedGrant =
          grantedScopes.length > 0
            ? normalizeGrantedCapabilities(grantedScopes)
            : {
                capabilities: normalizeRequestedCapabilities(
                  requestedScopesFromMetadata(request.flow.metadata)
                ),
                ignoredScopes: [],
              };
        const grantedCapabilities = normalizedGrant.capabilities;
        if (normalizedGrant.ignoredScopes.length > 0) {
          logger.warn(
            {
              src: "plugin:google:oauth",
              ignoredScopes: normalizedGrant.ignoredScopes,
            },
            "[GoogleConnectorAccountProvider] Ignoring unmapped scopes returned by Google"
          );
        }
        if (grantedCapabilities.length === 0) {
          throw new ElizaError(
            "Google OAuth completed without a usable Gmail, Calendar, Drive, or Meet capability.",
            {
              code: "GOOGLE_OAUTH_CAPABILITY_NOT_GRANTED",
              context: {
                grantedScopes,
                ignoredScopes: normalizedGrant.ignoredScopes,
              },
              severity: "fatal",
            }
          );
        }
        const purposes = purposesForCapabilities(grantedCapabilities);

        const expectedOidcNonce = nonEmptyString(
          (request.flow.metadata as Record<string, unknown> | undefined)?.oidcNonce
        );
        if (!expectedOidcNonce) {
          throw new ElizaError("Google OAuth callback is missing its OpenID Connect nonce.", {
            code: "GOOGLE_OAUTH_NONCE_MISSING",
            severity: "fatal",
          });
        }
        const idToken = nonEmptyString(tokens.id_token);
        if (!idToken) {
          throw new ElizaError("Google OAuth token response is missing its ID token.", {
            code: "GOOGLE_OAUTH_ID_TOKEN_MISSING",
            severity: "fatal",
          });
        }
        const verifiedIdentity = await verifyGoogleIdTokenWithVerifier({
          idToken,
          clientId: config.clientId,
          expectedNonce: expectedOidcNonce,
        });
        let identity = verifiedIdentity;
        if (!nonEmptyString(identity.sub) || !nonEmptyString(identity.email)) {
          const userInfo = await fetchGoogleUserInfo(tokens.access_token);
          const verifiedSubject = nonEmptyString(identity.sub);
          const userInfoSubject = nonEmptyString(userInfo.sub);
          if (verifiedSubject && userInfoSubject && verifiedSubject !== userInfoSubject) {
            throw new ElizaError(
              "Google ID token and authenticated userinfo identify different accounts.",
              {
                code: "GOOGLE_OAUTH_IDENTITY_MISMATCH",
                severity: "fatal",
              }
            );
          }
          identity = {
            ...identity,
            ...userInfo,
            sub: verifiedSubject ?? userInfoSubject,
            nonce: verifiedIdentity.nonce,
          };
        }

        const externalId = nonEmptyString(identity.sub);
        if (!externalId) {
          throw new ElizaError("Google identity payload did not include a stable subject.", {
            code: "GOOGLE_OAUTH_IDENTITY_SUBJECT_MISSING",
            severity: "fatal",
          });
        }
        const requestedRole = existingAccount
          ? roleFromMetadata({ role: existingAccount.role })
          : roleFromMetadata(request.flow.metadata);
        const existingExternalId = nonEmptyString(existingAccount?.externalId);
        if (existingExternalId && existingExternalId !== externalId) {
          throw new ElizaError(
            "Google OAuth returned a different account than the connector being reauthorized.",
            {
              code: "GOOGLE_OAUTH_ACCOUNT_IDENTITY_MISMATCH",
              context: { accountId: requestedAccountId },
              severity: "fatal",
            }
          );
        }
        const accountId =
          requestedAccountId ?? stableGoogleConnectorAccountId(externalId, requestedRole);
        const expiresAt = Date.now() + tokens.expires_in * 1000;
        const oauthCredentialVersion = String(Date.now());
        const accountMetadata = {
          email: identity.email ?? null,
          emailVerified: identity.email_verified ?? null,
          name: identity.name ?? null,
          picture: identity.picture ?? null,
          locale: identity.locale ?? null,
          grantedCapabilities,
          grantedScopes:
            grantedScopes.length > 0
              ? grantedScopes
              : scopesForGoogleCapabilities(grantedCapabilities),
          identityScopes: [...GOOGLE_IDENTITY_SCOPES],
          tokenType: tokens.token_type ?? "Bearer",
          hasRefreshToken: Boolean(tokens.refresh_token),
          expiresAt,
          oauthCredentialVersion,
        };
        // Set the rollback target before the storage call: an adapter may commit
        // the pending row and then throw, and compensation must still restore or
        // remove that partially committed account.
        pendingAccountId = accountId;
        const pendingAccount = await manager.upsertAccount(
          GOOGLE_SERVICE_NAME,
          {
            ...(existingAccount ?? {}),
            provider: GOOGLE_SERVICE_NAME,
            role: existingAccount?.role ?? requestedRole,
            purpose: purposes,
            accessGate: "open",
            status: "pending",
            externalId,
            displayHandle: nonEmptyString(identity.email) ?? nonEmptyString(identity.name),
            label:
              nonEmptyString(identity.name) ??
              nonEmptyString(identity.email) ??
              GOOGLE_OAUTH_PROVIDER_METADATA.label,
            metadata: accountMetadata,
          },
          accountId
        );
        pendingAccountId = pendingAccount.id;
        const credentialRefAccountSegment = `${pendingAccount.id}-${randomBytes(12).toString("hex")}`;
        attemptedVaultRef = buildConnectorCredentialVaultRef({
          agentId: nonEmptyString(runtime.agentId) ?? "agent",
          provider: GOOGLE_SERVICE_NAME,
          accountId: credentialRefAccountSegment,
          credentialType: "oauth.tokens",
        });
        const credentialPersist = await persistConnectorCredentialRefs({
          runtime,
          manager,
          provider: GOOGLE_SERVICE_NAME,
          // A unique attempt ref preserves the prior reauthorization credential
          // until both the new secret and its durable ref commit successfully.
          accountIdForRef: credentialRefAccountSegment,
          storageAccountId: pendingAccount.id,
          caller: "plugin-google-workspace",
          credentials: [
            {
              credentialType: "oauth.tokens",
              value: JSON.stringify({
                access_token: tokens.access_token,
                ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
                ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
                token_type: tokens.token_type ?? "Bearer",
                scope:
                  grantedScopes.length > 0
                    ? grantedScopes.join(" ")
                    : scopesForGoogleCapabilities(grantedCapabilities).join(" "),
                expiry_date: expiresAt,
              }),
              expiresAt,
              metadata: {
                provider: GOOGLE_SERVICE_NAME,
                hasRefreshToken: Boolean(tokens.refresh_token),
              },
            },
          ],
        });

        const accountPatch: ConnectorAccountPatch & {
          provider: string;
          id: string;
        } = {
          ...pendingAccount,
          id: pendingAccount.id,
          provider: GOOGLE_SERVICE_NAME,
          status: "connected",
          metadata: {
            ...accountMetadata,
            credentialRefs: credentialPersist.refs,
            credentialRefStorage: {
              vaultAvailable: credentialPersist.vaultAvailable,
              storageAvailable: credentialPersist.storageAvailable,
            },
          },
        };

        for (const priorRef of priorCredentialRefs) {
          if (!credentialPersist.refs.some((ref) => ref.vaultRef === priorRef.vaultRef)) {
            await removeCredentialIfPresent(runtime, priorRef.vaultRef);
          }
        }

        logger.info(
          {
            src: "plugin:google:connector",
            externalId,
            capabilities: grantedCapabilities,
          },
          "Google OAuth completed"
        );

        return {
          account: accountPatch,
          flow: { status: "completed" },
        };
      } catch (error) {
        // error-policy:J2 Every failure after token exchange runs the same
        // remote/local compensation path and retains the original cause.
        return compensateOAuthCompletion({
          runtime,
          manager,
          tokens,
          originalError: error,
          existingAccount,
          priorCredentialRefs,
          pendingAccountId,
          attemptedVaultRef,
        });
      }
    },
  };
}
