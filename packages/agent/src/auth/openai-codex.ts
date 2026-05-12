/**
 * OpenAI Codex (ChatGPT Plus/Pro subscription) OAuth flow
 *
 * Uses inlined OAuth (vendored helpers).
 * Handles local callback server + manual code paste fallback.
 */

import { logger } from "@elizaos/core";
import type { OAuthCredentials } from "./types.ts";
import {
  loginOpenAICodex,
  refreshOpenAICodexToken,
} from "./vendor/pi-oauth/openai-codex-login.ts";

export interface CodexFlow {
  authUrl: string;
  state: string;
  /** Submit a manually-pasted code/URL */
  submitCode: (code: string) => void;
  /** Wait for credentials (either via callback server or manual code) */
  credentials: Promise<OAuthCredentials>;
  /** Close the callback server */
  close: () => void;
}

/**
 * Start the OpenAI Codex OAuth flow.
 * Starts a local callback server on port 1455 and returns the auth URL.
 */
export function startCodexLogin(): Promise<CodexFlow> {
  return new Promise<CodexFlow>((resolveFlow, rejectFlow) => {
    let authUrl = "";
    let flowState = "";
    let resolveManual: ((code: string) => void) | null = null;
    let closeServer: (() => void) | null = null;
    let credentials: Promise<OAuthCredentials>;

    const manualPromise = new Promise<string>((resolve) => {
      resolveManual = resolve;
    });

    try {
      credentials = loginOpenAICodex({
        onAuth: ({ url }: { url: string }) => {
          authUrl = url;
          try {
            const parsed = new URL(url);
            flowState = parsed.searchParams.get("state") || "";
          } catch {
            /* */
          }

          resolveFlow({
            get authUrl() {
              return authUrl;
            },
            state: flowState,
            submitCode: (code: string) => resolveManual?.(code),
            credentials,
            close: () => closeServer?.(),
          });
        },
        onPrompt: async () => manualPromise,
        onManualCodeInput: () => manualPromise,
        onProgress: () => {},
        originator: "eliza",
      }).then((creds) => ({
        access: creds.access,
        refresh: creds.refresh,
        expires: creds.expires,
      }));
      void credentials.catch((err) => {
        logger.warn(`[auth] OpenAI Codex credential flow failed: ${err}`);
      });
    } catch (err) {
      rejectFlow(err);
      return;
    }

    closeServer = () => {
      resolveManual?.("");
    };
  });
}

/**
 * Refresh an expired OpenAI Codex token.
 */
export async function refreshCodexToken(
  refreshToken: string,
): Promise<OAuthCredentials> {
  const refreshed = await refreshOpenAICodexToken(refreshToken);
  return {
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
  };
}
