/**
 * FcmProvider — Firebase Cloud Messaging HTTP v1 sender.
 *
 * Auth follows Google's service-account OAuth2 flow: build an RS256 JWT
 * "assertion" signed with the service account's private key (claims
 * `{ iss: client_email, scope: firebase.messaging, aud: token endpoint, iat,
 * exp }`), exchange it at `https://oauth2.googleapis.com/token` for a bearer
 * access token (cached until it nears expiry), then POST the message to
 * `https://fcm.googleapis.com/v1/projects/<projectId>/messages:send`.
 *
 * VERIFIABILITY: the OAuth assertion JWT minting (`buildAssertion`) and message
 * shaping (`buildMessageBody`) are pure and unit-tested with a throwaway RSA
 * key + a synthetic service account. The token exchange and the actual send hit
 * Google's servers and are NOT exercised in tests — they require a real Firebase
 * service account and a real device token.
 */

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type PushMessage,
  type PushProvider,
  PushUnregisteredError,
} from "./push-types.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const ASSERTION_TTL_S = 3600;
/** Refresh the access token slightly before it expires (60s skew). */
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

/** base64url with no padding, per JWT. */
function base64url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input) : input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Parse + validate a service-account JSON blob. */
function parseServiceAccount(raw: string): ServiceAccount | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const sa = parsed as Record<string, unknown>;
  if (
    typeof sa.client_email === "string" &&
    sa.client_email.length > 0 &&
    typeof sa.private_key === "string" &&
    sa.private_key.length > 0 &&
    typeof sa.project_id === "string" &&
    sa.project_id.length > 0
  ) {
    return {
      client_email: sa.client_email,
      private_key: sa.private_key,
      project_id: sa.project_id,
    };
  }
  return null;
}

/**
 * Read + validate the FCM service account from the environment, or null.
 * Exported for the gating check / tests.
 */
export function readServiceAccount(
  env: NodeJS.ProcessEnv = process.env,
): ServiceAccount | null {
  const inline = env.ELIZA_FCM_SERVICE_ACCOUNT?.trim();
  const path = env.ELIZA_FCM_SERVICE_ACCOUNT_PATH?.trim();
  let raw = inline;
  if (!raw && path) {
    raw = readFileSync(path, "utf8").trim();
  }
  if (!raw) return null;
  return parseServiceAccount(raw);
}

export class FcmProvider implements PushProvider {
  readonly name = "fcm";
  private readonly account: ServiceAccount | null;
  private privateKey: KeyObject | null = null;
  private cachedToken: { accessToken: string; expiresAt: number } | null = null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.account = readServiceAccount(env);
  }

  isConfigured(): boolean {
    return this.account !== null;
  }

  private requireAccount(): ServiceAccount {
    if (!this.account) {
      throw new Error("[FcmProvider] FCM is not configured");
    }
    return this.account;
  }

  private getPrivateKey(): KeyObject {
    if (!this.privateKey) {
      this.privateKey = createPrivateKey(this.requireAccount().private_key);
    }
    return this.privateKey;
  }

  /**
   * Build the RS256 OAuth2 assertion JWT. Public + deterministic so the unit
   * test can assert the header/claims.
   */
  buildAssertion(now: number = Date.now()): string {
    const { client_email } = this.requireAccount();
    const iat = Math.floor(now / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: client_email,
      scope: FCM_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat,
      exp: iat + ASSERTION_TTL_S,
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
      JSON.stringify(claims),
    )}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(this.getPrivateKey());
    return `${signingInput}.${base64url(signature)}`;
  }

  /** Build the FCM v1 message body. `data` is coerced to string→string. */
  buildMessageBody(token: string, message: PushMessage): string {
    const notification: { title: string; body?: string } = {
      title: message.title,
    };
    if (message.body) notification.body = message.body;
    const body: {
      message: {
        token: string;
        notification: { title: string; body?: string };
        data?: Record<string, string>;
      };
    } = { message: { token, notification } };
    if (message.data) {
      const data: Record<string, string> = {};
      for (const [key, value] of Object.entries(message.data)) {
        data[key] = typeof value === "string" ? value : JSON.stringify(value);
      }
      body.message.data = data;
    }
    return JSON.stringify(body);
  }

  /** Exchange the assertion for a cached bearer access token. */
  private async getAccessToken(): Promise<string> {
    const cached = this.cachedToken;
    if (cached && Date.now() < cached.expiresAt - TOKEN_EXPIRY_SKEW_MS) {
      return cached.accessToken;
    }
    const assertion = this.buildAssertion();
    const params = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!res.ok) {
      throw new Error(
        `[FcmProvider] OAuth token exchange failed (status=${res.status})`,
      );
    }
    const json = (await res.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof json.access_token !== "string") {
      throw new Error("[FcmProvider] OAuth response missing access_token");
    }
    const expiresInS =
      typeof json.expires_in === "number" ? json.expires_in : ASSERTION_TTL_S;
    this.cachedToken = {
      accessToken: json.access_token,
      expiresAt: Date.now() + expiresInS * 1000,
    };
    return json.access_token;
  }

  async send(token: string, message: PushMessage): Promise<void> {
    const { project_id } = this.requireAccount();
    const accessToken = await this.getAccessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${project_id}/messages:send`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: this.buildMessageBody(token, message),
    });
    if (res.ok) return;

    // 404 + UNREGISTERED (and NOT_FOUND / INVALID_ARGUMENT for a bad token)
    // mean the registration token is dead — surface it so the caller drops it.
    const errorCode = await readFcmErrorCode(res);
    if (
      res.status === 404 ||
      errorCode === "UNREGISTERED" ||
      errorCode === "NOT_FOUND"
    ) {
      throw new PushUnregisteredError(
        token,
        `[FcmProvider] token rejected (status=${res.status} code=${errorCode ?? "n/a"})`,
      );
    }
    throw new Error(
      `[FcmProvider] FCM send failed (status=${res.status} code=${errorCode ?? "n/a"})`,
    );
  }
}

/** Pull the FCM v1 error status code out of an error response, if present. */
async function readFcmErrorCode(res: Response): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}
