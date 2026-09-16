/**
 * Issues and verifies login tokens with deployment-owned signing authority.
 * Persisted issuer, audience and key derivation labels preserve existing sessions.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, scryptSync } from "node:crypto";
import { logger } from "@elizaos/logger";
import {
  calculateJwkThumbprint,
  exportJWK,
  importJWK,
  importPKCS8,
  type JWK,
  type JWTPayload,
  jwtVerify,
  SignJWT,
} from "jose";

function warnAboutJwtConfiguration(message: string): void {
  logger.warn({ scope: "login.jwt" }, `[Login:jwt] ${message}`);
}

export const JWT_ISSUER = "steward";
export const JWT_AUDIENCE = "steward-api";
export const ACCESS_TOKEN_EXPIRY = "15m";
export const ACCESS_TOKEN_EXPIRY_SECONDS = 900;
/** Stable default retained for API compatibility. Runtime overrides are read by getAgentTokenExpiry. */
export const AGENT_TOKEN_EXPIRY = "30d";
export const REFRESH_TOKEN_EXPIRY = "30d";
export const IDENTITY_TOKEN_EXPIRY = ACCESS_TOKEN_EXPIRY;

export type IdentityJwtAlgorithm = "RS256" | "ES256";

export interface LoginJwtPayload extends JWTPayload {
  tenantId?: string;
  address?: string;
  userId?: string;
  email?: string;
  agentId?: string;
  scope?: string;
  tokenType?: "access" | "agent" | "refresh";
  [key: string]: unknown;
}

export interface AccessTokenPayload extends LoginJwtPayload {
  address: string;
  tenantId: string;
}

export interface AgentTokenPayload extends LoginJwtPayload {
  agentId: string;
  tenantId: string;
  scope: "agent";
  /** Plural permissions list. Required for proxy access ("api:proxy"). */
  scopes?: string[];
}

export interface RefreshTokenPayload extends LoginJwtPayload {
  userId: string;
  tenantId: string;
  tokenType: "refresh";
}

export interface JwtSecretOptions {
  /** Defaults to process.env.NODE_ENV. */
  nodeEnv?: string;
  /** Defaults to the structured login logger. Pass null to silence warnings. */
  warn?: ((message: string) => void) | null;
  /** Explicit immutable environment used to construct request-scoped authority. */
  environment?: JwtRuntimeEnvironment;
}

export interface JwtRuntimeEnvironment {
  readonly NODE_ENV?: string;
  readonly STEWARD_JWT_SECRET?: string;
  readonly STEWARD_SESSION_SECRET?: string;
  readonly STEWARD_MASTER_PASSWORD?: string;
  readonly STEWARD_EMBEDDED?: string;
  readonly STEWARD_EMBEDDED_MODE?: string;
  readonly STEWARD_DB_MODE?: string;
  readonly DATABASE_URL?: string;
  readonly STEWARD_ALLOW_DEV_SECRETS?: string;
  readonly STEWARD_ALLOW_DEV_SECRET?: string;
  readonly AGENT_TOKEN_EXPIRY?: string;
  readonly STEWARD_IDENTITY_JWT_ALG?: string;
  readonly STEWARD_IDENTITY_JWT_PRIVATE_KEY?: string;
  readonly STEWARD_IDENTITY_JWT_KID?: string;
  readonly STEWARD_IDENTITY_JWT_ISSUER?: string;
  readonly STEWARD_IDENTITY_JWT_AUDIENCE?: string;
  readonly APP_URL?: string;
}

/** Immutable symmetric and asymmetric JWT authority for one request. */
export interface JwtRuntimeAuthority {
  readonly nodeEnv: string | undefined;
  readonly jwtSecret: string;
  readonly agentTokenExpiry: string;
  readonly identityJwtAlgorithm: IdentityJwtAlgorithm;
  readonly identityJwtPrivateKey?: string;
  readonly identityJwtKid?: string;
  readonly identityJwtIssuer?: string;
  readonly identityJwtAudience: string;
  readonly appUrl?: string;
}

const jwtRuntimeAuthorityStorage = new AsyncLocalStorage<JwtRuntimeAuthority>();

export interface IdentityJwtConfig {
  alg: IdentityJwtAlgorithm;
  kid: string;
  issuer: string;
  audience: string;
}

export class IdentityJwtConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityJwtConfigurationError";
  }
}

let warnedDeprecatedSessionSecret = false;
let warnedEmbeddedMasterFallback = false;
let warnedDevSecret = false;
let warnedShortSecret = false;

/**
 * Embedded-mode JWT secret derivation cache. Deriving via scrypt costs ~50ms,
 * and getJwtSecret() runs on every token sign/verify, so the derived key is
 * memoized per distinct source password.
 */
let embeddedJwtDerivation: { source: string; derived: string } | null = null;

/**
 * Derive the embedded-mode JWT signing secret from STEWARD_MASTER_PASSWORD.
 *
 * The raw master password is NEVER used as the JWT secret (SEC-013): every
 * issued HS256 JWT would otherwise be an unlimited fast offline brute-force
 * oracle against the same password that encrypts vault keys. Instead the JWT
 * secret is scrypt-derived with a domain-separation label (same idiom as the
 * vault's KeyStore domains), so the JWT key is cryptographically independent
 * from the vault root key and offline guesses cost a scrypt each.
 */
function deriveEmbeddedJwtSecret(masterPassword: string): string {
  if (
    embeddedJwtDerivation &&
    embeddedJwtDerivation.source === masterPassword
  ) {
    return embeddedJwtDerivation.derived;
  }
  const derived = (
    scryptSync(masterPassword, "steward-kdf:jwt-signing:v1", 32) as Buffer
  ).toString("hex");
  embeddedJwtDerivation = { source: masterPassword, derived };
  return derived;
}

function isEmbeddedMode(
  environment: JwtRuntimeEnvironment = process.env,
): boolean {
  return (
    environment.STEWARD_EMBEDDED === "true" ||
    environment.STEWARD_EMBEDDED_MODE === "true" ||
    environment.STEWARD_DB_MODE === "pglite" ||
    environment.DATABASE_URL === "pglite://embedded"
  );
}

/**
 * Whether the insecure built-in "dev-secret" fallbacks may be used.
 *
 * Hardened opt-in: a dev-secret is only permitted when the deployment is NOT
 * production AND the operator has explicitly set STEWARD_ALLOW_DEV_SECRETS=true.
 * This prevents a staging/preview deploy that forgot NODE_ENV=production from
 * silently signing/verifying with a well-known, predictable secret.
 *
 * Exported so other packages (vault, webhooks, api key stores) can apply the
 * same consistent guard.
 */
export function isDevSecretAllowed(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  environment: JwtRuntimeEnvironment = process.env,
): boolean {
  if (nodeEnv === "production") return false;
  // Canonical var is STEWARD_ALLOW_DEV_SECRETS; the singular
  // STEWARD_ALLOW_DEV_SECRET is accepted for backwards compatibility.
  return (
    environment.STEWARD_ALLOW_DEV_SECRETS === "true" ||
    environment.STEWARD_ALLOW_DEV_SECRET === "true"
  );
}

function warnOnce(
  kind: "session" | "master" | "dev",
  warn: ((message: string) => void) | null,
) {
  if (!warn) return;
  if (kind === "session") {
    if (warnedDeprecatedSessionSecret) return;
    warnedDeprecatedSessionSecret = true;
    warn(
      "⚠️ STEWARD_SESSION_SECRET is deprecated. Rename it to STEWARD_JWT_SECRET; it is used only as a backwards-compatibility fallback.",
    );
    return;
  }
  if (kind === "master") {
    if (warnedEmbeddedMasterFallback) return;
    warnedEmbeddedMasterFallback = true;
    warn(
      "⚠️ [EMBEDDED/DEV ONLY] Deriving the JWT secret from STEWARD_MASTER_PASSWORD via domain-separated scrypt. Set STEWARD_JWT_SECRET for server deployments.",
    );
    return;
  }
  if (warnedDevSecret) return;
  warnedDevSecret = true;
  warn(
    "⚠️ [DEV ONLY] Using insecure 'dev-secret' for JWT signing/verification. Set STEWARD_JWT_SECRET before production.",
  );
}

/**
 * Length policy for any CONFIGURED JWT secret (SEC-053): production hard-fails
 * below 32 characters; other environments still accept shorter values (tests
 * and local dev rely on them) but warn loudly once, so a staging/preview
 * deploy with a weak secret is visible in logs instead of silently issuing
 * brute-forceable tokens. The explicit dev-secret fallback is not routed here.
 */
export function checkJwtSecretStrength(
  secret: string,
  sourceName: string,
  options: { nodeEnv?: string; warn?: ((message: string) => void) | null } = {},
): void {
  if (secret.length >= 32) return;
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === "production") {
    throw new Error(
      `⛔ ${sourceName} must be at least 32 characters in production (canonical env var: STEWARD_JWT_SECRET).`,
    );
  }
  const warn =
    options.warn === undefined ? warnAboutJwtConfiguration : options.warn;
  if (!warn || warnedShortSecret) return;
  warnedShortSecret = true;
  warn(
    `⚠️ ${sourceName} is shorter than 32 characters; HS256 tokens are cheap to brute-force offline. ` +
      "Use a long random secret anywhere outside local tests.",
  );
}

/**
 * Resolve Steward's canonical JWT secret.
 *
 * Canonical env var: STEWARD_JWT_SECRET.
 * Deprecated compatibility fallback: STEWARD_SESSION_SECRET.
 * In embedded/local dev mode only, STEWARD_MASTER_PASSWORD is accepted as
 * derivation input — never used verbatim (see deriveEmbeddedJwtSecret).
 */
export function getJwtSecret(options: JwtSecretOptions = {}): string {
  const requestAuthority = jwtRuntimeAuthorityStorage.getStore();
  if (!options.environment && requestAuthority)
    return requestAuthority.jwtSecret;

  const environment = options.environment ?? process.env;
  const nodeEnv = options.nodeEnv ?? environment.NODE_ENV;
  const warn =
    options.warn === undefined ? warnAboutJwtConfiguration : options.warn;
  const jwtSecret = environment.STEWARD_JWT_SECRET;
  const sessionSecret = environment.STEWARD_SESSION_SECRET;

  let sourceName:
    | "STEWARD_JWT_SECRET"
    | "STEWARD_SESSION_SECRET"
    | "STEWARD_MASTER_PASSWORD"
    | "dev-secret";
  let secret: string | undefined;

  if (jwtSecret) {
    sourceName = "STEWARD_JWT_SECRET";
    secret = jwtSecret;
  } else if (sessionSecret) {
    sourceName = "STEWARD_SESSION_SECRET";
    secret = sessionSecret;
    warnOnce("session", warn);
  } else if (
    isEmbeddedMode(environment) &&
    environment.STEWARD_MASTER_PASSWORD
  ) {
    sourceName = "STEWARD_MASTER_PASSWORD";
    secret = deriveEmbeddedJwtSecret(environment.STEWARD_MASTER_PASSWORD);
    warnOnce("master", warn);
  } else {
    sourceName = "dev-secret";
  }

  if (nodeEnv === "production") {
    if (!secret) {
      throw new Error(
        "⛔ STEWARD_JWT_SECRET is required in production (minimum 32 characters). STEWARD_SESSION_SECRET is temporarily accepted for migration but deprecated.",
      );
    }
    checkJwtSecretStrength(secret, sourceName, { nodeEnv, warn });
  } else if (secret) {
    checkJwtSecretStrength(secret, sourceName, { nodeEnv, warn });
  }

  if (!secret) {
    if (!isDevSecretAllowed(nodeEnv, environment)) {
      throw new Error(
        "⛔ No JWT secret configured. Set STEWARD_JWT_SECRET, or for local development " +
          "explicitly opt in to the insecure dev fallback with STEWARD_ALLOW_DEV_SECRETS=true " +
          "(never set that in a shared or production environment).",
      );
    }
    warnOnce("dev", warn);
    return "dev-secret";
  }

  return secret;
}

export function getJwtSecretKey(options?: JwtSecretOptions): Uint8Array {
  return new TextEncoder().encode(getJwtSecret(options));
}

function normalizePrivateKeyInput(value: string): string {
  return value.trim().replace(/\\n/g, "\n");
}

function resolveIdentityJwtAlgorithm(value?: string): IdentityJwtAlgorithm {
  const alg = value?.trim() || "RS256";
  if (alg !== "RS256" && alg !== "ES256") {
    throw new Error("STEWARD_IDENTITY_JWT_ALG must be RS256 or ES256");
  }
  return alg;
}

function getIdentityJwtAlgorithm(): IdentityJwtAlgorithm {
  const authority = jwtRuntimeAuthorityStorage.getStore();
  return (
    authority?.identityJwtAlgorithm ??
    resolveIdentityJwtAlgorithm(process.env.STEWARD_IDENTITY_JWT_ALG)
  );
}

function getIdentityJwtPrivateKeyInput(): string | undefined {
  const authority = jwtRuntimeAuthorityStorage.getStore();
  if (authority) return authority.identityJwtPrivateKey;
  return process.env.STEWARD_IDENTITY_JWT_PRIVATE_KEY?.trim() || undefined;
}

export function isAsymmetricIdentityJwtConfigured(): boolean {
  return Boolean(getIdentityJwtPrivateKeyInput());
}

function resolveIdentityJwtBase(requestOrigin?: string): string {
  const authority = jwtRuntimeAuthorityStorage.getStore();
  const nodeEnv = authority?.nodeEnv ?? process.env.NODE_ENV;
  const configured = authority
    ? authority.identityJwtIssuer || authority.appUrl
    : process.env.STEWARD_IDENTITY_JWT_ISSUER?.trim() ||
      process.env.APP_URL?.trim();
  if (configured) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new IdentityJwtConfigurationError(
        "Identity JWT issuer base must be an absolute URL",
      );
    }
    if (
      (url.protocol !== "https:" &&
        (nodeEnv === "production" || url.protocol !== "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new IdentityJwtConfigurationError(
        "Identity JWT issuer base must be a canonical HTTPS URL",
      );
    }
    return url.toString().replace(/\/$/, "");
  }
  if (nodeEnv === "production") {
    throw new IdentityJwtConfigurationError(
      "STEWARD_IDENTITY_JWT_ISSUER or APP_URL is required for identity JWTs",
    );
  }
  return requestOrigin?.trim().replace(/\/$/, "") || JWT_ISSUER;
}

export function getIdentityJwtIssuer(requestOrigin?: string): string {
  return resolveIdentityJwtBase(requestOrigin);
}

/**
 * Resolve the externally visible identity-discovery base for the current
 * request. Worker requests use their immutable authority snapshot so an
 * overlapping invocation cannot substitute its process.env compatibility
 * mirror while this request is suspended.
 */
export function getIdentityDiscoveryBaseUrl(requestUrl: string): string {
  return resolveIdentityJwtBase(new URL(requestUrl).origin);
}

export function getIdentityJwtAudience(): string {
  return (
    jwtRuntimeAuthorityStorage.getStore()?.identityJwtAudience ??
    process.env.STEWARD_IDENTITY_JWT_AUDIENCE?.trim() ??
    JWT_AUDIENCE
  );
}

async function importIdentityPrivateKey(alg: IdentityJwtAlgorithm) {
  const input = getIdentityJwtPrivateKeyInput();
  if (!input) return null;

  const normalized = normalizePrivateKeyInput(input);
  if (normalized.startsWith("{")) {
    return importJWK(JSON.parse(normalized) as JWK, alg, { extractable: true });
  }

  return importPKCS8(normalized, alg, { extractable: true });
}

async function identityPublicJwk(
  alg: IdentityJwtAlgorithm,
): Promise<JWK | null> {
  const privateKey = await importIdentityPrivateKey(alg);
  if (!privateKey) return null;

  const publicJwk = await exportJWK(privateKey);
  publicJwk.alg = alg;
  publicJwk.use = "sig";
  const authority = jwtRuntimeAuthorityStorage.getStore();
  publicJwk.kid = authority
    ? authority.identityJwtKid ||
      publicJwk.kid ||
      (await calculateJwkThumbprint(publicJwk))
    : process.env.STEWARD_IDENTITY_JWT_KID?.trim() ||
      publicJwk.kid ||
      (await calculateJwkThumbprint(publicJwk));
  delete publicJwk.d;
  delete publicJwk.dp;
  delete publicJwk.dq;
  delete publicJwk.p;
  delete publicJwk.q;
  delete publicJwk.qi;
  return publicJwk;
}

export async function getIdentityJwks(): Promise<{ keys: JWK[] }> {
  const alg = getIdentityJwtAlgorithm();
  const publicJwk = await identityPublicJwk(alg);
  return { keys: publicJwk ? [publicJwk] : [] };
}

export async function getIdentityJwtConfig(
  requestOrigin?: string,
): Promise<IdentityJwtConfig | null> {
  if (!isAsymmetricIdentityJwtConfigured()) return null;
  const alg = getIdentityJwtAlgorithm();
  const jwks = await getIdentityJwks();
  const kid = jwks.keys[0]?.kid;
  if (typeof kid !== "string" || !kid) {
    throw new Error("Unable to derive identity JWT key id");
  }
  return {
    alg,
    kid,
    issuer: getIdentityJwtIssuer(requestOrigin),
    audience: getIdentityJwtAudience(),
  };
}

async function getIdentityJwtSigningConfig(
  issuer: string,
  audience: string,
): Promise<IdentityJwtConfig | null> {
  const config = await getIdentityJwtConfig(issuer);
  return config ? { ...config, issuer, audience } : null;
}

/** Validate JWT env at service startup; throws clear errors for invalid production config. */
export function validateJwtSecretEnv(options?: JwtSecretOptions): void {
  getJwtSecret(options);
  if (options?.environment) {
    validateAgentTokenExpiryEnv(
      options.environment.AGENT_TOKEN_EXPIRY ?? AGENT_TOKEN_EXPIRY,
    );
    return;
  }
  validateAgentTokenExpiryEnv();
}

// Matches the relative-duration grammar jose accepts in setExpirationTime,
// restricted to positive forward durations ("30d", "12h", "15 minutes").
const DURATION_PATTERN =
  /^(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)$/i;

const DURATION_UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
  y: 31557600,
  yr: 31557600,
  yrs: 31557600,
  year: 31557600,
  years: 31557600,
};

/** Hard upper bound for AGENT_TOKEN_EXPIRY: one year. */
export const AGENT_TOKEN_EXPIRY_MAX_SECONDS = DURATION_UNIT_SECONDS.y;

/**
 * Parse a relative duration string ("30m", "12h", "5 days") into seconds.
 * Returns null when the value is not a positive forward duration in the
 * grammar jose accepts for setExpirationTime.
 */
export function parseDurationSeconds(value: string): number | null {
  const match = DURATION_PATTERN.exec(value.trim());
  const seconds = match
    ? Number.parseFloat(match[1]) *
      (DURATION_UNIT_SECONDS[match[2].toLowerCase()] ?? Number.NaN)
    : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Validate AGENT_TOKEN_EXPIRY format and bound at startup (SEC-134). A bad
 * value otherwise surfaces as a 500 at token-signing time, and an unbounded
 * value mints effectively-permanent agent tokens.
 *
 * The default resolves an immutable request authority when present, then falls
 * back to process.env for Bun/Node entry points. It never uses a module-init
 * environment capture.
 */
export function validateAgentTokenExpiryEnv(value?: string): void {
  const resolved =
    value ??
    jwtRuntimeAuthorityStorage.getStore()?.agentTokenExpiry ??
    process.env.AGENT_TOKEN_EXPIRY ??
    AGENT_TOKEN_EXPIRY;
  const seconds = parseDurationSeconds(resolved);
  if (seconds === null) {
    throw new Error(
      `⛔ AGENT_TOKEN_EXPIRY "${resolved}" is not a valid positive duration (examples: "30m", "12h", "30d").`,
    );
  }
  if (seconds > AGENT_TOKEN_EXPIRY_MAX_SECONDS) {
    throw new Error(
      `⛔ AGENT_TOKEN_EXPIRY "${resolved}" exceeds the one-year maximum; agent tokens must not be effectively permanent.`,
    );
  }
}

/** Resolve and validate an explicit, request-scoped, or process default agent-token TTL. */
export function getAgentTokenExpiry(value?: string): string {
  const normalized = (
    value ??
    jwtRuntimeAuthorityStorage.getStore()?.agentTokenExpiry ??
    process.env.AGENT_TOKEN_EXPIRY ??
    AGENT_TOKEN_EXPIRY
  ).trim();
  validateAgentTokenExpiryEnv(normalized);
  return normalized;
}

/**
 * Resolve and validate one immutable JWT authority before a Worker request can
 * yield. The returned snapshot never consults process.env again.
 */
export function createJwtRuntimeAuthority(
  environment: JwtRuntimeEnvironment,
  options: Pick<JwtSecretOptions, "warn"> = {},
): Readonly<JwtRuntimeAuthority> {
  const jwtSecret = getJwtSecret({
    environment,
    nodeEnv: environment.NODE_ENV,
    warn: options.warn,
  });
  const agentTokenExpiry = getAgentTokenExpiry(
    environment.AGENT_TOKEN_EXPIRY ?? AGENT_TOKEN_EXPIRY,
  );
  const identityJwtAlgorithm = resolveIdentityJwtAlgorithm(
    environment.STEWARD_IDENTITY_JWT_ALG,
  );
  const identityJwtPrivateKey =
    environment.STEWARD_IDENTITY_JWT_PRIVATE_KEY?.trim() || undefined;
  const identityJwtKid =
    environment.STEWARD_IDENTITY_JWT_KID?.trim() || undefined;
  const identityJwtIssuer =
    environment.STEWARD_IDENTITY_JWT_ISSUER?.trim().replace(/\/$/, "") ||
    undefined;
  const identityJwtAudience =
    environment.STEWARD_IDENTITY_JWT_AUDIENCE?.trim() || JWT_AUDIENCE;
  const appUrl = environment.APP_URL?.trim().replace(/\/$/, "") || undefined;
  return Object.freeze({
    nodeEnv: environment.NODE_ENV,
    jwtSecret,
    agentTokenExpiry,
    identityJwtAlgorithm,
    identityJwtPrivateKey,
    identityJwtKid,
    identityJwtIssuer,
    identityJwtAudience,
    appUrl,
  });
}

/** Bind one immutable JWT authority to all asynchronous work spawned by a request. */
export function withJwtRuntimeAuthority<T>(
  authority: Readonly<JwtRuntimeAuthority>,
  callback: () => T,
): T {
  const immutableAuthority = Object.freeze({
    nodeEnv: authority.nodeEnv,
    jwtSecret: authority.jwtSecret,
    agentTokenExpiry: authority.agentTokenExpiry,
    identityJwtAlgorithm: authority.identityJwtAlgorithm,
    identityJwtPrivateKey: authority.identityJwtPrivateKey,
    identityJwtKid: authority.identityJwtKid,
    identityJwtIssuer: authority.identityJwtIssuer,
    identityJwtAudience: authority.identityJwtAudience,
    appUrl: authority.appUrl,
  });
  return jwtRuntimeAuthorityStorage.run(immutableAuthority, callback);
}

export async function signJwtPayload(
  payload: JWTPayload,
  expiresIn: string,
  secretKey: Uint8Array = getJwtSecretKey(),
  issuer: string = JWT_ISSUER,
  audience: string = JWT_AUDIENCE,
): Promise<string> {
  // Always assign a jti so tokens can be individually revoked via the
  // revocation store. Callers may pre-set payload.jti to override.
  const jti = (typeof payload.jti === "string" && payload.jti) || randomUUID();
  return new SignJWT({ ...payload, jti })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setJti(jti)
    .setExpirationTime(expiresIn as Parameters<SignJWT["setExpirationTime"]>[0])
    .sign(secretKey);
}

export async function signIdentityJwtPayload(
  payload: JWTPayload,
  expiresIn: string = IDENTITY_TOKEN_EXPIRY,
  issuer: string = getIdentityJwtIssuer(),
  audience: string = getIdentityJwtAudience(),
): Promise<string> {
  const config = await getIdentityJwtSigningConfig(issuer, audience);
  if (!config) {
    throw new Error("Identity JWT private key is not configured");
  }

  const privateKey = await importIdentityPrivateKey(config.alg);
  if (!privateKey) {
    throw new Error("Identity JWT private key is not configured");
  }

  const jti = (typeof payload.jti === "string" && payload.jti) || randomUUID();
  return new SignJWT({ ...payload, jti })
    .setProtectedHeader({ alg: config.alg, kid: config.kid })
    .setIssuedAt()
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setJti(jti)
    .setExpirationTime(expiresIn as Parameters<SignJWT["setExpirationTime"]>[0])
    .sign(privateKey);
}

export async function verifyJwtPayload(
  token: string,
  secretKey: Uint8Array = getJwtSecretKey(),
  issuer: string = JWT_ISSUER,
  audience: string = JWT_AUDIENCE,
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, secretKey, {
    issuer,
    audience,
    algorithms: ["HS256"],
  });
  return payload;
}

export async function signAccessToken(
  payload: AccessTokenPayload,
  expiresIn: string = ACCESS_TOKEN_EXPIRY,
): Promise<string> {
  const subject =
    typeof payload.userId === "string" ? payload.userId.trim() : "";
  return signJwtPayload(
    subject ? { ...payload, sub: subject } : payload,
    expiresIn,
  );
}

export async function signAgentToken(
  payload: Omit<AgentTokenPayload, "scope"> & {
    scope?: "agent";
    scopes?: string[];
  },
  expiresIn: string = getAgentTokenExpiry(),
): Promise<string> {
  const merged: Record<string, unknown> = { ...payload, scope: "agent" };
  if (Array.isArray(payload.scopes)) merged.scopes = payload.scopes;
  return signJwtPayload(merged, expiresIn);
}

export async function signRefreshToken(
  payload: RefreshTokenPayload,
  expiresIn: string = REFRESH_TOKEN_EXPIRY,
): Promise<string> {
  return signJwtPayload(payload, expiresIn);
}

export async function verifyToken(token: string): Promise<LoginJwtPayload> {
  return (await verifyJwtPayload(token)) as LoginJwtPayload;
}
