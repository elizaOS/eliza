/**
 * Renderer contract for the native Eliza Cloud sign-in client (`packages/auth/android`,
 * `ai.eliza.auth.cloud.CloudSignInPlugin`).
 *
 * A host subclasses `CloudSignInPlugin` under its own Capacitor name; the renderer calls it
 * through a `NativeCloudSignInPort` and checks every answer here before acting on it. The native
 * side holds the Steward session, PKCE verifiers, states and authorization codes: none of them
 * crosses to the renderer, and the outcomes parsed here carry no secret. Anything unexpected
 * (extra keys, another deployment, malformed times or attempt ids) is refused as `unavailable`
 * rather than trusted.
 *
 * Dependency-free on purpose: products may project this single file from the pinned source.
 * Product names and deployment names are supplied by the caller; nothing here names a product.
 */

/** Failure codes the native client rejects with (`PluginCall.reject(message, code)`). */
export type NativeCloudSignInFailureCode =
  | "cancelled"
  | "login-active"
  | "invalid-phone"
  | "invalid-email"
  | "invalid-code"
  | "cooldown"
  | "expired"
  | "rate-limited"
  | "offline"
  | "unavailable"
  | "account-check"
  | "state-mismatch"
  | "browser-closed"
  | "browser-unavailable"
  | "provider-refused"
  | "mfa-browser"
  | "mfa-unsupported"
  | "activation-pending"
  | "storage"
  | "rejected"
  | "invalid-request"
  | "app-link-unverified"
  | "attempts-exhausted"
  | "google-account-unavailable";

export const NATIVE_CLOUD_SIGN_IN_FAILURE_CODES: ReadonlySet<NativeCloudSignInFailureCode> =
  new Set<NativeCloudSignInFailureCode>([
    "cancelled",
    "login-active",
    "invalid-phone",
    "invalid-email",
    "invalid-code",
    "cooldown",
    "expired",
    "rate-limited",
    "offline",
    "unavailable",
    "account-check",
    "state-mismatch",
    "browser-closed",
    "browser-unavailable",
    "provider-refused",
    "mfa-browser",
    "mfa-unsupported",
    "activation-pending",
    "storage",
    "rejected",
    "invalid-request",
    "app-link-unverified",
    "attempts-exhausted",
    "google-account-unavailable",
  ]);

export interface NativeCloudSignInAuthenticated<E extends string = string> {
  status: "authenticated";
  environment: E;
  expiresAt: number;
  /** True when this sign-in created the Cloud account; null when Cloud did not say. */
  accountCreated: boolean | null;
  /** What happened to the key this sign-in replaced; absent when none was saved. */
  previousSignIn?: "revoked" | "unconfirmed";
}
export interface NativeCloudSignInCodeStarted {
  attemptId: string;
  expiresAt: number;
  resendAt: number;
}
export interface NativeCloudSignInMfaRequired {
  attemptId?: string;
  status: "mfa";
  method: "totp" | "sms" | "passkey";
  expiresAt: number;
}
export interface NativeCloudSignInGoogleMfaRequired<E extends string = string>
  extends NativeCloudSignInMfaRequired {
  attemptId: string;
  environment: E;
}
export type NativeCloudSignInGoogleOutcome<E extends string = string> =
  | NativeCloudSignInAuthenticated<E>
  | NativeCloudSignInGoogleMfaRequired<E>;
export interface NativeCloudSignInReadiness {
  google: boolean;
  phone: boolean;
  email: boolean;
}

/** The plugin methods of `CloudSignInPlugin`, as a renderer port. Answers are untrusted until parsed. */
export interface NativeCloudSignInPort<E extends string = string> {
  serviceInfo?(input: { environment: E }): Promise<unknown>;
  /** Opens Android's native Google account picker; answers only authenticated or MFA metadata. */
  startGoogle(input: { environment: E }): Promise<unknown>;
  startEmail(input: { environment: E; email: string }): Promise<unknown>;
  startPhone?(input: { environment: E; phone: string }): Promise<unknown>;
  verifyPhone?(input: { attemptId: string; code: string }): Promise<unknown>;
  verifyEmail(input: { attemptId: string; code: string }): Promise<unknown>;
  verifyMfa(input: { attemptId: string; code: string }): Promise<unknown>;
  /** Revalidates a retained MFA event against the current native attempt; no network or secrets. */
  resumeMfa?(input: { attemptId: string; environment: E }): Promise<unknown>;
  /** Ends the attempt and burns any pending Google record. Idempotent. */
  cancel(): Promise<void>;
  /** Clears only the native credential picker session after explicit sign-out. */
  clearCredentialState?(): Promise<void>;
  /** Which methods the host offers and whether Cloud is ready for in-app sign-in (`inApp`). */
  status?(input?: {
    environment: E;
    refreshNegative?: boolean;
  }): Promise<unknown>;
  /**
   * `signInCompleted`: a Google return that completed after the app restarted (no waiting call).
   * `signInIncomplete`: a return without a sign-in result arrived with no waiting call.
   * `signInMfaRequired`: a retained hint that must be revalidated through `resumeMfa`.
   */
  addListener?(
    event: "signInCompleted" | "signInIncomplete" | "signInMfaRequired",
    listener: (outcome: unknown) => void,
  ): Promise<unknown>;
}

export class NativeCloudSignInError extends Error {
  readonly code: NativeCloudSignInFailureCode;
  constructor(code: NativeCloudSignInFailureCode) {
    super(`Cloud sign-in ${code}`);
    this.code = code;
    this.name = "NativeCloudSignInError";
  }
  /** A native rejection keeps its code only when it is one the client defines. */
  static from(error: unknown): NativeCloudSignInError {
    if (error instanceof NativeCloudSignInError) return error;
    const code =
      error && typeof error === "object"
        ? (error as { code?: unknown }).code
        : undefined;
    return new NativeCloudSignInError(
      typeof code === "string" &&
        NATIVE_CLOUD_SIGN_IN_FAILURE_CODES.has(
          code as NativeCloudSignInFailureCode,
        )
        ? (code as NativeCloudSignInFailureCode)
        : "unavailable",
    );
  }
}

export interface NativeCloudSignInCopy {
  /** The deployment's public name, e.g. "Eliza Cloud". */
  serviceName: string;
  /** The app's own name, e.g. "Eliza". */
  productName: string;
}

/** Owner-facing copy. Never includes server text, codes or addresses. */
export function nativeCloudSignInFailureMessage(
  code: NativeCloudSignInFailureCode,
  { serviceName, productName }: NativeCloudSignInCopy,
): string {
  switch (code) {
    case "cancelled":
      return "Sign-in cancelled.";
    case "login-active":
      return "A sign-in is already in progress. Finish or cancel it first.";
    case "invalid-phone":
      return "Enter your phone number with its country code, such as +14155550100.";
    case "invalid-email":
      return "Enter a valid email address.";
    case "invalid-code":
      return "That code did not work. Check it and try again, or send a new code.";
    case "cooldown":
      return "Wait a minute before sending another code.";
    case "expired":
      return "This sign-in expired. Start again.";
    case "rate-limited":
      return "Too many attempts. Wait a few minutes, then try again.";
    case "offline":
      return `${productName} could not reach ${serviceName}. Check your connection and try again.`;
    case "account-check":
      return `This account needs an extra check that ${productName} cannot complete. Use account recovery or contact ${serviceName} support.`;
    case "state-mismatch":
      return "That sign-in return did not match this phone’s request. Start again.";
    case "browser-closed":
      return "Google sign-in was closed before it finished. Start again when you are ready.";
    case "browser-unavailable":
      return "No browser that can show Google sign-in is available. Use your email instead.";
    case "google-account-unavailable":
      return "Google could not complete sign-in on this device. Check your Google account and update Google Play services, then try again or use email.";
    case "provider-refused":
      return "Google did not complete the sign-in. Try again or use your email.";
    case "mfa-browser":
      return `This account needs a second verification step. Sign in with your email to complete it in ${productName}.`;
    case "mfa-unsupported":
      return `This account’s second verification method is not available in ${productName} yet. Use account recovery or contact ${serviceName} support.`;
    case "activation-pending":
      return `Signed in, but ${serviceName} has not confirmed this phone yet. ${productName} retries when it starts again; you can also sign in again.`;
    case "storage":
      return `${productName} could not save the sign-in securely on this phone. Try again.`;
    case "app-link-unverified":
      return `${productName} did not receive the sign-in from your browser, so you are not signed in yet. Start sign-in again in ${productName}.`;
    case "attempts-exhausted":
      return "Too many incorrect codes. Send a new code and try again.";
    case "rejected":
    case "invalid-request":
      return `${serviceName} refused this sign-in. Start again.`;
    default:
      return `${serviceName} sign-in is unavailable right now. Try again.`;
  }
}

const ATTEMPT_ID = /^[0-9a-f-]{36}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new NativeCloudSignInError("unavailable");
  return value as Record<string, unknown>;
}
function time(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new NativeCloudSignInError("unavailable");
  return parsed;
}

/** A completed sign-in for exactly this deployment, with nothing but the documented fields. */
export function nativeSignInAuthenticated<E extends string>(
  value: unknown,
  environment: E,
): NativeCloudSignInAuthenticated<E> {
  const row = object(value);
  if (row.status !== "authenticated" || row.environment !== environment)
    throw new NativeCloudSignInError("unavailable");
  for (const key of Object.keys(row))
    if (
      ![
        "status",
        "environment",
        "expiresAt",
        "accountCreated",
        "previousSignIn",
      ].includes(key)
    )
      throw new NativeCloudSignInError("unavailable");
  if (
    row.previousSignIn !== undefined &&
    row.previousSignIn !== "revoked" &&
    row.previousSignIn !== "unconfirmed"
  )
    throw new NativeCloudSignInError("unavailable");
  return {
    status: "authenticated",
    environment,
    expiresAt: time(row.expiresAt),
    accountCreated:
      typeof row.accountCreated === "boolean" ? row.accountCreated : null,
    ...(row.previousSignIn === undefined
      ? {}
      : { previousSignIn: row.previousSignIn }),
  };
}

/** The answer to `startEmail` or `startPhone`: the attempt and when a new code may be sent. */
export function nativeSignInCodeStarted(
  value: unknown,
): NativeCloudSignInCodeStarted {
  const row = object(value);
  if (typeof row.attemptId !== "string" || !ATTEMPT_ID.test(row.attemptId))
    throw new NativeCloudSignInError("unavailable");
  return {
    attemptId: row.attemptId,
    expiresAt: time(row.expiresAt),
    resendAt: time(row.resendAt),
  };
}

/** The answer to a code verification: signed in, or a second factor is required. */
export function nativeSignInVerified<E extends string>(
  value: unknown,
  environment: E,
): NativeCloudSignInAuthenticated<E> | NativeCloudSignInMfaRequired {
  const row = object(value);
  if (row.status === "mfa") {
    // Only the documented fields, and only for this deployment when the host names one.
    if (
      Object.keys(row).some(
        (key) =>
          ![
            "status",
            "method",
            "expiresAt",
            "attemptId",
            "environment",
          ].includes(key),
      ) ||
      (row.environment !== undefined && row.environment !== environment)
    )
      throw new NativeCloudSignInError("unavailable");
    if (
      row.method !== "totp" &&
      row.method !== "sms" &&
      row.method !== "passkey"
    )
      throw new NativeCloudSignInError("unavailable");
    if (
      row.attemptId !== undefined &&
      (typeof row.attemptId !== "string" || !ATTEMPT_ID.test(row.attemptId))
    )
      throw new NativeCloudSignInError("unavailable");
    return {
      status: "mfa",
      method: row.method,
      expiresAt: time(row.expiresAt),
      ...(row.attemptId === undefined
        ? {}
        : { attemptId: row.attemptId as string }),
    };
  }
  return nativeSignInAuthenticated(row, environment);
}

/** Google may require a native second factor; bind it to this attempt and deployment. */
export function nativeSignInGoogleOutcome<E extends string>(
  value: unknown,
  environment: E,
  now: number = Date.now(),
): NativeCloudSignInGoogleOutcome<E> {
  const row = object(value);
  const outcome = nativeSignInVerified(row, environment);
  if (outcome.status !== "mfa") return outcome;
  if (
    row.environment !== environment ||
    typeof row.attemptId !== "string" ||
    !UUID.test(row.attemptId)
  )
    throw new NativeCloudSignInError("unavailable");
  if (
    Object.keys(row).some(
      (key) =>
        !["status", "method", "expiresAt", "attemptId", "environment"].includes(
          key,
        ),
    )
  )
    throw new NativeCloudSignInError("unavailable");
  if (outcome.expiresAt <= now) throw new NativeCloudSignInError("expired");
  return { ...outcome, attemptId: row.attemptId, environment };
}

/**
 * Explicit method readiness from the host's `status`. Unknown readiness (null) keeps the email
 * error and retry surface; known disabled methods stay hidden. SMS is never inferred.
 */
export function nativeSignInReadiness(
  value: unknown,
): NativeCloudSignInReadiness | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.inApp !== true && row.methodsKnown !== true) return null;
  return {
    google: row.google === true,
    phone: row.phone === true,
    email: row.email === true,
  };
}

/** Six digits, ignoring spaces and dashes the owner typed; null otherwise. */
export const normalizeNativeSignInCode = (value: string): string | null => {
  const digits = value.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
};
export const validNativeSignInEmail = (value: string): boolean =>
  value.length <= 320 &&
  /^[^\s@\p{Cc}\p{Cf}]+@[^\s@\p{Cc}\p{Cf}]+\.[^\s@\p{Cc}\p{Cf}]+$/u.test(
    value.trim(),
  );
/** E.164 with its country code. */
export const validNativeSignInPhone = (value: string): boolean =>
  /^\+[1-9][0-9]{6,14}$/.test(value.trim());
