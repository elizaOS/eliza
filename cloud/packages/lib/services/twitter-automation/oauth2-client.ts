import { safeJsonParse } from "@/lib/utils/json-parsing";

const TWITTER_OAUTH2_TOKEN_URL = "https://api.x.com/2/oauth2/token";

export interface TwitterOAuth2TokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  token_type?: string;
}

interface TwitterOAuth2ErrorResponse {
  error?: string;
  error_description?: string;
  detail?: string;
  title?: string;
}

export type TwitterOAuth2ClientAuthMode = "public" | "confidential";

function readTwitterOAuth2ClientId(): string {
  return process.env.TWITTER_CLIENT_ID?.trim() ?? "";
}

function readTwitterOAuth2ClientSecret(): string | undefined {
  return process.env.TWITTER_CLIENT_SECRET?.trim() || undefined;
}

export function hasTwitterOAuth2ClientId(): boolean {
  return Boolean(readTwitterOAuth2ClientId());
}

export function requireTwitterOAuth2ClientId(): string {
  const clientId = readTwitterOAuth2ClientId();
  if (!clientId) {
    throw new Error("Twitter OAuth2 client ID is not configured");
  }
  return clientId;
}

export function getTwitterOAuth2ClientAuthMode(): TwitterOAuth2ClientAuthMode {
  return readTwitterOAuth2ClientSecret() ? "confidential" : "public";
}

export function parseTwitterOAuth2Scope(scope: string | undefined): string[] {
  return typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [];
}

export function normalizeTwitterOAuth2AuthorizeUrl(authUrl: string): string {
  return authUrl.replace(/([?&]code_challenge_method=)s256(?=(&|$))/i, "$1S256");
}

function getTwitterOAuth2AuthorizationHeader(clientId: string, clientSecret: string): string {
  const credentials = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

async function readTwitterOAuth2ErrorMessage(response: Response): Promise<string> {
  const payload = await safeJsonParse<TwitterOAuth2ErrorResponse>(response);
  const details = [payload.error, payload.error_description, payload.detail, payload.title].filter(
    (value, index, all): value is string => {
      return typeof value === "string" && value.trim().length > 0 && all.indexOf(value) === index;
    },
  );

  if (details.length > 0) {
    return details.join(": ");
  }

  return `Twitter OAuth2 request failed with status ${response.status}`;
}

export async function requestTwitterOAuth2Token(
  params: Record<string, string>,
): Promise<TwitterOAuth2TokenResponse> {
  const clientId = requireTwitterOAuth2ClientId();
  const clientSecret = readTwitterOAuth2ClientSecret();
  const body = new URLSearchParams(params);
  const headers: HeadersInit = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (clientSecret) {
    headers.Authorization = getTwitterOAuth2AuthorizationHeader(clientId, clientSecret);
  } else {
    body.set("client_id", clientId);
  }

  const response = await fetch(TWITTER_OAUTH2_TOKEN_URL, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    throw new Error(await readTwitterOAuth2ErrorMessage(response));
  }

  return safeJsonParse<TwitterOAuth2TokenResponse>(response);
}
