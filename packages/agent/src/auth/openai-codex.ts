/**
 * OpenAI Codex (ChatGPT Plus/Pro subscription) OAuth flow
 *
 * Wraps @mariozechner/pi-ai's loginOpenAICodex for server-side use.
 * Handles local callback server + manual code paste fallback.
 */

import {
  refreshOpenAICodexToken as _refreshOpenAICodexToken,
  loginOpenAICodex,
} from "@mariozechner/pi-ai";
import type { OAuthCredentials } from "./types";

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
          // Extract state from URL
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
        onPrompt: async () => {
          // This is called when the callback server times out
          // Wait for manual code submission
          return manualPromise;
        },
        onManualCodeInput: () => manualPromise,
        onProgress: () => {},
        originator: "eliza",
      });
      // Prevent unhandled rejections even if no one awaits this promise.
      void credentials.catch(() => {});
    } catch (err) {
      rejectFlow(err);
      return;
    }

    // Capture close from the finally block — pi-ai closes server internally
    // We just need to cancel the manual wait if needed
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
  return _refreshOpenAICodexToken(refreshToken);
}
