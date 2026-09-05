/**
 * First-party mobile Authorization Code + PKCE lifecycle for Eliza Cloud.
 *
 * The browser consent boundary issues a short-lived hash-stored code. Exchange
 * creates an inactive, encrypted API credential; repeated exchanges reveal
 * that same credential until the native app acknowledges durable persistence,
 * at which point one transaction activates it. Mobile secrets are always
 * validated against primary storage and never enter an auth cache. The fixed `cloud:user` scope
 * describes the existing user/organization API capability and is not a claim
 * of finer route-level permission enforcement.
 */
import crypto from "node:crypto";
import { ElizaError } from "@elizaos/core/edge";
import { decryptApiKey, encryptApiKey } from "../../db/crypto/api-keys";
import { buildMobileAppAuthCredentialProvenance } from "../../db/mobile-app-auth-credential-policy";
import {
  type MobileAppAuthCleanupCursor,
  type MobileAppAuthGrantBinding,
  type MobileAppAuthGrantState,
  mobileAppAuthGrantsRepository,
} from "../../db/repositories/mobile-app-auth-grants";
import type { ApiKey, NewApiKey } from "../../db/schemas/api-keys";
import type { MobileAppAuthEnvironment } from "../../db/schemas/mobile-app-auth-grants";
import { apiKeysService, isMobileApiKeySecret } from "./api-keys";

export const MOBILE_APP_AUTH_CLIENT_ID = "ai.elizaos.app";
export const MOBILE_APP_AUTH_REDIRECT_URI = "https://eliza.app/auth/callback";
export const MOBILE_APP_AUTH_CODE_CHALLENGE_METHOD = "S256";
export const MOBILE_APP_AUTH_SCOPES = ["cloud:user"] as const;
export const MOBILE_APP_AUTH_CODE_TTL_SECONDS = 5 * 60;
export const MOBILE_APP_AUTH_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MOBILE_APP_AUTH_APP_ID_ENV = "ELIZA_MOBILE_APP_AUTH_APP_ID";
export const MOBILE_APP_AUTH_ENABLED_ENV = "ELIZA_MOBILE_APP_AUTH_ENABLED";
export const MOBILE_APP_AUTH_CLEANUP_BATCH_SIZE = 250;
export const MOBILE_APP_AUTH_CLEANUP_MAX_BATCHES = 8;
export const MOBILE_APP_AUTH_CLEANUP_SCAN_CAPACITY =
  MOBILE_APP_AUTH_CLEANUP_BATCH_SIZE * MOBILE_APP_AUTH_CLEANUP_MAX_BATCHES;
export const MOBILE_APP_AUTH_CLEANUP_DRAIN_CAPACITY = MOBILE_APP_AUTH_CLEANUP_SCAN_CAPACITY;

const CODE_PREFIX = "emac_";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_RE = /^emac_[0-9a-f]{64}$/;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const DEVICE_NAME_RE = /^[^\p{Cc}\p{Cf}]+$/u;
export const MOBILE_APP_AUTH_DEVICE_NAME_MAX_LENGTH = 80;

export type MobileAppAuthProtocolErrorCode =
  | "authorization_code_expired"
  | "authorization_complete"
  | "binding_mismatch"
  | "credential_proof_invalid"
  | "invalid_authorization_code"
  | "invalid_client"
  | "invalid_code_verifier"
  | "invalid_request"
  | "server_configuration_error";

export class MobileAppAuthProtocolError extends ElizaError {
  override readonly name = "MobileAppAuthProtocolError";

  constructor(
    readonly protocolCode: MobileAppAuthProtocolErrorCode,
    message: string,
  ) {
    super(message, {
      code: `MOBILE_APP_AUTH_${protocolCode.toUpperCase()}`,
      context: { protocolCode },
      severity: "ephemeral",
    });
  }
}

export interface MobileAppAuthRegistration {
  appId: string;
  clientId: typeof MOBILE_APP_AUTH_CLIENT_ID;
  environment: MobileAppAuthEnvironment;
  redirectUri: typeof MOBILE_APP_AUTH_REDIRECT_URI;
  scopes: typeof MOBILE_APP_AUTH_SCOPES;
}

export interface MobileAppAuthRuntimeEnv {
  ENVIRONMENT?: unknown;
  ELIZA_MOBILE_APP_AUTH_APP_ID?: unknown;
  ELIZA_MOBILE_APP_AUTH_ENABLED?: unknown;
}

export interface MobileAppAuthClientBinding {
  clientId: string;
  environment: string;
  redirectUri: string;
}

export interface MobileAppAuthGrantRequestBinding extends MobileAppAuthClientBinding {
  state: string;
}

export interface MobileAppAuthPkceBinding extends MobileAppAuthClientBinding {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  deviceName?: string;
}

export interface MobileAppAuthCredentialResponse {
  credentialId: string;
  secret: string;
  tokenType: "Bearer";
  expiresAt: string;
  expiresIn: number;
  scopes: string[];
  acknowledgementRequired: true;
  acknowledgeBy: string;
}

function invalid(code: MobileAppAuthProtocolErrorCode, message: string): never {
  throw new MobileAppAuthProtocolError(code, message);
}

function credentialIntegrityError(message: string): ElizaError {
  return new ElizaError(message, {
    code: "MOBILE_APP_AUTH_CREDENTIAL_INTEGRITY",
    severity: "fatal",
  });
}

function requireEnvironment(value: unknown): MobileAppAuthEnvironment {
  if (value !== "staging" && value !== "production") {
    return invalid(
      "server_configuration_error",
      "Mobile App Auth requires an exact staging or production environment",
    );
  }
  return value;
}

export function resolveMobileAppAuthRegistration(
  env: MobileAppAuthRuntimeEnv,
): MobileAppAuthRegistration {
  const environment = requireEnvironment(env.ENVIRONMENT);
  if (env.ELIZA_MOBILE_APP_AUTH_ENABLED === "false") {
    return invalid(
      "server_configuration_error",
      "Mobile App Auth is disabled for this environment",
    );
  }
  if (env.ELIZA_MOBILE_APP_AUTH_ENABLED !== "true") {
    return invalid(
      "server_configuration_error",
      `${MOBILE_APP_AUTH_ENABLED_ENV} must be exactly true or false`,
    );
  }
  if (
    typeof env.ELIZA_MOBILE_APP_AUTH_APP_ID !== "string" ||
    !UUID_RE.test(env.ELIZA_MOBILE_APP_AUTH_APP_ID)
  ) {
    return invalid(
      "server_configuration_error",
      `${MOBILE_APP_AUTH_APP_ID_ENV} must be a registered app UUID`,
    );
  }
  return {
    appId: env.ELIZA_MOBILE_APP_AUTH_APP_ID,
    clientId: MOBILE_APP_AUTH_CLIENT_ID,
    environment,
    redirectUri: MOBILE_APP_AUTH_REDIRECT_URI,
    scopes: MOBILE_APP_AUTH_SCOPES,
  };
}

export function validateMobileAppAuthClientBinding(
  registration: MobileAppAuthRegistration,
  input: MobileAppAuthClientBinding,
): void {
  if (input.clientId !== registration.clientId) {
    invalid("invalid_client", "Unknown mobile App Auth client");
  }
  if (input.environment !== registration.environment) {
    invalid("binding_mismatch", "Mobile App Auth environment does not match this server");
  }
  if (input.redirectUri !== registration.redirectUri) {
    invalid("binding_mismatch", "Mobile App Auth redirect URI is not registered");
  }
}

export function validateMobileAppAuthPkceBinding(
  registration: MobileAppAuthRegistration,
  input: MobileAppAuthPkceBinding,
): void {
  validateMobileAppAuthClientBinding(registration, input);
  if (input.codeChallengeMethod !== MOBILE_APP_AUTH_CODE_CHALLENGE_METHOD) {
    invalid("invalid_request", "Only S256 PKCE is supported");
  }
  if (!PKCE_CHALLENGE_RE.test(input.codeChallenge)) {
    invalid("invalid_request", "Invalid S256 PKCE challenge");
  }
  if (!PKCE_VERIFIER_RE.test(input.state)) {
    invalid("invalid_request", "Invalid mobile App Auth state");
  }
  normalizeMobileDeviceName(input.deviceName);
}

function normalizeMobileDeviceName(value: string | undefined): string | null {
  if (value === undefined) return null;
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > MOBILE_APP_AUTH_DEVICE_NAME_MAX_LENGTH ||
    !DEVICE_NAME_RE.test(name)
  ) {
    return invalid("invalid_request", "Invalid mobile device name");
  }
  return name;
}

export function isValidMobileAppAuthCodeVerifier(value: string): boolean {
  return PKCE_VERIFIER_RE.test(value);
}

function createOpaqueCode(): string {
  return `${CODE_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function deriveMobileAppAuthS256Challenge(verifier: string): string {
  if (!isValidMobileAppAuthCodeVerifier(verifier)) {
    return invalid("invalid_code_verifier", "Invalid PKCE code verifier");
  }
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function requireCode(value: string): string {
  if (!CODE_RE.test(value)) {
    return invalid("invalid_authorization_code", "Invalid authorization code");
  }
  return value;
}

export async function issueMobileAppAuthCode(input: {
  registration: MobileAppAuthRegistration;
  userId: string;
  organizationId: string;
  binding: MobileAppAuthPkceBinding;
  now?: Date;
}): Promise<{ code: string; expiresAt: string; expiresIn: number }> {
  validateMobileAppAuthPkceBinding(input.registration, input.binding);
  if (!UUID_RE.test(input.userId) || !UUID_RE.test(input.organizationId)) {
    return invalid("invalid_request", "Mobile App Auth requires a full user organization");
  }
  const code = createOpaqueCode();
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + MOBILE_APP_AUTH_CODE_TTL_SECONDS * 1000);
  const created = await mobileAppAuthGrantsRepository.create({
    code_hash: sha256Hex(code),
    app_id: input.registration.appId,
    client_id: input.registration.clientId,
    user_id: input.userId,
    organization_id: input.organizationId,
    environment: input.registration.environment,
    device_name: normalizeMobileDeviceName(input.binding.deviceName),
    redirect_uri: input.registration.redirectUri,
    state_hash: sha256Hex(input.binding.state),
    code_challenge: input.binding.codeChallenge,
    code_challenge_method: MOBILE_APP_AUTH_CODE_CHALLENGE_METHOD,
    scopes: [...input.registration.scopes],
    status: "pending",
    expires_at: expiresAt,
  });
  if (!created) {
    return invalid("invalid_client", "Configured mobile App Auth app is no longer active");
  }
  return {
    code,
    expiresAt: expiresAt.toISOString(),
    expiresIn: MOBILE_APP_AUTH_CODE_TTL_SECONDS,
  };
}

async function prepareInactiveCredential(input: {
  state: MobileAppAuthGrantState;
  now: Date;
}): Promise<{ insert: NewApiKey; secret: string }> {
  const { key, hash, prefix } = apiKeysService.generateMobileApiKey();
  const id = crypto.randomUUID();
  const encrypted = await encryptApiKey(input.state.grant.organization_id, id, key);
  const expiresAt = new Date(input.now.getTime() + MOBILE_APP_AUTH_CREDENTIAL_TTL_SECONDS * 1000);
  const provenance = buildMobileAppAuthCredentialProvenance({
    grantId: input.state.grant.id,
    environment: input.state.grant.environment,
    deviceName: input.state.grant.device_name,
    clientId: input.state.grant.client_id,
    scopes: input.state.grant.scopes,
  });
  return {
    insert: {
      id,
      name: provenance.name,
      description: provenance.description,
      organization_id: input.state.grant.organization_id,
      user_id: input.state.grant.user_id,
      source_app_id: input.state.grant.app_id,
      rate_limit: 1000,
      is_active: false,
      expires_at: expiresAt,
      key_hash: hash,
      key_prefix: prefix,
      key_ciphertext: encrypted.ciphertext,
      key_nonce: encrypted.nonce,
      key_auth_tag: encrypted.auth_tag,
      key_kms_key_id: encrypted.kms_key_id,
      key_kms_key_version: encrypted.kms_key_version,
    },
    secret: key,
  };
}

type RevealableMobileCredential = ApiKey & {
  expires_at: Date;
  key_auth_tag: string;
  key_ciphertext: string;
  key_kms_key_id: string;
  key_kms_key_version: number;
  key_nonce: string;
};

function isRevealableMobileCredential(
  credential: ApiKey,
  now: Date,
): credential is RevealableMobileCredential {
  return Boolean(
    !credential.is_active &&
      !credential.deleted_at &&
      credential.expires_at &&
      credential.expires_at > now &&
      credential.key_ciphertext &&
      credential.key_nonce &&
      credential.key_auth_tag &&
      credential.key_kms_key_id &&
      credential.key_kms_key_version != null,
  );
}

function requireRevealableState(
  state: MobileAppAuthGrantState,
  now: Date,
): RevealableMobileCredential {
  const credential = state.credential;
  if (state.grant.status === "acknowledged") {
    return invalid("authorization_complete", "Authorization code has already been acknowledged");
  }
  if (state.grant.status !== "exchanged" || !credential) {
    return invalid("invalid_authorization_code", "Invalid authorization grant state");
  }
  if (!isRevealableMobileCredential(credential, now)) {
    throw credentialIntegrityError("Mobile App Auth credential integrity check failed");
  }
  return credential;
}

async function confirmCredentialDelivery(input: {
  binding: MobileAppAuthGrantBinding;
  state: MobileAppAuthGrantState;
  secret: string;
  now: Date;
}): Promise<MobileAppAuthCredentialResponse> {
  const credential = requireRevealableState(input.state, input.now);
  if (sha256Hex(input.secret) !== credential.key_hash) {
    throw credentialIntegrityError("Mobile App Auth credential ciphertext/hash mismatch");
  }

  // KMS work may cross the authorization deadline. Re-check the primary with
  // a fresh wall clock immediately before plaintext crosses the HTTP boundary.
  const confirmationNow = new Date(Math.max(input.now.getTime(), Date.now()));
  const confirmation = await mobileAppAuthGrantsRepository.confirmRevealable({
    binding: input.binding,
    credentialId: credential.id,
    credentialHash: credential.key_hash,
    now: confirmationNow,
  });
  if (confirmation.kind === "invalid") {
    if (confirmation.reason === "client_inactive") {
      return invalid("invalid_client", "Configured mobile App Auth app is no longer active");
    }
    const latest = await mobileAppAuthGrantsRepository.findStateByCodeHash(input.binding.codeHash);
    if (latest?.grant.status === "acknowledged") {
      return invalid("authorization_complete", "Authorization code has already been acknowledged");
    }
    if (!latest || latest.grant.expires_at <= confirmationNow) {
      return invalid("authorization_code_expired", "Authorization code expired during exchange");
    }
    throw credentialIntegrityError("Mobile App Auth credential changed during delivery");
  }
  const confirmedCredential = requireRevealableState(confirmation.state, confirmationNow);
  return {
    credentialId: confirmedCredential.id,
    secret: input.secret,
    tokenType: "Bearer",
    expiresAt: confirmedCredential.expires_at.toISOString(),
    expiresIn: Math.max(
      0,
      Math.floor((confirmedCredential.expires_at.getTime() - confirmationNow.getTime()) / 1000),
    ),
    scopes: [...confirmation.state.grant.scopes],
    acknowledgementRequired: true,
    acknowledgeBy: confirmation.state.grant.expires_at.toISOString(),
  };
}

async function revealCredential(
  binding: MobileAppAuthGrantBinding,
  state: MobileAppAuthGrantState,
  now: Date,
): Promise<MobileAppAuthCredentialResponse> {
  const credential = requireRevealableState(state, now);
  const secret = await decryptApiKey(credential.id, {
    ciphertext: credential.key_ciphertext,
    nonce: credential.key_nonce,
    auth_tag: credential.key_auth_tag,
    kms_key_id: credential.key_kms_key_id,
    kms_key_version: credential.key_kms_key_version,
  });
  return await confirmCredentialDelivery({
    binding,
    state,
    secret,
    now,
  });
}

function rejectInvalidExchangeClaim(reason: "client_inactive" | "grant_invalid"): never {
  if (reason === "client_inactive") {
    return invalid("invalid_client", "Configured mobile App Auth app is no longer active");
  }
  return invalid("authorization_code_expired", "Authorization code expired during exchange");
}

export async function exchangeMobileAppAuthCode(input: {
  registration: MobileAppAuthRegistration;
  binding: MobileAppAuthGrantRequestBinding;
  code: string;
  codeVerifier: string;
  now?: Date;
}): Promise<MobileAppAuthCredentialResponse> {
  validateMobileAppAuthClientBinding(input.registration, input.binding);
  const now = input.now ?? new Date();
  const codeChallenge = deriveMobileAppAuthS256Challenge(input.codeVerifier);
  const { binding, state: existing } = await requireBoundGrantState({
    code: input.code,
    codeChallenge,
    input: input.binding,
    now,
    registration: input.registration,
  });
  if (existing?.grant.status === "exchanged") {
    return await revealCredential(binding, existing, now);
  }
  if (existing?.grant.status === "acknowledged") {
    return invalid("authorization_complete", "Authorization code has already been acknowledged");
  }

  const candidate = await prepareInactiveCredential({ state: existing, now });
  const claim = await mobileAppAuthGrantsRepository.exchange(binding, candidate.insert, now);
  if (claim.kind === "invalid") {
    return rejectInvalidExchangeClaim(claim.reason);
  }
  if (claim.kind === "created") {
    return await confirmCredentialDelivery({
      binding,
      state: claim.state,
      secret: candidate.secret,
      now,
    });
  }
  return await revealCredential(binding, claim.state, now);
}

export async function acknowledgeMobileAppAuthCredential(input: {
  registration: MobileAppAuthRegistration;
  binding: MobileAppAuthGrantRequestBinding;
  code: string;
  codeVerifier: string;
  credentialId: string;
  secret: string;
  now?: Date;
}): Promise<{
  status: "acknowledged";
  credentialId: string;
  expiresAt: string;
  scopes: string[];
}> {
  validateMobileAppAuthClientBinding(input.registration, input.binding);
  if (!UUID_RE.test(input.credentialId) || !isMobileApiKeySecret(input.secret)) {
    return invalid("credential_proof_invalid", "Invalid mobile credential proof");
  }
  const now = input.now ?? new Date();
  const { binding, state: existing } = await requireBoundGrantState({
    code: input.code,
    codeChallenge: deriveMobileAppAuthS256Challenge(input.codeVerifier),
    input: input.binding,
    now,
    registration: input.registration,
  });
  const credentialHash = sha256Hex(input.secret);
  if (
    existing.credential?.id !== input.credentialId ||
    !equalFixedLength(existing.credential.key_hash, credentialHash)
  ) {
    return invalid(
      "credential_proof_invalid",
      "Mobile credential proof does not match the authorization grant",
    );
  }
  const state = await mobileAppAuthGrantsRepository.acknowledge({
    binding,
    credentialId: input.credentialId,
    credentialHash,
    now,
  });
  if (!state?.credential?.expires_at) {
    return invalid(
      "credential_proof_invalid",
      "Mobile credential proof does not match the authorization grant",
    );
  }
  return {
    status: "acknowledged",
    credentialId: state.credential.id,
    expiresAt: state.credential.expires_at.toISOString(),
    scopes: [...state.grant.scopes],
  };
}

function equalFixedLength(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

async function requireBoundGrantState(input: {
  code: string;
  codeChallenge: string;
  input: MobileAppAuthGrantRequestBinding;
  now: Date;
  registration: MobileAppAuthRegistration;
}): Promise<{
  binding: MobileAppAuthGrantBinding;
  state: MobileAppAuthGrantState;
}> {
  validateMobileAppAuthClientBinding(input.registration, input.input);
  if (!PKCE_VERIFIER_RE.test(input.input.state)) {
    return invalid("binding_mismatch", "Mobile App Auth state is invalid");
  }
  const codeHash = sha256Hex(requireCode(input.code));
  const state = await mobileAppAuthGrantsRepository.findStateByCodeHash(codeHash);
  if (!state) {
    return invalid("invalid_authorization_code", "Authorization code does not exist");
  }
  if (state.grant.expires_at <= input.now) {
    const cleanup = await mobileAppAuthGrantsRepository.cleanupExpired(input.now, 50);
    if (cleanup.integrityViolations > 0) {
      throw new ElizaError(
        "Expired mobile App Auth grants had unsafe credential ownership or state",
        {
          code: "MOBILE_APP_AUTH_CLEANUP_INTEGRITY_VIOLATION",
          context: { ...cleanup },
          severity: "fatal",
        },
      );
    }
    return invalid("authorization_code_expired", "Authorization code has expired");
  }
  const stateHash = sha256Hex(input.input.state);
  if (
    state.grant.app_id !== input.registration.appId ||
    state.grant.client_id !== input.registration.clientId ||
    state.grant.environment !== input.registration.environment ||
    state.grant.redirect_uri !== input.input.redirectUri ||
    !equalFixedLength(state.grant.state_hash, stateHash)
  ) {
    return invalid("binding_mismatch", "Authorization code binding does not match this request");
  }
  if (!equalFixedLength(state.grant.code_challenge, input.codeChallenge)) {
    return invalid("invalid_code_verifier", "PKCE code verifier does not match");
  }
  return {
    binding: {
      codeHash,
      appId: input.registration.appId,
      clientId: input.registration.clientId,
      environment: input.registration.environment,
      redirectUri: input.input.redirectUri,
      stateHash,
      codeChallenge: input.codeChallenge,
    },
    state,
  };
}

export interface MobileAppAuthCleanupResult {
  grantsDeleted: number;
  grantsScanned: number;
  inactiveCredentialsTombstoned: number;
  acknowledgedCredentialsTombstoned: number;
  integrityViolations: number;
  batchesProcessed: number;
  batchSize: number;
  maxBatches: number;
  scanCapacity: number;
  remainingExpiredGrants: number;
  remainingWork: boolean;
}

export async function cleanupExpiredMobileAppAuthGrants(
  now = new Date(),
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<MobileAppAuthCleanupResult> {
  const {
    batchSize = MOBILE_APP_AUTH_CLEANUP_BATCH_SIZE,
    maxBatches = MOBILE_APP_AUTH_CLEANUP_MAX_BATCHES,
  } = options;
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MOBILE_APP_AUTH_CLEANUP_BATCH_SIZE ||
    !Number.isInteger(maxBatches) ||
    maxBatches < 1 ||
    maxBatches > MOBILE_APP_AUTH_CLEANUP_MAX_BATCHES
  ) {
    throw new ElizaError("Invalid mobile App Auth cleanup bounds", {
      code: "MOBILE_APP_AUTH_CLEANUP_BOUNDS_INVALID",
      context: { batchSize, maxBatches },
      severity: "fatal",
    });
  }

  let grantsDeleted = 0;
  let grantsScanned = 0;
  let inactiveCredentialsTombstoned = 0;
  let acknowledgedCredentialsTombstoned = 0;
  let integrityViolations = 0;
  let batchesProcessed = 0;
  let cursor: MobileAppAuthCleanupCursor | undefined;

  for (let batch = 0; batch < maxBatches; batch++) {
    const result = await mobileAppAuthGrantsRepository.cleanupExpired(now, batchSize, cursor);
    grantsDeleted += result.grantsDeleted;
    grantsScanned += result.grantsScanned;
    inactiveCredentialsTombstoned += result.inactiveCredentialsTombstoned;
    acknowledgedCredentialsTombstoned += result.acknowledgedCredentialsTombstoned;
    integrityViolations += result.integrityViolations;
    if (result.grantsScanned === 0) break;
    batchesProcessed++;
    if (!result.nextCursor) {
      throw new ElizaError("Mobile App Auth cleanup scan lost its stable cursor", {
        code: "MOBILE_APP_AUTH_CLEANUP_CURSOR_MISSING",
        severity: "fatal",
      });
    }
    cursor = result.nextCursor;
    if (result.grantsScanned < batchSize) break;
  }

  const scanCapacity = batchSize * maxBatches;
  if (grantsScanned > scanCapacity) {
    throw new ElizaError("Mobile App Auth cleanup exceeded its bounded scan capacity", {
      code: "MOBILE_APP_AUTH_CLEANUP_SCAN_CAPACITY_EXCEEDED",
      context: { grantsScanned, scanCapacity },
      severity: "fatal",
    });
  }

  const remainingExpiredGrants = await mobileAppAuthGrantsRepository.countExpired(now);
  return {
    grantsDeleted,
    grantsScanned,
    inactiveCredentialsTombstoned,
    acknowledgedCredentialsTombstoned,
    integrityViolations,
    batchesProcessed,
    batchSize,
    maxBatches,
    scanCapacity,
    remainingExpiredGrants,
    remainingWork: remainingExpiredGrants > 0,
  };
}
