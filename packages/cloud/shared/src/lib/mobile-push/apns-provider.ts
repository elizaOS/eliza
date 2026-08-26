/** Sends APNs alerts from Workerd with provider-token authentication and typed rejection results. */

import { bytesToBase64Url, sha256Base64Url, stringToBase64Url } from "../crypto/worker";
import type { MobilePushDeliveryResult, MobilePushMessage } from "./types";

const APNS_SANDBOX_ORIGIN = "https://api.sandbox.push.apple.com";
const APNS_PRODUCTION_ORIGIN = "https://api.push.apple.com";
const APNS_PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;
const APNS_REQUEST_TIMEOUT_MS = 10_000;
const APNS_MAX_PAYLOAD_BYTES = 4_096;
export const ELIZA_IOS_BUNDLE_ID = "ai.elizaos.app";

export interface CloudApnsBindings {
  ELIZA_APNS_KEY?: string;
  ELIZA_APNS_KEY_ID?: string;
  ELIZA_APNS_TEAM_ID?: string;
  ELIZA_APNS_TOPIC?: string;
  ELIZA_APNS_PRODUCTION?: string;
}

export interface CloudApnsConfig {
  key: string;
  keyId: string;
  teamId: string;
  topic: typeof ELIZA_IOS_BUNDLE_ID;
  production: boolean;
}

export function resolveCloudApnsConfig(bindings: CloudApnsBindings): CloudApnsConfig | null {
  const key = bindings.ELIZA_APNS_KEY?.trim();
  const keyId = bindings.ELIZA_APNS_KEY_ID?.trim();
  const teamId = bindings.ELIZA_APNS_TEAM_ID?.trim();
  const topic = bindings.ELIZA_APNS_TOPIC?.trim();
  const production = bindings.ELIZA_APNS_PRODUCTION?.trim();
  if (!key && !keyId && !teamId && !topic && !production) return null;
  if (!key || !keyId || !teamId || !topic) {
    throw new Error("Cloud APNs configuration is incomplete");
  }
  if (topic !== ELIZA_IOS_BUNDLE_ID) {
    throw new Error(`Cloud APNs topic must be ${ELIZA_IOS_BUNDLE_ID}`);
  }
  if (production !== "0" && production !== "1") {
    throw new Error('ELIZA_APNS_PRODUCTION must be explicitly "0" or "1"');
  }
  return { key, keyId, teamId, topic, production: production === "1" };
}

interface CachedProviderToken {
  value: string;
  mintedAt: number;
}

function base64url(value: Uint8Array | string): string {
  return typeof value === "string" ? stringToBase64Url(value) : bytesToBase64Url(value);
}

function pkcs8Bytes(pem: string): Uint8Array {
  const encoded = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replaceAll(/\s/g, "");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class CloudApnsProvider {
  private cachedToken?: CachedProviderToken;
  private importedKey?: Promise<CryptoKey>;
  private pendingToken?: Promise<CachedProviderToken>;

  constructor(
    private readonly config: CloudApnsConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async providerToken(now: number): Promise<string> {
    if (this.cachedToken && now - this.cachedToken.mintedAt < APNS_PROVIDER_TOKEN_TTL_MS) {
      return this.cachedToken.value;
    }
    this.pendingToken ??= (async () => {
      this.importedKey ??= crypto.subtle.importKey(
        "pkcs8",
        Uint8Array.from(pkcs8Bytes(this.config.key)).buffer,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      const key = await this.importedKey;
      const signingInput = `${base64url(JSON.stringify({ alg: "ES256", kid: this.config.keyId }))}.${base64url(
        JSON.stringify({ iss: this.config.teamId, iat: Math.floor(now / 1000) }),
      )}`;
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        new TextEncoder().encode(signingInput),
      );
      return { value: `${signingInput}.${base64url(new Uint8Array(signature))}`, mintedAt: now };
    })();
    const pendingToken = this.pendingToken;
    try {
      this.cachedToken = await pendingToken;
      return this.cachedToken.value;
    } finally {
      if (this.pendingToken === pendingToken) this.pendingToken = undefined;
    }
  }

  async send(
    token: string,
    message: MobilePushMessage,
    now = Date.now(),
  ): Promise<MobilePushDeliveryResult> {
    const origin = this.config.production ? APNS_PRODUCTION_ORIGIN : APNS_SANDBOX_ORIGIN;
    const body = JSON.stringify({
      ...(message.data ?? {}),
      aps: {
        alert: { title: message.title, ...(message.body ? { body: message.body } : {}) },
        sound: "default",
      },
    });
    if (new TextEncoder().encode(body).length > APNS_MAX_PAYLOAD_BYTES) {
      return { outcome: "rejected", status: 413, reason: "PayloadTooLarge" };
    }
    const collapseId = message.collapseKey ? await sha256Base64Url(message.collapseKey) : undefined;
    const response = await this.request(`${origin}/3/device/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${await this.providerToken(now)}`,
        "apns-topic": this.config.topic,
        "apns-push-type": "alert",
        "content-type": "application/json",
        ...(collapseId ? { "apns-collapse-id": collapseId } : {}),
      },
      body,
      signal: AbortSignal.timeout(APNS_REQUEST_TIMEOUT_MS),
    });
    const apnsId = response.headers.get("apns-id") ?? undefined;
    if (response.status === 200) return { outcome: "accepted", ...(apnsId ? { apnsId } : {}) };
    let errorBody: { reason?: unknown } | null = null;
    try {
      errorBody = (await response.json()) as { reason?: unknown };
    } catch {
      // error-policy:J3 an unreadable APNs rejection body has no typed reason.
    }
    const reason = typeof errorBody?.reason === "string" ? errorBody.reason : undefined;
    if (reason === "Unregistered" || reason === "BadDeviceToken" || reason === "ExpiredToken") {
      return { outcome: "unregistered", reason };
    }
    return { outcome: "rejected", status: response.status, ...(reason ? { reason } : {}) };
  }
}
