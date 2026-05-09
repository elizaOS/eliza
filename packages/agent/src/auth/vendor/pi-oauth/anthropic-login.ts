/**
 * Anthropic OAuth (Claude Pro/Max) — authorization code + PKCE.
 * Inlined OAuth flow (MIT) — vendored to avoid a runtime dependency.
 *
 * Anthropic's OAuth uses a fixed redirect URI on `console.anthropic.com`
 * that displays the auth code on completion — there's no loopback
 * listener. The flow surfaces an `authUrl` plus a `submitCode()` hook
 * the UI / CLI calls once the user has copied the code.
 */

import { generatePKCE } from "./pkce.ts";

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
 * Programmatic Anthropic OAuth flow.
 *
 * `authUrl` is ready immediately. The caller MUST eventually call
 * either `submitCode(code)` (after the user has pasted the
 * `code#state` blob from the redirect page) or `cancel()`. The
 * `completion` promise rejects if the flow is cancelled.
 */
export interface AnthropicOAuthFlowHandle {
  authUrl: string;
  /** Pass `code#state` from the redirect page. */
  submitCode: (code: string) => void;
  /** Resolves with credentials once `submitCode` lands and the token exchange succeeds. */
  completion: Promise<AnthropicOAuthCredentials>;
  cancel: (reason?: string) => void;
}

/**
 * Start an Anthropic OAuth flow. Returns immediately with the auth
 * URL and a `submitCode` hook. The token exchange happens inside
 * `completion` once the caller submits the code.
 */
export async function startAnthropicOAuthFlowRaw(): Promise<AnthropicOAuthFlowHandle> {
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

  let resolveCode: ((value: string) => void) | null = null;
  let rejectCode: ((err: Error) => void) | null = null;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const completion = (async (): Promise<AnthropicOAuthCredentials> => {
    const authCode = await codePromise;
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
  })();

  return {
    authUrl,
    submitCode: (code: string) => resolveCode?.(code),
    completion,
    cancel: (reason = "Cancelled") => rejectCode?.(new Error(reason)),
  };
}

/**
 * @param onAuthUrl - Receives the browser authorization URL
 * @param onPromptCode - Resolves with pasted code (format: code#state)
 *
 * Thin compatibility wrapper around `startAnthropicOAuthFlowRaw` for
 * the CLI entrypoint and any older callers. New code should use
 * `startAnthropicOAuthFlowRaw` (or the higher-level
 * `startAnthropicOAuthFlow` in `auth/oauth-flow.ts`) directly.
 */
export async function loginAnthropic(
  onAuthUrl: (url: string) => void,
  onPromptCode: () => Promise<string>,
): Promise<AnthropicOAuthCredentials> {
  const handle = await startAnthropicOAuthFlowRaw();
  onAuthUrl(handle.authUrl);
  const code = await onPromptCode();
  handle.submitCode(code);
  return handle.completion;
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
