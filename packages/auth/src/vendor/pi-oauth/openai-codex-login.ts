/**
 * OpenAI Codex (ChatGPT OAuth) — local callback on :1455 + PKCE.
 * Inlined OAuth flow (MIT) — vendored to avoid a runtime dependency.
 */

import { logger } from "@elizaos/core";
import { generatePKCE } from "./pkce.ts";

function isNodeLikeRuntime(): boolean {
  return (
    typeof process !== "undefined" &&
    Boolean(process.versions.node || process.versions.bun)
  );
}

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authentication successful</title>
</head>
<body>
  <p>Authentication successful. Return to your terminal to continue.</p>
</body>
</html>`;

export interface OpenAiCodexOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
  /** ChatGPT id_token, required in `~/.codex/auth.json` for chatgpt-mode auth. */
  idToken?: string;
}

export interface OAuthPrompt {
  message: string;
  placeholder?: string;
}

async function createState(): Promise<string> {
  if (!isNodeLikeRuntime()) {
    throw new Error(
      "OpenAI Codex OAuth is only available in Node.js environments",
    );
  }
  const { randomBytes } = await import("node:crypto");
  return randomBytes(16).toString("hex");
}

function parseAuthorizationInput(input: string): {
  code?: string;
  state?: string;
} {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // error-policy:J3 manual authorization input is untrusted and may be a raw
    // code rather than a URL; parsing continues through the explicit formats.
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

function decodeJwt(
  token: string,
): Record<string, Record<string, string> | undefined> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] ?? "";
    const decoded = atob(payload);
    return JSON.parse(decoded) as Record<
      string,
      Record<string, string> | undefined
    >;
  } catch {
    // error-policy:J3 JWT payloads are untrusted; null is the explicit invalid
    // claim signal consumed by account-id extraction.
    return null;
  }
}

type TokenSuccess = {
  type: "success";
  access: string;
  refresh: string;
  expires: number;
  /** ChatGPT id_token — required in `~/.codex/auth.json` for chatgpt-mode
   * auth, so it must be captured (not just access/refresh) for a pooled
   * account's CODEX_HOME to authenticate. */
  idToken?: string;
};
type TokenFailure = { type: "failed"; reason: string };
type TokenResult = TokenSuccess | TokenFailure;

type TokenResponseContext =
  | { mode: "exchange" }
  | { mode: "refresh"; currentRefreshToken: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function failedTokenResponse(reason: string): TokenFailure {
  return { type: "failed", reason };
}

function parseTokenResponse(
  payload: unknown,
  context: TokenResponseContext,
): TokenResult {
  if (!isRecord(payload)) {
    return failedTokenResponse("response root must be an object");
  }

  const rawAccessToken = payload.access_token;
  const rawRefreshToken = payload.refresh_token;
  const rawExpiresIn = payload.expires_in;
  const rawIdToken = payload.id_token;

  if (!isNonBlankString(rawAccessToken)) {
    return failedTokenResponse(
      "missing or invalid access_token; expected a non-blank string",
    );
  }
  if (
    typeof rawExpiresIn !== "number" ||
    !Number.isFinite(rawExpiresIn) ||
    rawExpiresIn <= 0
  ) {
    return failedTokenResponse(
      "missing or invalid expires_in; expected a positive finite number",
    );
  }

  const expires = Date.now() + rawExpiresIn * 1000;
  if (!Number.isFinite(expires)) {
    return failedTokenResponse(
      "invalid expires_in; absolute expiry exceeds the supported numeric range",
    );
  }

  let refresh: string;
  if (context.mode === "exchange") {
    if (!isNonBlankString(rawRefreshToken)) {
      return failedTokenResponse(
        "missing or invalid refresh_token; expected a non-blank string",
      );
    }
    refresh = rawRefreshToken;
  } else if (rawRefreshToken === undefined || rawRefreshToken === null) {
    refresh = context.currentRefreshToken;
  } else if (!isNonBlankString(rawRefreshToken)) {
    return failedTokenResponse(
      "invalid refresh_token; expected a non-blank string when present",
    );
  } else {
    refresh = rawRefreshToken;
  }

  let idToken: string | undefined;
  if (rawIdToken !== undefined && rawIdToken !== null) {
    if (typeof rawIdToken !== "string") {
      return failedTokenResponse(
        "invalid id_token; expected a string when present",
      );
    }
    idToken = rawIdToken || undefined;
  }

  return {
    type: "success",
    access: rawAccessToken,
    refresh,
    expires,
    ...(idToken ? { idToken } : {}),
  };
}

async function readTokenResponse(
  response: Response,
  context: TokenResponseContext,
): Promise<TokenResult> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // error-policy:J3 provider JSON is untrusted; malformed JSON becomes an
    // explicit failed result and no partial credential record is constructed.
    const failure = failedTokenResponse("response body was not valid JSON");
    logger.error(
      { mode: context.mode, reason: failure.reason },
      "[openai-codex] Token response invalid",
    );
    return failure;
  }

  const result = parseTokenResponse(payload, context);
  if (result.type === "failed") {
    logger.error(
      { mode: context.mode, reason: result.reason },
      "[openai-codex] Token response invalid",
    );
  }
  return result;
}

export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string = REDIRECT_URI,
): Promise<TokenSuccess | TokenFailure> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    logger.error(
      { mode: "exchange", status: response.status },
      "[openai-codex] Token request returned a non-success status",
    );
    return failedTokenResponse("provider returned a non-success status");
  }
  return readTokenResponse(response, { mode: "exchange" });
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenSuccess | TokenFailure> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!response.ok) {
      logger.error(
        { mode: "refresh", status: response.status },
        "[openai-codex] Token request returned a non-success status",
      );
      return failedTokenResponse("provider returned a non-success status");
    }
    return readTokenResponse(response, {
      mode: "refresh",
      currentRefreshToken: refreshToken,
    });
  } catch (error) {
    // error-policy:J1 provider boundary translation — refresh transport and
    // parse failures become the explicit failed token outcome.
    logger.error(`[openai-codex] Token refresh error: ${String(error)}`);
    return failedTokenResponse("token refresh request failed");
  }
}

async function createAuthorizationFlow(originator = "pi"): Promise<{
  verifier: string;
  state: string;
  url: string;
}> {
  const { verifier, challenge } = await generatePKCE();
  const state = await createState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return { verifier, state, url: url.toString() };
}

type OAuthServerInfo = {
  close: () => void;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
};

async function startLocalOAuthServer(
  state: string,
): Promise<OAuthServerInfo> {
  if (!isNodeLikeRuntime()) {
    throw new Error(
      "OpenAI Codex OAuth is only available in Node.js environments",
    );
  }
  const http = await import("node:http");

  let lastCode: string | null = null;
  let cancelled = false;
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.end("Missing authorization code");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      lastCode = code;
    } catch {
      // error-policy:J1 HTTP callback boundary translation — malformed callback
      // requests receive a structured 500 and never escape the server handler.
      res.statusCode = 500;
      res.end("Internal error");
    }
  });

  return new Promise((resolve) => {
    server
      .listen(1455, "127.0.0.1", () => {
        resolve({
          close: () => server.close(),
          cancelWait: () => {
            cancelled = true;
          },
          waitForCode: async () => {
            const sleep = () => new Promise<void>((r) => setTimeout(r, 100));
            for (let i = 0; i < 600; i += 1) {
              if (lastCode) return { code: lastCode };
              if (cancelled) return null;
              await sleep();
            }
            return null;
          },
        });
      })
      .on("error", (err: NodeJS.ErrnoException) => {
        logger.error(
          `[openai-codex] Failed to bind http://127.0.0.1:1455 (${err.code}) Falling back to manual paste.`,
        );
        resolve({
          close: () => {
            try {
              server.close();
            } catch {
              // error-policy:J6 best-effort teardown — bind already failed and
              // manual-paste fallback is active.
            }
          },
          cancelWait: () => {},
          waitForCode: async () => null,
        });
      });
  });
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0
    ? accountId
    : null;
}

export async function loginOpenAICodex(options: {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  originator?: string;
}): Promise<OpenAiCodexOAuthCredentials> {
  const { verifier, state, url } = await createAuthorizationFlow(
    options.originator,
  );
  const server = await startLocalOAuthServer(state);
  options.onAuth({
    url,
    instructions: "A browser window should open. Complete login to finish.",
  });

  let code: string | undefined;
  try {
    if (options.onManualCodeInput) {
      let manualCode: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = options
        .onManualCodeInput()
        .then((input) => {
          manualCode = input;
          server.cancelWait();
        })
        .catch((err) => {
          // error-policy:J5 the error is observed after `waitForCode`; this
          // branch cancels the competing callback wait and preserves the cause.
          manualError = err instanceof Error ? err : new Error(String(err));
          server.cancelWait();
        });

      const result = await server.waitForCode();
      if (manualError) throw manualError;
      if (result?.code) {
        code = result.code;
      } else if (manualCode) {
        const parsed = parseAuthorizationInput(manualCode);
        if (parsed.state && parsed.state !== state) {
          throw new Error("State mismatch");
        }
        code = parsed.code;
      }
      if (!code) {
        await manualPromise;
        if (manualError) throw manualError;
        if (manualCode) {
          const parsed = parseAuthorizationInput(manualCode);
          if (parsed.state && parsed.state !== state) {
            throw new Error("State mismatch");
          }
          code = parsed.code;
        }
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) code = result.code;
    }

    if (!code) {
      const input = await options.onPrompt({
        message: "Paste the authorization code (or full redirect URL):",
      });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error("State mismatch");
      }
      code = parsed.code;
    }

    if (!code) throw new Error("Missing authorization code");

    const tokenResult = await exchangeAuthorizationCode(code, verifier);
    if (tokenResult.type !== "success") {
      throw new Error("Token exchange failed");
    }
    const accountId = getAccountId(tokenResult.access);
    if (!accountId) {
      throw new Error("Failed to extract accountId from token");
    }
    return {
      access: tokenResult.access,
      refresh: tokenResult.refresh,
      expires: tokenResult.expires,
      accountId,
      ...(tokenResult.idToken ? { idToken: tokenResult.idToken } : {}),
    };
  } finally {
    server.close();
  }
}

export async function refreshOpenAICodexToken(
  refreshToken: string,
): Promise<OpenAiCodexOAuthCredentials> {
  const result = await refreshAccessToken(refreshToken);
  if (result.type !== "success") {
    throw new Error("Failed to refresh OpenAI Codex token");
  }
  const accountId = getAccountId(result.access);
  if (!accountId) {
    throw new Error("Failed to extract accountId from token");
  }
  return {
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    accountId,
    ...(result.idToken ? { idToken: result.idToken } : {}),
  };
}
