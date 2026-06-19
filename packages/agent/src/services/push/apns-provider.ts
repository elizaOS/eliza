/**
 * ApnsProvider — Apple Push Notification service (HTTP/2) sender.
 *
 * Auth is a JWT provider token (Apple's token-based auth): an ES256 JWT signed
 * with the team's .p8 EC private key, header `{ alg:"ES256", kid: <keyId> }`,
 * claims `{ iss: <teamId>, iat: <now> }`. The token is reused until it nears
 * Apple's 1-hour cap, then re-minted.
 *
 * Delivery POSTs to `https://api.push.apple.com/3/device/<token>` (or the
 * sandbox host) over HTTP/2 with headers `apns-topic`, `apns-push-type:"alert"`,
 * and `authorization: bearer <jwt>`. The payload is the standard APNs alert
 * shape `{ aps: { alert: { title, body }, sound:"default" }, ...customData }`.
 *
 * VERIFIABILITY: the JWT minting (`mintToken`) and request shaping are pure and
 * unit-tested with a throwaway P-256 key. Actual delivery hits Apple's servers
 * and is NOT exercised in tests — it requires a real APNs auth key, a real
 * bundle id, and a real device token.
 */

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, constants as http2Constants } from "node:http2";
import {
  type PushMessage,
  type PushProvider,
  PushUnregisteredError,
} from "./push-types.ts";

const PROD_HOST = "https://api.push.apple.com";
const SANDBOX_HOST = "https://api.sandbox.push.apple.com";
/** Re-mint the provider token before Apple's 60-minute cap (use 50 min). */
const TOKEN_TTL_MS = 50 * 60 * 1000;

interface ApnsConfig {
  /** PEM/p8 EC private key contents. */
  key: string;
  /** APNs auth key id (the `kid` header). */
  keyId: string;
  /** Apple developer team id (the `iss` claim). */
  teamId: string;
  /** App bundle id (the `apns-topic` header). */
  topic: string;
  /** Whether to target the production host. */
  production: boolean;
}

/** base64url with no padding, per JWT. */
function base64url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input) : input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Read APNs config from the environment, or null if not fully configured.
 * Exported for the gating check / tests.
 */
export function readApnsConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApnsConfig | null {
  const inline = env.ELIZA_APNS_KEY?.trim();
  const keyPath = env.ELIZA_APNS_KEY_PATH?.trim();
  const keyId = env.ELIZA_APNS_KEY_ID?.trim();
  const teamId = env.ELIZA_APNS_TEAM_ID?.trim();
  const topic = env.ELIZA_APNS_TOPIC?.trim();
  if (!keyId || !teamId || !topic) return null;

  let key = inline;
  if (!key && keyPath) {
    key = readFileSync(keyPath, "utf8").trim();
  }
  if (!key) return null;

  return {
    key,
    keyId,
    teamId,
    topic,
    production: env.ELIZA_APNS_PRODUCTION === "1",
  };
}

export class ApnsProvider implements PushProvider {
  readonly name = "apns";
  private readonly config: ApnsConfig | null;
  private privateKey: KeyObject | null = null;
  private cachedToken: { jwt: string; mintedAt: number } | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.config = readApnsConfig(env);
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  private requireConfig(): ApnsConfig {
    if (!this.config) {
      throw new Error("[ApnsProvider] APNs is not configured");
    }
    return this.config;
  }

  private getPrivateKey(): KeyObject {
    if (!this.privateKey) {
      this.privateKey = createPrivateKey(this.requireConfig().key);
    }
    return this.privateKey;
  }

  /**
   * Mint (or reuse) the ES256 provider token. Public + cache-bypassing so the
   * unit test can assert header/claims deterministically.
   */
  mintToken(now: number = Date.now()): string {
    const cached = this.cachedToken;
    if (cached && now - cached.mintedAt < TOKEN_TTL_MS) {
      return cached.jwt;
    }
    const { keyId, teamId } = this.requireConfig();
    const header = { alg: "ES256", kid: keyId };
    const claims = { iss: teamId, iat: Math.floor(now / 1000) };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
      JSON.stringify(claims),
    )}`;
    // ES256 requires a JOSE (P1363) signature, not DER — Node emits that with
    // `dsaEncoding: "ieee-p1363"`.
    const signature = createSign("SHA256")
      .update(signingInput)
      .sign({ key: this.getPrivateKey(), dsaEncoding: "ieee-p1363" });
    const jwt = `${signingInput}.${base64url(signature)}`;
    this.cachedToken = { jwt, mintedAt: now };
    return jwt;
  }

  /** Build the JSON payload body for one message. */
  buildPayload(message: PushMessage): string {
    const alert: { title: string; body?: string } = { title: message.title };
    if (message.body) alert.body = message.body;
    const payload: Record<string, unknown> = {
      aps: { alert, sound: "default" },
      ...(message.data ?? {}),
    };
    return JSON.stringify(payload);
  }

  async send(token: string, message: PushMessage): Promise<void> {
    const config = this.requireConfig();
    const host = config.production ? PROD_HOST : SANDBOX_HOST;
    const jwt = this.mintToken();
    const body = this.buildPayload(message);

    const { status, reason } = await this.postHttp2(host, token, jwt, body);
    if (status === 200) return;

    // 410 = the device token is no longer active; APNs also returns reason
    // "Unregistered"/"BadDeviceToken" with 400/410 for dead tokens.
    if (
      status === 410 ||
      reason === "Unregistered" ||
      reason === "BadDeviceToken"
    ) {
      throw new PushUnregisteredError(
        token,
        `[ApnsProvider] token rejected (status=${status} reason=${reason ?? "n/a"})`,
      );
    }
    throw new Error(
      `[ApnsProvider] APNs request failed (status=${status} reason=${reason ?? "n/a"})`,
    );
  }

  /** POST over HTTP/2 and resolve the status + APNs `reason` (if any). */
  private postHttp2(
    host: string,
    token: string,
    jwt: string,
    body: string,
  ): Promise<{ status: number; reason?: string }> {
    const config = this.requireConfig();
    return new Promise((resolve, reject) => {
      const client = connect(host);
      client.on("error", reject);
      const req = client.request({
        [http2Constants.HTTP2_HEADER_METHOD]: "POST",
        [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
        "apns-topic": config.topic,
        "apns-push-type": "alert",
        authorization: `bearer ${jwt}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      let status = 0;
      const chunks: Buffer[] = [];
      req.on("response", (headers) => {
        status = Number(headers[http2Constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        client.close();
        let reason: string | undefined;
        if (chunks.length > 0) {
          const parsed = parseApnsReason(
            Buffer.concat(chunks).toString("utf8"),
          );
          reason = parsed;
        }
        resolve({ status, reason });
      });
      req.on("error", (error) => {
        client.close();
        reject(error);
      });
      req.end(body);
    });
  }
}

/** Extract the APNs error `reason` from a JSON error body, if present. */
function parseApnsReason(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { reason?: unknown }).reason === "string"
    ) {
      return (parsed as { reason: string }).reason;
    }
  } catch {
    // Non-JSON body (e.g. an empty 200) carries no reason.
  }
  return undefined;
}
