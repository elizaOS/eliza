// ---------------------------------------------------------------------------
// Server URL resolution
//
// Single source of truth for the elizaos-setup Bun HTTP backend URL.
//
// Resolution order (first hit wins):
//   1. window.__ELIZA_SERVER_URL__     — injected by the Electrobun main
//                                        process before loading the renderer,
//                                        or by `server.ts` when it serves
//                                        the HTML shell directly.
//   2. import.meta.env.VITE_ELIZA_SETUP_SERVER_URL
//                                      — used by `run-dev.sh` to inform Vite
//                                        of the bound port.
//   3. http://127.0.0.1:3743           — the historical dev default. Only used
//                                        as a last resort, and only in dev
//                                        mode. In production, missing
//                                        resolution throws.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __ELIZA_SERVER_URL__?: string;
    __ELIZA_SERVER_TOKEN__?: string;
  }
}

const DEV_FALLBACK = "http://127.0.0.1:3743";

interface ImportMetaEnvLike {
  readonly VITE_ELIZA_SETUP_SERVER_URL?: string;
  readonly VITE_ELIZA_SETUP_TOKEN?: string;
  readonly PROD?: boolean;
  readonly DEV?: boolean;
}

export function getServerToken(): string {
  if (typeof window !== "undefined") {
    const injected = window.__ELIZA_SERVER_TOKEN__;
    if (isNonEmptyString(injected)) return injected;
  }
  const token = readEnv()?.VITE_ELIZA_SETUP_TOKEN;
  if (isNonEmptyString(token)) return token;
  throw new Error("[elizaos-setup] No backend authorization token configured.");
}

export function authorizedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Eliza-Setup-Token", getServerToken());
  return fetch(input, { ...init, headers });
}

/**
 * Join a backend-owned route to either a direct loopback backend base
 * (`http://127.0.0.1:<port>`) or the Vite development proxy base (`/api`).
 *
 * Callers pass the API base exactly once. This keeps packaged requests off the
 * renderer origin and prevents the historical `<backend>/api/api/...` and
 * `<backend>/api/...` mismatches caused by individual clients guessing where
 * the proxy prefix belongs.
 */
export function backendRoute(base: string, route: string): string {
  if (!isNonEmptyString(base)) {
    throw new Error("[elizaos-setup] Backend base must not be empty.");
  }
  if (!route.startsWith("/")) {
    throw new Error("[elizaos-setup] Backend route must start with '/'.");
  }
  return `${stripTrailingSlash(base)}${route}`;
}

function readEnv(): ImportMetaEnvLike | undefined {
  try {
    const meta = import.meta as { env?: ImportMetaEnvLike };
    return meta.env;
  } catch {
    return undefined;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Resolve the elizaos-setup backend URL.
 *
 * Throws in production when no source provides a URL, because the historical
 * `http://localhost:3743` fallback silently masks misconfiguration in
 * packaged Electrobun builds where the server is in-process and the renderer
 * has no way to guess the port.
 */
export function getServerUrl(): string {
  if (typeof window !== "undefined") {
    const injected = window.__ELIZA_SERVER_URL__;
    if (isNonEmptyString(injected)) return stripTrailingSlash(injected);
  }

  const env = readEnv();
  const fromEnv = env?.VITE_ELIZA_SETUP_SERVER_URL;
  if (isNonEmptyString(fromEnv)) return stripTrailingSlash(fromEnv);

  if (env?.PROD === true) {
    throw new Error(
      "[elizaos-setup] No server URL configured. The Electrobun main process " +
        "must inject window.__ELIZA_SERVER_URL__ before loading the renderer.",
    );
  }

  return DEV_FALLBACK;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
