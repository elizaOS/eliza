/**
 * Anthropic OAuth (Claude Pro/Max) — authorization code + PKCE.
 * Inlined OAuth flow (MIT) — vendored to avoid a runtime dependency.
 */

import { generatePKCE } from "./pkce.js";

const decode = (s: string): string => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

export interface AnthropicOAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
}

/**
 * @param onAuthUrl - Receives the browser authorization URL
 * @param onPromptCode - Resolves with pasted code (format: code#state)
 */
export async function loginAnthropic(
  onAuthUrl: (url: string) => void,
  onPromptCode: () => Promise<string>,
): Promise<AnthropicOAuthCredentials> {
  const { verifier, challenge } = await generatePKCE();
  const authParams = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;
  onAuthUrl(authUrl);
  const authCode = await onPromptCode();
  const splits = authCode.split("#");
  const code = splits[0];
  const state = splits[1];
  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${errText}`);
  }
  const tokenData = (await tokenResponse.json()) as {
    refresh_token: string;
    access_token: string;
    expires_in: number;
  };
  const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;
  return {
    refresh: tokenData.refresh_token,
    access: tokenData.access_token,
    expires: expiresAt,
  };
}

export async function refreshAnthropicToken(
  refreshToken: string,
): Promise<AnthropicOAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic token refresh failed: ${errText}`);
  }
  const data = (await response.json()) as {
    refresh_token: string;
    access_token: string;
    expires_in: number;
  };
  return {
    refresh: data.refresh_token,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}
