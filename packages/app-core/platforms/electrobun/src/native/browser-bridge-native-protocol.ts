/**
 * Defines the strict extension-facing native-messaging schema and the separate
 * authenticated native-host to current-user desktop broker envelope.
 */

import crypto from "node:crypto";

export const BROWSER_BRIDGE_NATIVE_HOST_NAME = "ai.elizaos.browserbridge";
export const BROWSER_BRIDGE_BROKER_PROTOCOL = "eliza.browser-bridge.broker/v1";
export const MAX_NATIVE_MESSAGE_BYTES = 64 * 1024;
export const NATIVE_MESSAGE_CLOCK_SKEW_MS = 30_000;
export const NATIVE_PAIRING_TOKEN_MAX_TTL_MS = 5 * 60_000;

export type BrowserBridgeNativeBrowser = "chrome" | "firefox" | "safari";

export interface BrowserBridgeNativeEnrollmentRequest {
  v: 1;
  type: "browser_bridge.enroll";
  requestId: string;
  nonce: string;
  browser: BrowserBridgeNativeBrowser;
  extensionId: string;
  extensionVersion: string;
  profileId: string;
}

export interface BrowserBridgeNativeEnrollmentConfig {
  apiBaseUrl: string;
  companionId: string;
  pairingToken: string;
  pairingTokenExpiresAt: string;
  browser: BrowserBridgeNativeBrowser;
  profileId: string;
  profileLabel: string;
  label: string;
}

export interface BrowserBridgeNativeEnrollmentResult {
  v: 1;
  type: "browser_bridge.enroll_result";
  requestId: string;
  nonce: string;
  issuedAt: string;
  config: BrowserBridgeNativeEnrollmentConfig;
}

export type BrowserBridgeNativeErrorCode =
  | "app_not_running"
  | "app_not_authenticated"
  | "revoked"
  | "unsupported_version"
  | "broker_unavailable";

export interface BrowserBridgeNativeErrorResponse {
  v: 1;
  type: "browser_bridge.error";
  requestId: string | null;
  code: BrowserBridgeNativeErrorCode;
  retryable: boolean;
}

export type BrowserBridgeNativeResponse =
  | BrowserBridgeNativeEnrollmentResult
  | BrowserBridgeNativeErrorResponse;

export interface BrowserBridgeNativeCaller {
  browser: BrowserBridgeNativeBrowser;
  id: string;
}

export interface BrowserBridgeBrokerEnvelope {
  protocol: typeof BROWSER_BRIDGE_BROKER_PROTOCOL;
  timestampMs: number;
  caller: BrowserBridgeNativeCaller;
  request: BrowserBridgeNativeEnrollmentRequest;
  mac: string;
}

export interface BrowserBridgeCallerAllowlist {
  chromeExtensionIds: readonly string[];
  firefoxExtensionIds: readonly string[];
  safariExtensionIds: readonly string[];
}

export class BrowserBridgeNativeProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserBridgeNativeProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
): void {
  const allowed = new Set(required);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new BrowserBridgeNativeProtocolError(
        "unknown_field",
        `native enrollment message contains unknown field: ${key}`,
      );
    }
  }
  for (const key of required) {
    if (!(key in record)) {
      throw new BrowserBridgeNativeProtocolError(
        "missing_field",
        `native enrollment message is missing field: ${key}`,
      );
    }
  }
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_field",
      `${key} is invalid`,
    );
  }
  return value;
}

function parseBrowser(value: unknown): BrowserBridgeNativeBrowser {
  if (value === "chrome" || value === "firefox" || value === "safari")
    return value;
  throw new BrowserBridgeNativeProtocolError(
    "invalid_browser",
    "browser is invalid",
  );
}

export function parseNativeHostLaunchCaller(
  browser: BrowserBridgeNativeBrowser,
  rawCaller: string,
): BrowserBridgeNativeCaller {
  if (browser === "chrome") {
    let parsed: URL;
    try {
      parsed = new URL(rawCaller);
    } catch (cause) {
      // error-policy:J3 browser launch arguments must parse into an exact extension origin.
      throw new BrowserBridgeNativeProtocolError(
        "invalid_caller",
        cause instanceof Error
          ? `Chrome launch caller is invalid: ${cause.message}`
          : "Chrome launch caller is invalid",
      );
    }
    if (
      parsed.protocol !== "chrome-extension:" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      !/^[a-p]{32}$/.test(parsed.hostname)
    ) {
      throw new BrowserBridgeNativeProtocolError(
        "invalid_caller",
        "Chrome launch caller must be an exact extension origin",
      );
    }
    return { browser, id: parsed.hostname };
  }
  if (
    rawCaller.length === 0 ||
    rawCaller.length > 256 ||
    !/^[A-Za-z0-9@._{}-]+$/.test(rawCaller)
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_caller",
      `${browser} launch caller ID is invalid`,
    );
  }
  return { browser, id: rawCaller };
}

function requireUuid(value: string, field: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_field",
      `${field} must be a UUID`,
    );
  }
  return value;
}

export function parseNativeEnrollmentRequest(
  input: unknown,
): BrowserBridgeNativeEnrollmentRequest {
  if (!isRecord(input)) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_message",
      "native enrollment message must be an object",
    );
  }
  assertExactKeys(input, [
    "v",
    "type",
    "requestId",
    "nonce",
    "browser",
    "extensionId",
    "extensionVersion",
    "profileId",
  ]);
  if (input.v !== 1 || input.type !== "browser_bridge.enroll") {
    throw new BrowserBridgeNativeProtocolError(
      "unsupported_protocol",
      "native enrollment request version or type is unsupported",
    );
  }
  const nonce = requiredString(input, "nonce", 43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_nonce",
      "nonce must encode exactly 32 bytes as base64url",
    );
  }
  const extensionVersion = requiredString(input, "extensionVersion", 64);
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      extensionVersion,
    )
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_extension_version",
      "extensionVersion must be semantic versioning",
    );
  }
  return {
    v: 1,
    type: "browser_bridge.enroll",
    requestId: requireUuid(requiredString(input, "requestId", 36), "requestId"),
    nonce,
    browser: parseBrowser(input.browser),
    extensionId: requiredString(input, "extensionId", 256),
    extensionVersion,
    profileId: requireUuid(requiredString(input, "profileId", 36), "profileId"),
  };
}

const NATIVE_ERROR_CODES = new Set<BrowserBridgeNativeErrorCode>([
  "app_not_running",
  "app_not_authenticated",
  "revoked",
  "unsupported_version",
  "broker_unavailable",
]);

export function parseNativeEnrollmentResponse(
  input: unknown,
): BrowserBridgeNativeResponse {
  if (!isRecord(input) || input.v !== 1) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_response",
      "native response is invalid",
    );
  }
  if (input.type === "browser_bridge.error") {
    assertExactKeys(input, ["v", "type", "requestId", "code", "retryable"]);
    const requestId =
      input.requestId === null
        ? null
        : requireUuid(requiredString(input, "requestId", 36), "requestId");
    if (
      typeof input.code !== "string" ||
      !NATIVE_ERROR_CODES.has(input.code as BrowserBridgeNativeErrorCode) ||
      typeof input.retryable !== "boolean"
    ) {
      throw new BrowserBridgeNativeProtocolError(
        "invalid_response",
        "native error response is invalid",
      );
    }
    return {
      v: 1,
      type: "browser_bridge.error",
      requestId,
      code: input.code as BrowserBridgeNativeErrorCode,
      retryable: input.retryable,
    };
  }
  if (input.type !== "browser_bridge.enroll_result") {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_response",
      "native response type is invalid",
    );
  }
  assertExactKeys(input, [
    "v",
    "type",
    "requestId",
    "nonce",
    "issuedAt",
    "config",
  ]);
  if (!isRecord(input.config)) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_response",
      "native response config is invalid",
    );
  }
  assertExactKeys(input.config, [
    "apiBaseUrl",
    "companionId",
    "pairingToken",
    "pairingTokenExpiresAt",
    "browser",
    "profileId",
    "profileLabel",
    "label",
  ]);
  const nonce = requiredString(input, "nonce", 43);
  const pairingTokenExpiresAt = requiredString(
    input.config,
    "pairingTokenExpiresAt",
    64,
  );
  const issuedAt = requiredString(input, "issuedAt", 64);
  const apiBaseUrl = requiredString(input.config, "apiBaseUrl", 2048);
  let parsedApiBase: URL;
  try {
    parsedApiBase = new URL(apiBaseUrl);
  } catch (cause) {
    // error-policy:J3 broker config must contain a structurally valid loopback URL.
    throw new BrowserBridgeNativeProtocolError(
      "invalid_response",
      cause instanceof Error
        ? `native response API base is invalid: ${cause.message}`
        : "native response API base is invalid",
    );
  }
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
    !Number.isFinite(Date.parse(issuedAt)) ||
    parsedApiBase.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(
      parsedApiBase.hostname,
    ) ||
    parsedApiBase.username !== "" ||
    parsedApiBase.password !== "" ||
    parsedApiBase.pathname !== "/" ||
    parsedApiBase.search !== "" ||
    parsedApiBase.hash !== "" ||
    !Number.isFinite(Date.parse(pairingTokenExpiresAt))
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_response",
      "native enrollment result is invalid",
    );
  }
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(pairingTokenExpiresAt);
  if (
    expiresAtMs <= issuedAtMs ||
    expiresAtMs > issuedAtMs + NATIVE_PAIRING_TOKEN_MAX_TTL_MS
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_response",
      "native response pairing token expiry is outside the enrollment window",
    );
  }
  return {
    v: 1,
    type: "browser_bridge.enroll_result",
    requestId: requireUuid(requiredString(input, "requestId", 36), "requestId"),
    nonce,
    issuedAt,
    config: {
      apiBaseUrl,
      companionId: requiredString(input.config, "companionId", 256),
      pairingToken: requiredString(input.config, "pairingToken", 4096),
      pairingTokenExpiresAt,
      browser: parseBrowser(input.config.browser),
      profileId: requireUuid(
        requiredString(input.config, "profileId", 36),
        "profileId",
      ),
      profileLabel: requiredString(input.config, "profileLabel", 256),
      label: requiredString(input.config, "label", 256),
    },
  };
}

export function parseBrokerEnvelope(
  input: unknown,
): BrowserBridgeBrokerEnvelope {
  if (!isRecord(input)) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_message",
      "broker envelope must be an object",
    );
  }
  assertExactKeys(input, [
    "protocol",
    "timestampMs",
    "caller",
    "request",
    "mac",
  ]);
  if (input.protocol !== BROWSER_BRIDGE_BROKER_PROTOCOL) {
    throw new BrowserBridgeNativeProtocolError(
      "unsupported_protocol",
      "broker protocol is unsupported",
    );
  }
  if (
    typeof input.timestampMs !== "number" ||
    !Number.isSafeInteger(input.timestampMs) ||
    input.timestampMs <= 0
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_timestamp",
      "timestamp is invalid",
    );
  }
  if (!isRecord(input.caller)) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_caller",
      "caller is invalid",
    );
  }
  assertExactKeys(input.caller, ["browser", "id"]);
  return {
    protocol: BROWSER_BRIDGE_BROKER_PROTOCOL,
    timestampMs: input.timestampMs,
    caller: {
      browser: parseBrowser(input.caller.browser),
      id: requiredString(input.caller, "id", 256),
    },
    request: parseNativeEnrollmentRequest(input.request),
    mac: requiredString(input, "mac", 128),
  };
}

function allowedCallerIds(
  browser: BrowserBridgeNativeBrowser,
  allowlist: BrowserBridgeCallerAllowlist,
): readonly string[] {
  if (browser === "chrome") return allowlist.chromeExtensionIds;
  if (browser === "firefox") return allowlist.firefoxExtensionIds;
  return allowlist.safariExtensionIds;
}

export function assertNativeHostCaller(
  request: BrowserBridgeNativeEnrollmentRequest,
  caller: BrowserBridgeNativeCaller,
  allowlist: BrowserBridgeCallerAllowlist,
): void {
  if (
    request.browser !== caller.browser ||
    request.extensionId !== caller.id ||
    !allowedCallerIds(caller.browser, allowlist).includes(caller.id)
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "caller_not_allowed",
      "native enrollment caller does not match an allowlisted extension",
    );
  }
}

export function canonicalBrokerEnvelopeData(
  envelope: Omit<BrowserBridgeBrokerEnvelope, "mac">,
): string {
  return [
    envelope.protocol,
    String(envelope.timestampMs),
    envelope.caller.browser,
    envelope.caller.id,
    String(envelope.request.v),
    envelope.request.type,
    envelope.request.requestId,
    envelope.request.nonce,
    envelope.request.browser,
    envelope.request.extensionId,
    envelope.request.extensionVersion,
    envelope.request.profileId,
  ].join("\n");
}

export function signBrokerEnvelope(
  envelope: Omit<BrowserBridgeBrokerEnvelope, "mac">,
  secret: Uint8Array,
): BrowserBridgeBrokerEnvelope {
  if (secret.byteLength < 32) {
    throw new BrowserBridgeNativeProtocolError(
      "weak_broker_secret",
      "broker secret must contain at least 32 bytes",
    );
  }
  const mac = crypto
    .createHmac("sha256", secret)
    .update(canonicalBrokerEnvelopeData(envelope), "utf8")
    .digest("base64url");
  return { ...envelope, mac };
}

export function createAuthenticatedBrokerEnvelope(options: {
  request: BrowserBridgeNativeEnrollmentRequest;
  launchedCaller: BrowserBridgeNativeCaller;
  allowlist: BrowserBridgeCallerAllowlist;
  secret: Uint8Array;
  timestampMs?: number;
}): BrowserBridgeBrokerEnvelope {
  assertNativeHostCaller(
    options.request,
    options.launchedCaller,
    options.allowlist,
  );
  return signBrokerEnvelope(
    {
      protocol: BROWSER_BRIDGE_BROKER_PROTOCOL,
      timestampMs: options.timestampMs ?? Date.now(),
      caller: options.launchedCaller,
      request: options.request,
    },
    options.secret,
  );
}

export class NativeEnrollmentReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = NATIVE_MESSAGE_CLOCK_SKEW_MS * 2,
    private readonly capacity = 4096,
  ) {}

  consume(nonce: string, nowMs: number): void {
    for (const [seenNonce, expiresAt] of this.seen) {
      if (expiresAt <= nowMs) this.seen.delete(seenNonce);
    }
    if (this.seen.has(nonce)) {
      throw new BrowserBridgeNativeProtocolError(
        "replayed_nonce",
        "native enrollment nonce has already been used",
      );
    }
    if (this.seen.size >= this.capacity) {
      throw new BrowserBridgeNativeProtocolError(
        "replay_capacity_exceeded",
        "native enrollment replay window is full",
      );
    }
    this.seen.set(nonce, nowMs + this.ttlMs);
  }
}

export function authenticateBrokerEnvelope(
  envelope: BrowserBridgeBrokerEnvelope,
  options: {
    secret: Uint8Array;
    allowlist: BrowserBridgeCallerAllowlist;
    replayGuard: NativeEnrollmentReplayGuard;
    nowMs?: number;
  },
): void {
  const nowMs = options.nowMs ?? Date.now();
  if (Math.abs(nowMs - envelope.timestampMs) > NATIVE_MESSAGE_CLOCK_SKEW_MS) {
    throw new BrowserBridgeNativeProtocolError(
      "stale_timestamp",
      "broker envelope timestamp is outside the accepted window",
    );
  }
  assertNativeHostCaller(envelope.request, envelope.caller, options.allowlist);
  const expected = signBrokerEnvelope(
    {
      protocol: envelope.protocol,
      timestampMs: envelope.timestampMs,
      caller: envelope.caller,
      request: envelope.request,
    },
    options.secret,
  ).mac;
  const providedBuffer = Buffer.from(envelope.mac, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new BrowserBridgeNativeProtocolError(
      "invalid_mac",
      "broker envelope authentication failed",
    );
  }
  options.replayGuard.consume(envelope.request.nonce, nowMs);
}

export function encodeNativeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength === 0 || body.byteLength > MAX_NATIVE_MESSAGE_BYTES) {
    throw new BrowserBridgeNativeProtocolError(
      "message_too_large",
      "native message exceeds the configured size limit",
    );
  }
  const frame = Buffer.allocUnsafe(body.byteLength + 4);
  frame.writeUInt32LE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

export class NativeMessageDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const messages: unknown[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (length === 0 || length > MAX_NATIVE_MESSAGE_BYTES) {
        throw new BrowserBridgeNativeProtocolError(
          "invalid_frame_length",
          "native message frame length is invalid",
        );
      }
      if (this.pending.byteLength < length + 4) break;
      const body = this.pending.subarray(4, length + 4);
      this.pending = this.pending.subarray(length + 4);
      try {
        messages.push(JSON.parse(body.toString("utf8")) as unknown);
      } catch (cause) {
        // error-policy:J3 untrusted native-messaging bytes become an explicit protocol failure.
        throw new BrowserBridgeNativeProtocolError(
          "invalid_json",
          cause instanceof Error
            ? `native message JSON is invalid: ${cause.message}`
            : "native message JSON is invalid",
        );
      }
    }
    return messages;
  }

  finish(): void {
    if (this.pending.byteLength !== 0) {
      throw new BrowserBridgeNativeProtocolError(
        "truncated_frame",
        "native message stream ended with a truncated frame",
      );
    }
  }
}
