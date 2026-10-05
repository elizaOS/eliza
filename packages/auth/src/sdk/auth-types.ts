/** Defines authentication providers, browser session state and login flow results. */

// ─── Storage interface ────────────────────────────────────────────────────────

/**
 * Interface for pluggable session storage.
 * Compatible with `localStorage`, `sessionStorage`, or any custom implementation.
 */
export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// ─── User & session types ─────────────────────────────────────────────────────

export interface LoginUser {
  id: string;
  email: string | null;
  walletAddress?: string;
  walletChain?: "ethereum" | "solana";
  isGuest?: boolean;
  guestExpiresAt?: string | null;
  tenantId?: string;
  alreadyUpgraded?: boolean;
}

export type LoginMfaMethod =
  | "totp"
  | "sms"
  | "passkey"
  | "recovery_code"
  | string;

export interface LoginSession {
  /** Raw JWT string (access token, 15 min) */
  token: string;
  /** Parsed token payload fields */
  address: string;
  tenantId: string;
  userId?: string;
  email?: string;
  isGuest?: boolean;
  guestExpiresAt?: string | null;
  /** Unix milliseconds when this session last completed MFA step-up, when present. */
  mfaVerifiedAt?: number;
  /** MFA factor used for the current session step-up claim. */
  mfaMethod?: LoginMfaMethod;
  /** Unix milliseconds when this session last satisfied factor-enrollment step-up, when present. */
  factorEnrollmentVerifiedAt?: number;
  /** Expiry as unix timestamp (seconds) — parsed from JWT `exp` claim */
  expiresAt?: number;
  /** The user object returned at sign-in time (if available) */
  user?: LoginUser;
}

// ─── Auth result types ────────────────────────────────────────────────────────

export interface LoginAuthResult {
  /** Short-lived access token (15 min) */
  token: string;
  /** Long-lived refresh token (30 days). Store securely and never expose in URLs. */
  refreshToken: string;
  /** Access token lifetime in seconds (900) */
  expiresIn: number;
  user: LoginUser;
}

export interface LoginGuestSignInOptions {
  tenantId?: string;
  /** Server accepts bounded durations like "30m", "24h", or "7d". */
  expiresIn?: string;
}

export interface LoginGuestState {
  isGuest: boolean;
  userId?: string;
  tenantId?: string;
  expiresAt?: string | null;
  expiresAtMs?: number | null;
  isExpired: boolean;
  secondsUntilExpiry?: number | null;
  expiryMessage: string | null;
}

export interface LoginGuestUpgradeEmailInput {
  email: string;
  token: string;
}

export interface LoginGuestDeleteResult {
  ok: boolean;
  deleted: boolean;
  userId?: string;
}

export interface LoginMfaRequiredResult {
  ok: true;
  mfaRequired: true;
  mfa: {
    type: "totp" | "sms" | "passkey";
    challengeId: string;
    expiresAt: string;
  };
  user: LoginUser;
}

/** Shared response shape for auth flows that exchange a challenge or callback for a session. */
export interface LoginAuthExchangeResponse {
  ok: boolean;
  token?: string;
  user: LoginUser;
  refreshToken?: string;
  expiresIn?: number;
  mfaRequired?: boolean;
  mfa?: LoginMfaRequiredResult["mfa"];
  userId?: string;
  address?: string;
  publicKey?: string;
  walletChain?: "ethereum" | "solana";
  tenant?: {
    id: string;
    name: string;
    apiKey?: string;
  };
}

export interface LoginEmbeddedWalletLoginConfig {
  tenantId: string;
  createOnLogin: "off" | "users-without-wallets" | "all-users";
}

export interface LoginCurrentUserResult {
  userId: string;
  address?: string;
  email?: string;
  wallet: { address: string; agentId: string } | null;
  walletAutoCreated: boolean;
  embeddedWalletConfig: LoginEmbeddedWalletLoginConfig;
}

export interface LoginEmailResult {
  ok: boolean;
  expiresAt: string;
  /** Opaque public challenge id for cross-device email sign-in polling. */
  challengeId?: string;
  /** High-entropy secret required with challengeId when polling. Store only client-side. */
  pollSecret?: string;
}

export type LoginEmailSignInStatusResult =
  | { ok: true; status: "pending"; expiresAt?: string }
  | { ok: true; status: "consumed" | "locked" | "expired" | "invalid" };

export interface LoginSmsOtpResult {
  ok: boolean;
  expiresAt: string;
}

export interface LoginWhatsAppOtpResult {
  ok: boolean;
  expiresAt: string;
}

/**
 * Result of `sendEmailOtp` — a 6-digit code was emailed (Privy-style signup).
 * The actual proof-of-ownership is obtained via `verifyEmailOtp`.
 */
export interface LoginEmailOtpResult {
  ok: boolean;
  /** ISO timestamp the emailed code expires at, when the server provides it. */
  expiresAt?: string;
}

/**
 * Result of `verifyEmailOtp` — a short-lived, single-use grant proving
 * ownership of the email. Pass `emailGrant` to
 * `addPasskey(email, { emailGrant })` so a brand-new, signed-out user can
 * register a passkey WITHOUT a session.
 */
export interface LoginEmailGrantResult {
  ok: boolean;
  /** Single-use grant token bound to {email, tenant}. Expires shortly. */
  emailGrant: string;
  /** Seconds until the grant expires (server-provided). */
  expiresInSeconds: number;
}

/** Stable server payload for verified-email recovery on an existing RP passkey. */
export interface LoginPasskeyAlreadyRegisteredErrorData {
  ok: false;
  error: string;
  code: "passkey_already_registered";
}

export interface LoginTestAccountLoginOptions {
  tenantId?: string;
  email?: string;
  phone?: string;
  otp: string;
}

export interface LoginTelegramLoginPayload {
  id: string | number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string | number;
  hash: string;
  [key: string]: string | number | boolean | null | undefined;
}

export interface LoginTelegramLoginConfig {
  tenantId?: string;
}

export interface LoginFarcasterLoginPayload {
  message: string;
  signature: string;
  custodyAddress?: string;
  address?: string;
  fid?: string | number;
  username?: string;
  displayName?: string;
  pfpUrl?: string;
  pfp?: string;
}

export interface LoginFarcasterLoginConfig {
  tenantId?: string;
}

export interface LoginTotpEnrollResult {
  ok: boolean;
  secret: string;
  otpauthUri: string;
  expiresAt: string;
}

export interface LoginTotpVerifyResult {
  ok: boolean;
  enabled?: boolean;
  verified?: boolean;
  recoveryCodes?: string[];
}

export interface LoginTotpStatus {
  ok: boolean;
  enabled: boolean;
  pending: boolean;
}

export interface LoginRecoveryCodeStatus {
  ok: boolean;
  enabled: boolean;
  remaining: number;
}

export interface LoginRecoveryCodesResult {
  ok: boolean;
  recoveryCodes: string[];
}

export interface LoginSmsMfaStatus {
  ok: boolean;
  enabled: boolean;
  pending: boolean;
  phone?: string;
}

export interface LoginSmsMfaEnrollResult {
  ok: boolean;
  phone: string;
  expiresAt: string;
}

export interface LoginSmsMfaVerifyResult {
  ok: boolean;
  enabled: boolean;
  phone: string;
}

export interface LoginLinkedAccount {
  id: string;
  provider: string;
  providerAccountId: string;
  expiresAt: number | null;
}

export interface LoginIdentityClaims {
  sub: string;
  userId: string;
  tenantId: string;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
  image: string | null;
  walletAddress: string | null;
  walletChain: string | null;
  customMetadata: Record<string, unknown>;
  tenantIds: string[];
  linkedAccounts: LoginLinkedAccount[];
}

export interface LoginIdentityTokenResult {
  ok: boolean;
  token: string;
  expiresIn: number;
  claims: LoginIdentityClaims;
  user: {
    id: string;
    email: string | null;
    walletAddress?: string | null;
    walletChain?: string | null;
    emailVerified?: boolean | null;
    name?: string | null;
    image?: string | null;
    customMetadata?: Record<string, unknown>;
    linkedAccounts?: LoginLinkedAccount[];
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface LoginAuthConfig {
  /** Base URL of the login API, e.g. "http://localhost:3200" for a self-hosted instance */
  baseUrl: string;
  /**
   * Optional storage backend for persisting access and refresh tokens.
   * Defaults to in-memory (session lost on page reload / process restart) so
   * browser XSS cannot read long-lived refresh tokens from localStorage by default.
   * Pass `sessionStorage`, `localStorage`, or a custom implementation only when
   * that persistence tradeoff is explicit.
   */
  storage?: SessionStorage;
  /**
   * Called whenever the session changes (sign-in, sign-out, token refresh).
   * Receives `null` when signed out, `StewardSession` when signed in.
   */
  onSessionChange?: (session: LoginSession | null) => void;
  /**
   * Default tenant to authenticate against.
   * When set, all sign-in methods include this tenantId in requests.
   */
  tenantId?: string;
  /**
   * Optional same-origin auth proxy prefix (e.g. "/api/auth") that holds the
   * long-lived refresh token in an HttpOnly, SameSite=Strict cookie the page's
   * JavaScript cannot read. When set:
   *   - sign-in deposits the refresh token with the proxy instead of `storage`;
   *   - refresh / revoke / tenant-switch calls go to the proxy, which injects
   *     the cookie-held token before forwarding to the login API;
   *   - only the short-lived access token is kept in `storage`.
   * Leave unset to keep refresh tokens in `storage` (default, unchanged).
   */
  authProxyUrl?: string;
  /**
   * Permit a plaintext non-loopback baseUrl (warns at construction). HTTPS is
   * required by default so session credentials never travel cleartext
   * off-loopback.
   */
  allowInsecureBaseUrl?: boolean;
}

/** Response shape from POST /auth/refresh */
export interface LoginRefreshResult {
  token: string;
  refreshToken: string;
  expiresIn: number;
}

// ─── Device authorization types ──────────────────────────────────────────────

export interface LoginDeviceCodeOptions {
  tenantId?: string;
  clientId?: string;
  scope?: string;
}

export interface LoginDeviceCodeResult {
  ok: boolean;
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
  tenantId: string;
  client_id?: string;
}

export type LoginDeviceTokenError =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_client"
  | "invalid_request"
  | "unsupported_grant_type";

export interface LoginDeviceTokenPendingResult {
  ok: false;
  error: LoginDeviceTokenError;
  interval?: number;
}

export interface LoginDeviceVerifyResult {
  ok: boolean;
  status: "approved" | "denied";
  tenantId: string;
}

// ─── OAuth types ──────────────────────────────────────────────────────────────

/**
 * Configuration for an OAuth sign-in attempt.
 */
export interface LoginOAuthConfig {
  /** OAuth provider name, e.g. "google" or "discord" */
  provider: string;
  /** Override the redirect URI (defaults to current page origin + /auth/callback) */
  redirectUri?: string;
  /** Tenant to authenticate into */
  tenantId?: string;
  /** Popup window width in pixels (default: 500) */
  popupWidth?: number;
  /** Popup window height in pixels (default: 600) */
  popupHeight?: number;
}

/**
 * Result from a successful OAuth sign-in.
 */
export interface LoginOAuthResult extends LoginAuthResult {
  /** The OAuth provider that was used */
  provider: string;
}

export interface LoginJwtLoginConfig {
  tenantId: string;
  providerId?: string;
}

/**
 * Discovery response from GET /auth/providers.
 * Indicates which authentication methods are enabled on the server.
 */
export interface LoginProviders {
  passkey: boolean;
  email: boolean;
  sms?: boolean;
  whatsapp?: boolean;
  totp?: boolean;
  siwe: boolean;
  siws: boolean;
  google: boolean;
  discord: boolean;
  github: boolean;
  twitter: boolean;
  telegram?: boolean;
  farcaster?: boolean;
  linkedin?: boolean;
  spotify?: boolean;
  twitch?: boolean;
  instagram?: boolean;
  line?: boolean;
  jwt?: boolean;
  oidc?: string[];
  captcha?: {
    enabled?: boolean;
    provider?: "turnstile" | "hcaptcha";
    siteKey?: string;
    requiredFor?: Array<"email_otp" | "sms_otp">;
  };
  /** List of all enabled OAuth provider names */
  oauth: string[];
  disabled?: string[];
}

// ─── Multi-tenant types ───────────────────────────────────────────────────────

/** A user's membership in a tenant/app. */
export interface LoginTenantMembership {
  tenantId: string;
  tenantName: string;
  role: string;
  joinedAt: string;
}

/** Tenant info (from admin/discovery endpoints). */
export interface LoginTenantInfo {
  id: string;
  name: string;
  joinMode: "open" | "invite" | "closed";
  memberCount?: number;
}
