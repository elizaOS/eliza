import crypto from "node:crypto";
import { logger } from "@elizaos/core";
import { createIntegrationTelemetrySpan } from "@elizaos/agent/diagnostics/integration-observability";

export interface XPosterCredentials {
  apiKey: string;
  apiSecretKey: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface XPostResult {
  ok: boolean;
  status: number | null;
  postId?: string;
  error?: string;
  category: "success" | "auth" | "rate_limit" | "network" | "unknown";
}

const X_BASE_URL =
  process.env.MILADY_MOCK_X_BASE ?? "https://api.twitter.com";
const X_POST_URL = `${X_BASE_URL}/2/tweets`;

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildSignatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>,
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join("&");

  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sorted)}`;
}

function buildSigningKey(apiSecret: string, tokenSecret: string): string {
  return `${percentEncode(apiSecret)}&${percentEncode(tokenSecret)}`;
}

function signOAuth1(baseString: string, signingKey: string): string {
  return crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
}

function buildOAuth1AuthorizationHeader(args: {
  method: string;
  url: string;
  credentials: XPosterCredentials;
  nonce: string;
  timestamp: string;
}): string {
  const { method, url, credentials, nonce, timestamp } = args;
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  const baseString = buildSignatureBaseString(method, url, oauthParams);
  const signingKey = buildSigningKey(
    credentials.apiSecretKey,
    credentials.accessTokenSecret,
  );
  oauthParams.oauth_signature = signOAuth1(baseString, signingKey);

  const header = Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
    .join(", ");

  return `OAuth ${header}`;
}

function classifyStatus(status: number): XPostResult["category"] {
  if (status >= 200 && status < 300) return "success";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  return "unknown";
}

export function readXPosterCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): XPosterCredentials | null {
  const apiKey = env.TWITTER_API_KEY?.trim();
  const apiSecretKey = env.TWITTER_API_SECRET_KEY?.trim();
  const accessToken = env.TWITTER_ACCESS_TOKEN?.trim();
  const accessTokenSecret = env.TWITTER_ACCESS_TOKEN_SECRET?.trim();

  if (!apiKey || !apiSecretKey || !accessToken || !accessTokenSecret) {
    return null;
  }

  return {
    apiKey,
    apiSecretKey,
    accessToken,
    accessTokenSecret,
  };
}

export async function postToX(args: {
  text: string;
  credentials: XPosterCredentials;
}): Promise<XPostResult> {
  const { text, credentials } = args;
  const span = createIntegrationTelemetrySpan({
    boundary: "lifeops",
    operation: "x_post",
    timeoutMs: 12_000,
  });
  const nonce = crypto.randomBytes(16).toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const authorization = buildOAuth1AuthorizationHeader({
    method: "POST",
    url: X_POST_URL,
    credentials,
    nonce,
    timestamp,
  });

  try {
    const response = await fetch(X_POST_URL, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(12_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      data?: { id?: string };
      errors?: Array<{ detail?: string; message?: string }>;
      title?: string;
      detail?: string;
    };
    const category = classifyStatus(response.status);

    if (!response.ok) {
      const errorMessage =
        payload.errors?.[0]?.detail ??
        payload.errors?.[0]?.message ??
        payload.detail ??
        payload.title ??
        `HTTP ${response.status}`;
      logger.warn(
        {
          boundary: "lifeops",
          integration: "x",
          operation: "x_post",
          statusCode: response.status,
          category,
        },
        `[lifeops] X post failed: ${errorMessage}`,
      );
      span.failure({
        statusCode: response.status,
        errorKind: category,
      });
      return {
        ok: false,
        status: response.status,
        error: errorMessage,
        category,
      };
    }

    span.success({
      statusCode: response.status,
    });
    return {
      ok: true,
      status: response.status,
      postId: payload.data?.id,
      category,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      {
        boundary: "lifeops",
        integration: "x",
        operation: "x_post",
        err: error instanceof Error ? error : undefined,
      },
      `[lifeops] X post failed: ${errorMessage}`,
    );
    span.failure({
      error,
      errorKind: "network",
    });
    return {
      ok: false,
      status: null,
      error: errorMessage,
      category: "network",
    };
  }
}

export interface XDmResult {
  ok: boolean;
  status: number | null;
  dmConversationId?: string;
  dmEventId?: string;
  error?: string;
  category: "success" | "auth" | "rate_limit" | "network" | "unknown";
}

const X_DM_URL_TEMPLATE = `${X_BASE_URL}/2/dm_conversations/with/{participantId}/messages`;

/**
 * Send a Direct Message on X (Twitter) via the v2 DM API.
 *
 * `participantId` must be the numeric Twitter user ID of the recipient
 * (not a @handle — the API requires the ID).
 *
 * Requires OAuth 1.0a access token and secret with the `dm.write` scope
 * granted for the app.
 */
export async function sendXDm(args: {
  participantId: string;
  text: string;
  credentials: XPosterCredentials;
}): Promise<XDmResult> {
  const { participantId, text, credentials } = args;
  const url = X_DM_URL_TEMPLATE.replace("{participantId}", encodeURIComponent(participantId));
  const nonce = crypto.randomBytes(16).toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const authorization = buildOAuth1AuthorizationHeader({
    method: "POST",
    url,
    credentials,
    nonce,
    timestamp,
  });

  const span = createIntegrationTelemetrySpan({
    boundary: "lifeops",
    operation: "x_dm_send",
    timeoutMs: 12_000,
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(12_000),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      data?: { dm_conversation_id?: string; dm_event_id?: string };
      errors?: Array<{ detail?: string; message?: string }>;
      title?: string;
      detail?: string;
    };

    const category = classifyStatus(response.status);

    if (!response.ok) {
      const errorMessage =
        payload.errors?.[0]?.detail ??
        payload.errors?.[0]?.message ??
        payload.detail ??
        payload.title ??
        `HTTP ${response.status}`;
      span.failure({ statusCode: response.status, errorKind: category });
      return { ok: false, status: response.status, error: errorMessage, category };
    }

    span.success({ statusCode: response.status });
    return {
      ok: true,
      status: response.status,
      dmConversationId: payload.data?.dm_conversation_id,
      dmEventId: payload.data?.dm_event_id,
      category: "success",
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    span.failure({ error, errorKind: "network" });
    return { ok: false, status: null, error: errorMessage, category: "network" };
  }
}
