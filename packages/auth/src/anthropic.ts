/**
 * Anthropic OAuth flow (Claude Pro/Max subscription)
 *
 * Uses inlined PKCE + token exchange (vendored OAuth helpers).
 * The callback API is adapted to a start/exchange pattern for HTTP route handlers.
 */

import type { OAuthCredentials } from "./types.ts";
import {
  loginAnthropic as loginAnthropicFlow,
  refreshAnthropicToken as refreshAnthropicTokenFlow,
} from "./vendor/pi-oauth/anthropic-login.ts";

export interface AnthropicFlow {
  authUrl: string;
  /** Provide the authorization code (format: code#state) to complete the flow */
  submitCode: (code: string) => void;
  /** Resolves with credentials once submitCode() is called */
  credentials: Promise<OAuthCredentials>;
}

/**
 * Start the Anthropic OAuth flow.
 * Returns an auth URL and a way to submit the code + get credentials.
 */
export async function startAnthropicLogin(): Promise<AnthropicFlow> {
  let authUrl = "";
  let resolveCode: ((code: string) => void) | null = null;
  let resolveUrlReady: (() => void) | null = null;
  const codePromise = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });
  const urlReady = new Promise<void>((resolve) => {
    resolveUrlReady = resolve;
  });

  const credentials = loginAnthropicFlow(
    (url: string) => {
      authUrl = url;
      resolveUrlReady?.();
    },
    () => codePromise,
  );

  await urlReady;

  return {
    authUrl,
    submitCode: (code: string) => resolveCode?.(code),
    credentials,
  };
}

/**
 * Refresh an expired Anthropic token.
 */
export async function refreshAnthropicToken(
  refreshToken: string,
): Promise<OAuthCredentials> {
  return refreshAnthropicTokenFlow(refreshToken);
}
