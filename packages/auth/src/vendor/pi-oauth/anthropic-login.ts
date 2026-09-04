/**
 * Anthropic OAuth (Claude Pro/Max) — authorization code + PKCE.
 * Inlined OAuth flow (MIT) — vendored to avoid a runtime dependency.
 *
 * Anthropic's OAuth uses a fixed redirect URI on `console.anthropic.com`
 * that displays the auth code on completion — there's no loopback
 * listener. The flow surfaces an `authUrl` plus a `submitCode()` hook
 * the UI / CLI calls once the user has copied the code.
 */

import { ElizaError } from "@elizaos/core";
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

type AnthropicTokenResponseMode = "exchange" | "refresh";

interface ParsedAnthropicRefreshResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

interface ParsedAnthropicExchangeResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidTokenResponse(
  mode: AnthropicTokenResponseMode,
  reason: string,
): ElizaError {
  return new ElizaError(
    `Anthropic OAuth token response was invalid: ${reason}`,
    {
      code: "anthropic_oauth.token_invalid_shape",
      severity: "fatal",
      context: { mode, reason },
    },
  );
}

function parseAnthropicTokenResponse(
  response: Response,
  mode: "exchange",
): Promise<ParsedAnthropicExchangeResponse>;
function parseAnthropicTokenResponse(
  response: Response,
  mode: "refresh",
): Promise<ParsedAnthropicRefreshResponse>;
async function parseAnthropicTokenResponse(
  response: Response,
  mode: AnthropicTokenResponseMode,
): Promise<ParsedAnthropicRefreshResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    // error-policy:J2 context-adding rethrow — malformed provider JSON cannot
    // become a partial credential record.
    throw new ElizaError("Anthropic OAuth token response was not JSON", {
      code: "anthropic_oauth.token_invalid_json",
      severity: "fatal",
      context: { mode },
      cause,
    });
  }

  if (!isRecord(payload)) {
    throw invalidTokenResponse(mode, "response root must be an object");
  }

  const accessToken = payload.access_token;
  const refreshToken = payload.refresh_token;
  const expiresIn = payload.expires_in;
  if (!isNonBlankString(accessToken)) {
    throw invalidTokenResponse(
      mode,
      "missing access_token or invalid access_token; expected a non-blank string",
    );
  }
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw invalidTokenResponse(
      mode,
      "missing or invalid expires_in; expected a positive finite number",
    );
  }
  const expiresAt = Date.now() + expiresIn * 1000;
  if (!Number.isFinite(expiresAt)) {
    throw invalidTokenResponse(
      mode,
      "invalid expires_in; absolute expiry exceeds the supported numeric range",
    );
  }
  if (mode === "exchange" && !isNonBlankString(refreshToken)) {
    throw invalidTokenResponse(
      mode,
      "missing or invalid refresh_token; expected a non-blank string",
    );
  }
  if (
    mode === "refresh" &&
    refreshToken !== undefined &&
    refreshToken !== null &&
    !isNonBlankString(refreshToken)
  ) {
    throw invalidTokenResponse(
      mode,
      "invalid refresh_token; expected a non-blank string when present",
    );
  }

  if (isNonBlankString(refreshToken)) {
    return { accessToken, refreshToken, expiresAt };
  }
  return { accessToken, expiresAt };
}

function parseAnthropicAuthorizationInput(authCode: string): {
  code: string;
  verifier: string;
} {
  const input = authCode.trim();
  if (URL.canParse(input)) {
    const callback = new URL(input);
    if (
      callback.hostname === "localhost" ||
      callback.hostname === "127.0.0.1"
    ) {
      const code = callback.searchParams.get("code");
      const verifier = callback.searchParams.get("state");
      if (code && verifier) return { code, verifier };
    }
  }
  const [code, verifier] = input.split("#", 2);
  if (!code || !verifier) {
    throw new Error(
      "Anthropic authorization input must be code#state or a localhost callback URL",
    );
  }
  return { code, verifier };
}

export async function exchangeAnthropicAuthorizationCode(
  authCode: string,
): Promise<AnthropicOAuthCredentials> {
  const { code, verifier } = parseAnthropicAuthorizationInput(authCode);
  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state: verifier,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${errText}`);
  }
  const tokenData = await parseAnthropicTokenResponse(
    tokenResponse,
    "exchange",
  );
  return {
    refresh: tokenData.refreshToken,
    access: tokenData.accessToken,
    expires: tokenData.expiresAt,
  };
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
    const parsed = parseAnthropicAuthorizationInput(authCode);
    if (parsed.verifier !== verifier) {
      throw new Error(
        "Anthropic OAuth state mismatch: returned state does not match the request verifier",
      );
    }
    return exchangeAnthropicAuthorizationCode(authCode);
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
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic token refresh failed: ${errText}`);
  }
  const data = await parseAnthropicTokenResponse(response, "refresh");
  return {
    // Anthropic rotates refresh tokens (one-time-use). Per RFC 6749 §6 a
    // response that omits refresh_token means "keep the current one". Treat a
    // null optional value equivalently and never replace a valid stored token.
    refresh: data.refreshToken ?? refreshToken,
    access: data.accessToken,
    expires: data.expiresAt,
  };
}
