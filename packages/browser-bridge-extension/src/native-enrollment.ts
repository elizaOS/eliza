/**
 * Owns the extension side of the versioned native-messaging enrollment
 * protocol. Native-host responses are untrusted until every request binding,
 * timestamp, profile, browser, URL, and credential field has been validated.
 */
import type {
  BrowserBridgeCompanionConfig,
  BrowserBridgeKind,
} from "./browser-bridge-contracts";
import { normalizeCompanionConfig } from "./storage";

export const BROWSER_BRIDGE_NATIVE_HOST = "ai.elizaos.browserbridge";

/** Allows the periodic alarm to observe an owner reset without weakening the broker tombstone. */
export function shouldProbeRevokedEnrollment(
  reason: string,
  connectionIssue: string | null,
): boolean {
  return reason === "alarm" && connectionIssue === "recovery_required";
}
export const NATIVE_ENROLLMENT_PROTOCOL_VERSION = 1 as const;
export const NATIVE_ENROLLMENT_TIMEOUT_MS = 5_000;
export const NATIVE_ENROLLMENT_MAX_MESSAGE_BYTES = 64 * 1024;
export const NATIVE_ENROLLMENT_MAX_RESPONSE_AGE_MS = 2 * 60 * 1_000;
export const NATIVE_ENROLLMENT_MAX_FUTURE_SKEW_MS = 30 * 1_000;
export const NATIVE_ENROLLMENT_MIN_TOKEN_LIFETIME_MS = 30 * 1_000;
export const NATIVE_ENROLLMENT_INITIAL_BACKOFF_MS = 1_000;
export const NATIVE_ENROLLMENT_MAX_BACKOFF_MS = 5 * 60 * 1_000;
export const NATIVE_ENROLLMENT_APP_RETRY_MAX_MS = 30 * 1_000;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9@._:-]{1,256}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_RESULT_KEYS = [
  "v",
  "type",
  "requestId",
  "nonce",
  "issuedAt",
  "config",
] as const;
const RESPONSE_ERROR_KEYS = [
  "v",
  "type",
  "requestId",
  "code",
  "retryable",
] as const;
const CONFIG_KEYS = [
  "apiBaseUrl",
  "companionId",
  "pairingToken",
  "pairingTokenExpiresAt",
  "browser",
  "profileId",
  "profileLabel",
  "label",
] as const;
const NATIVE_ERROR_RETRYABILITY = {
  app_not_running: true,
  app_not_authenticated: true,
  revoked: false,
  unsupported_version: false,
  broker_unavailable: true,
} as const;

export type NativeEnrollmentRequest = {
  v: 1;
  type: "browser_bridge.enroll";
  requestId: string;
  nonce: string;
  extensionId: string;
  extensionVersion: string;
  browser: BrowserBridgeKind;
  profileId: string;
};

export type NativeEnrollmentResult = {
  v: 1;
  type: "browser_bridge.enroll_result";
  requestId: string;
  nonce: string;
  issuedAt: string;
  config: BrowserBridgeCompanionConfig;
};

export type NativeEnrollmentFailure = {
  v: 1;
  type: "browser_bridge.error";
  requestId: string;
  code: string;
  retryable: boolean;
};

export type NativeEnrollmentResponse =
  | NativeEnrollmentResult
  | NativeEnrollmentFailure;

export type NativeEnrollmentSuppressionReason =
  | "owner_disconnected"
  | "companion_revoked"
  | "credential_invalid";

export type NativeEnrollmentState = {
  consecutiveFailures: number;
  nextAttemptAt: string | null;
  lastFailureCode: string | null;
  suppressedReason: NativeEnrollmentSuppressionReason | null;
};

export const EMPTY_NATIVE_ENROLLMENT_STATE: NativeEnrollmentState = {
  consecutiveFailures: 0,
  nextAttemptAt: null,
  lastFailureCode: null,
  suppressedReason: null,
};

export class NativeEnrollmentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NativeEnrollmentError";
  }
}

export function isNativeEnrollmentRevocation(error: unknown): boolean {
  return error instanceof NativeEnrollmentError && error.code === "revoked";
}

type EnrollmentBindings = {
  browser: BrowserBridgeKind;
  profileId: string;
};

export type NativeEnrollmentDependencies = {
  getExtensionId: () => string;
  getExtensionVersion: () => string;
  send: (request: NativeEnrollmentRequest) => Promise<unknown>;
  loadState: () => Promise<NativeEnrollmentState>;
  saveState: (state: NativeEnrollmentState) => Promise<void>;
  now?: () => number;
  randomUUID?: () => string;
  randomBytes?: (length: number) => Uint8Array;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function serializedByteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    // error-policy:J3 Cyclic or otherwise non-JSON native data is invalid.
    throw new NativeEnrollmentError(
      `Native enrollment message is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "invalid_native_message",
      false,
    );
  }
  if (typeof serialized !== "string") {
    throw new NativeEnrollmentError(
      "Native enrollment message is not a JSON object.",
      "invalid_native_message",
      false,
    );
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function enforceMessageSize(value: unknown): void {
  if (serializedByteLength(value) > NATIVE_ENROLLMENT_MAX_MESSAGE_BYTES) {
    throw new NativeEnrollmentError(
      "Native enrollment message exceeds the 64 KiB limit.",
      "native_message_too_large",
      false,
    );
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parseIsoTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new NativeEnrollmentError(
      `Native enrollment ${field} is invalid.`,
      "invalid_native_response",
      false,
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new NativeEnrollmentError(
      `Native enrollment ${field} is invalid.`,
      "invalid_native_response",
      false,
    );
  }
  return parsed;
}

function validateBoundedText(
  value: unknown,
  field: string,
  maximumLength = 256,
): string {
  const hasControlCharacter = [
    ...(typeof value === "string" ? value : ""),
  ].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    value.length > maximumLength ||
    hasControlCharacter
  ) {
    throw new NativeEnrollmentError(
      `Native enrollment config ${field} is invalid.`,
      "invalid_native_response",
      false,
    );
  }
  return value;
}

function validateLoopbackApiBaseUrl(value: unknown): string {
  const raw = validateBoundedText(value, "apiBaseUrl", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // error-policy:J3 The native host's API base is untrusted protocol input.
    throw new NativeEnrollmentError(
      "Native enrollment config apiBaseUrl is invalid.",
      "invalid_native_response",
      false,
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "http:" ||
    (hostname !== "127.0.0.1" &&
      hostname !== "localhost" &&
      hostname !== "[::1]") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    raw !== parsed.origin
  ) {
    throw new NativeEnrollmentError(
      "Native enrollment config apiBaseUrl must be an exact loopback HTTP origin.",
      "invalid_native_response",
      false,
    );
  }
  return raw;
}

function validateRawCompanionConfig(config: Record<string, unknown>): void {
  validateLoopbackApiBaseUrl(config.apiBaseUrl);
  validateBoundedText(config.companionId, "companionId");
  validateBoundedText(config.profileLabel, "profileLabel");
  validateBoundedText(config.label, "label");
  if (
    typeof config.pairingToken !== "string" ||
    !/^[\x21-\x7e]{16,4096}$/.test(config.pairingToken)
  ) {
    throw new NativeEnrollmentError(
      "Native enrollment config pairingToken is invalid.",
      "invalid_native_response",
      false,
    );
  }
}

function validateBinding(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new NativeEnrollmentError(
      `Native enrollment ${field} is invalid.`,
      "invalid_native_request",
      false,
    );
  }
  return value;
}

function validateUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new NativeEnrollmentError(
      `Native enrollment ${field} is invalid.`,
      "invalid_native_request",
      false,
    );
  }
  return value.toLowerCase();
}

function isRevocationCode(code: string): boolean {
  return code === "revoked";
}

function calculateBackoffMs(
  consecutiveFailures: number,
  failureCode: string,
): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 16));
  const maximum =
    failureCode === "app_not_running" || failureCode === "app_not_authenticated"
      ? NATIVE_ENROLLMENT_APP_RETRY_MAX_MS
      : NATIVE_ENROLLMENT_MAX_BACKOFF_MS;
  return Math.min(
    maximum,
    NATIVE_ENROLLMENT_INITIAL_BACKOFF_MS * 2 ** exponent,
  );
}

function createRequest(
  dependencies: Required<
    Pick<NativeEnrollmentDependencies, "randomUUID" | "randomBytes">
  > &
    NativeEnrollmentDependencies,
  bindings: EnrollmentBindings,
): NativeEnrollmentRequest {
  const requestId = dependencies.randomUUID();
  const nonce = base64Url(dependencies.randomBytes(32));
  const request: NativeEnrollmentRequest = {
    v: NATIVE_ENROLLMENT_PROTOCOL_VERSION,
    type: "browser_bridge.enroll",
    requestId,
    nonce,
    extensionId: validateBinding(dependencies.getExtensionId(), "extensionId"),
    extensionVersion: validateBinding(
      dependencies.getExtensionVersion(),
      "extensionVersion",
    ),
    browser: bindings.browser,
    profileId: validateUuid(bindings.profileId, "profileId"),
  };
  if (!UUID_PATTERN.test(requestId) || !NONCE_PATTERN.test(nonce)) {
    throw new NativeEnrollmentError(
      "Native enrollment request entropy is invalid.",
      "invalid_native_request",
      false,
    );
  }
  enforceMessageSize(request);
  return request;
}

export function validateNativeEnrollmentResponse(
  response: unknown,
  request: NativeEnrollmentRequest,
  now = Date.now(),
): NativeEnrollmentResult {
  enforceMessageSize(response);
  if (!isRecord(response) || response.v !== 1) {
    throw new NativeEnrollmentError(
      "Native enrollment response has an unsupported schema.",
      "invalid_native_response",
      false,
    );
  }
  if (response.type === "browser_bridge.error") {
    if (
      !hasExactKeys(response, RESPONSE_ERROR_KEYS) ||
      response.requestId !== request.requestId ||
      typeof response.code !== "string" ||
      !Object.hasOwn(NATIVE_ERROR_RETRYABILITY, response.code) ||
      typeof response.retryable !== "boolean"
    ) {
      throw new NativeEnrollmentError(
        "Native enrollment error response is invalid or unbound.",
        "invalid_native_response",
        false,
      );
    }
    const code = response.code as keyof typeof NATIVE_ERROR_RETRYABILITY;
    if (response.retryable !== NATIVE_ERROR_RETRYABILITY[code]) {
      throw new NativeEnrollmentError(
        "Native enrollment error response has invalid retry semantics.",
        "invalid_native_response",
        false,
      );
    }
    throw new NativeEnrollmentError(
      `Native enrollment failed (${code}).`,
      code,
      response.retryable,
    );
  }
  if (
    response.type !== "browser_bridge.enroll_result" ||
    !hasExactKeys(response, RESPONSE_RESULT_KEYS) ||
    response.requestId !== request.requestId ||
    response.nonce !== request.nonce ||
    !isRecord(response.config) ||
    !hasExactKeys(response.config, CONFIG_KEYS)
  ) {
    throw new NativeEnrollmentError(
      "Native enrollment response is invalid or does not match its request.",
      "invalid_native_response",
      false,
    );
  }
  validateRawCompanionConfig(response.config);
  const issuedAt = parseIsoTimestamp(response.issuedAt, "issuedAt");
  if (
    issuedAt < now - NATIVE_ENROLLMENT_MAX_RESPONSE_AGE_MS ||
    issuedAt > now + NATIVE_ENROLLMENT_MAX_FUTURE_SKEW_MS
  ) {
    throw new NativeEnrollmentError(
      "Native enrollment response is outside the accepted time window.",
      "invalid_native_response",
      false,
    );
  }
  const config = normalizeCompanionConfig(response.config);
  if (
    !config ||
    config.browser !== request.browser ||
    config.profileId !== request.profileId
  ) {
    throw new NativeEnrollmentError(
      "Native enrollment config does not match the requested browser profile.",
      "invalid_native_response",
      false,
    );
  }
  const tokenExpiresAt = parseIsoTimestamp(
    config.pairingTokenExpiresAt,
    "pairingTokenExpiresAt",
  );
  if (
    tokenExpiresAt <= issuedAt ||
    tokenExpiresAt < now + NATIVE_ENROLLMENT_MIN_TOKEN_LIFETIME_MS
  ) {
    throw new NativeEnrollmentError(
      "Native enrollment credential is already expired or too close to expiry.",
      "invalid_native_response",
      false,
    );
  }
  return {
    v: 1,
    type: "browser_bridge.enroll_result",
    requestId: request.requestId,
    nonce: request.nonce,
    issuedAt: response.issuedAt as string,
    config,
  };
}

export class NativeEnrollmentCoordinator {
  private inFlight: {
    key: string;
    promise: Promise<BrowserBridgeCompanionConfig>;
  } | null = null;
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly timeoutMs: number;

  constructor(private readonly dependencies: NativeEnrollmentDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
    this.randomBytes =
      dependencies.randomBytes ??
      ((length) => crypto.getRandomValues(new Uint8Array(length)));
    this.timeoutMs = dependencies.timeoutMs ?? NATIVE_ENROLLMENT_TIMEOUT_MS;
  }

  async enroll(
    bindings: EnrollmentBindings,
    options: { bypassBackoff?: boolean } = {},
  ): Promise<BrowserBridgeCompanionConfig> {
    const key = `${bindings.browser}:${bindings.profileId}`;
    if (this.inFlight) {
      if (this.inFlight.key !== key) {
        throw new NativeEnrollmentError(
          "A different browser profile enrollment is already running.",
          "native_enrollment_conflict",
          true,
        );
      }
      return await this.inFlight.promise;
    }
    const promise = this.runEnrollment(bindings, options);
    this.inFlight = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    }
  }

  private async runEnrollment(
    bindings: EnrollmentBindings,
    options: { bypassBackoff?: boolean },
  ): Promise<BrowserBridgeCompanionConfig> {
    const state = await this.dependencies.loadState();
    if (state.suppressedReason) {
      throw new NativeEnrollmentError(
        "Automatic browser enrollment is disabled after an explicit disconnect or revocation.",
        "native_enrollment_suppressed",
        false,
      );
    }
    const nextAttemptAt = state.nextAttemptAt
      ? Date.parse(state.nextAttemptAt)
      : Number.NaN;
    if (
      !options.bypassBackoff &&
      Number.isFinite(nextAttemptAt) &&
      nextAttemptAt > this.now()
    ) {
      throw new NativeEnrollmentError(
        "Automatic browser enrollment is waiting before retrying.",
        "native_enrollment_backoff",
        true,
      );
    }

    const request = createRequest(
      {
        ...this.dependencies,
        randomUUID: this.randomUUID,
        randomBytes: this.randomBytes,
      },
      bindings,
    );
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new NativeEnrollmentError(
              `Native enrollment timed out after ${this.timeoutMs} ms.`,
              "native_enrollment_timeout",
              true,
            ),
          );
        }, this.timeoutMs);
      });
      const rawResponse = await Promise.race([
        this.dependencies.send(request),
        timeout,
      ]);
      const response = validateNativeEnrollmentResponse(
        rawResponse,
        request,
        this.now(),
      );
      await this.dependencies.saveState({ ...EMPTY_NATIVE_ENROLLMENT_STATE });
      return response.config;
    } catch (error) {
      // error-policy:J1 Enrollment is the native-protocol boundary. It records
      // bounded retry state without logging or persisting returned secrets.
      const normalized =
        error instanceof NativeEnrollmentError
          ? error
          : new NativeEnrollmentError(
              "The browser native enrollment host is unavailable.",
              "native_host_unavailable",
              true,
            );
      const failures = Math.min(state.consecutiveFailures + 1, 32);
      await this.dependencies.saveState({
        consecutiveFailures: failures,
        nextAttemptAt: normalized.retryable
          ? new Date(
              this.now() + calculateBackoffMs(failures, normalized.code),
            ).toISOString()
          : null,
        lastFailureCode: normalized.code,
        suppressedReason: isRevocationCode(normalized.code)
          ? "companion_revoked"
          : null,
      });
      throw normalized;
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  }
}
