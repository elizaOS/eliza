/**
 * Signs and verifies timestamped Cloud callbacks using the existing Eliza
 * callback wire format. Billing notifications trigger an authoritative read;
 * receivers persist the delivery ID with their work to reject duplicate delivery.
 */

export interface AppBillingNotification {
  version: 1;
  id: string;
  event: "app.subscription.updated";
  appId: string;
  environment: "test" | "live";
  billingAccountId: string;
  productFamilyKey: string;
  subscriptionRevision: string;
  occurredAt: string;
}

export class AppNotificationError extends Error {
  readonly code = "APP_NOTIFICATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AppNotificationError";
  }
}

async function signingKey(
  secret: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (secret.length === 0)
    throw new AppNotificationError("Callback signing key is unavailable");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

/** Signs exact serialized bytes; callers must not parse or reserialize before verification. */
export async function createAppNotificationSignature(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await signingKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return `sha256=${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function envelope(value: unknown): AppBillingNotification {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppNotificationError("Callback envelope is invalid");
  }
  const record: Record<string, unknown> = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.event !== "app.subscription.updated" ||
    (record.environment !== "test" && record.environment !== "live") ||
    !uuid(record.id) ||
    !uuid(record.appId) ||
    !uuid(record.billingAccountId) ||
    typeof record.productFamilyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(record.productFamilyKey) ||
    typeof record.subscriptionRevision !== "string" ||
    !/^[1-9]\d*$/u.test(record.subscriptionRevision) ||
    !isoTimestamp(record.occurredAt)
  ) {
    throw new AppNotificationError(
      "Callback envelope does not satisfy the app billing contract",
    );
  }
  return {
    version: record.version,
    id: record.id,
    event: record.event,
    appId: record.appId,
    environment: record.environment,
    billingAccountId: record.billingAccountId,
    productFamilyKey: record.productFamilyKey,
    subscriptionRevision: record.subscriptionRevision,
    occurredAt: record.occurredAt,
  };
}

/**
 * Authenticates X-Eliza-Timestamp and X-Eliza-Signature before reading the
 * envelope. A valid signature does not deduplicate delivery or grant access.
 */
export async function verifyAppBillingNotification(input: {
  secret: string;
  expectedAppId: string;
  expectedEnvironment: "test" | "live";
  timestamp: string;
  signature: string;
  body: string;
  now?: Date;
  toleranceSeconds?: number;
}): Promise<AppBillingNotification> {
  const now = input.now ?? new Date();
  const tolerance = input.toleranceSeconds ?? 300;
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(tolerance) ||
    tolerance <= 0 ||
    !isoTimestamp(input.timestamp) ||
    Math.abs(now.getTime() - Date.parse(input.timestamp)) > tolerance * 1000 ||
    !/^sha256=[0-9a-f]{64}$/u.test(input.signature)
  ) {
    throw new AppNotificationError(
      "Callback timestamp or signature is invalid or expired",
    );
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    const offset = 7 + index * 2;
    bytes[index] = Number.parseInt(
      input.signature.substring(offset, offset + 2),
      16,
    );
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(input.secret, ["verify"]),
    bytes,
    new TextEncoder().encode(`${input.timestamp}.${input.body}`),
  );
  if (!valid) throw new AppNotificationError("Callback signature is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    // error-policy:J3 Signed but malformed JSON is an explicit invalid callback.
    throw new AppNotificationError("Callback body is not valid JSON");
  }
  const notification = envelope(parsed);
  if (notification.appId !== input.expectedAppId)
    throw new AppNotificationError("Callback belongs to a different app");
  if (notification.environment !== input.expectedEnvironment)
    throw new AppNotificationError(
      "Callback belongs to a different billing environment",
    );
  return notification;
}

/** Developer-readable configuration excludes signing material; rotation returns a secret once. */
export interface AppBillingNotificationConfig {
  appId: string;
  environment: "test" | "live";
  endpointUrl: string | null;
  enabled: boolean;
  revision: string | null;
  keyId: string | null;
  pendingKeyId: string | null;
  lastDeliveredAt: string | null;
  pendingCount: number;
  failedCount: number;
}
export interface AppBillingNotificationConfigIntent {
  clientRegistrationId: string;
  expectedRevision: string | null;
}
export interface ConfigureAppBillingNotifications
  extends AppBillingNotificationConfigIntent {
  endpointUrl: string;
  enabled: boolean;
}
export interface AppBillingNotificationKeyPreparation {
  config: AppBillingNotificationConfig;
  /** Install on the app server before activation. Cloud never returns this value again. */
  signingSecret: string;
}
