/**
 * Embedded-app launch bootstrap (#9947).
 *
 * When the SPA is served at `/embed` inside a Telegram Mini App or Discord
 * Activity iframe, the first-party Steward session cookie does not cross into
 * the third-party origin, so the app cannot authenticate the normal way. This
 * runs the client half of the embed-launch handshake before the app mounts:
 *
 *   1. Read the platform's signed launch payload (Telegram `initData` from the
 *      WebApp SDK; the Discord Activity OAuth2 `code` from the query string).
 *   2. POST it to the agent's `POST /api/embed/auth`, which verifies it
 *      server-side (`verifyEmbedLaunch`) and mints a scoped session token for
 *      the verified OWNER/ADMIN principal.
 *   3. Install that token on the ElizaClient (`client.setToken`) so every
 *      subsequent agent API call carries it as a bearer — the credential the
 *      auth boundary now accepts (see app-core embed-session-token wiring).
 *
 * The handshake is dependency-injected (window / fetch / client) so it is unit
 * testable without the iframe runtime or the ElizaClient singleton. It never
 * throws: a failure returns a `failed` outcome and the app still mounts (in its
 * unauthenticated state) rather than white-screening.
 */

export type EmbedPlatform = "telegram" | "discord";

export type EmbedAuthOutcome =
  | { status: "not-embed" }
  | { status: "authenticated"; role: string; adminMode: boolean }
  | { status: "failed"; reason: string };

/** The subset of the ElizaClient this bootstrap needs. */
export interface EmbedClient {
  getBaseUrl(): string;
  setToken(token: string | null): void;
}

interface TelegramWebApp {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
}

interface EmbedHandshakeDeps {
  win?: Window;
  fetchImpl?: typeof fetch;
  client?: EmbedClient;
}

export function isEmbedPath(pathname: string): boolean {
  return pathname === "/embed" || pathname.startsWith("/embed/");
}

function telegramInitData(win: Window): string | null {
  const telegram = (win as Window & { Telegram?: { WebApp?: TelegramWebApp } })
    .Telegram?.WebApp;
  // The Mini App SDK wants `ready()` called once the app is prepared to be
  // shown; it is also what makes `initData` reliably available.
  telegram?.ready?.();
  const initData = telegram?.initData?.trim();
  return initData ? initData : null;
}

/**
 * Detect the launch platform. The connector launch surfaces link to a bare
 * `/embed` URL (no `?platform=`), so infer it from the runtime signals:
 * a Telegram Mini App injects `Telegram.WebApp.initData`; a Discord Activity
 * OAuth redirect lands with a `?code`. An explicit `?platform=` overrides both
 * (useful for testing / non-standard launchers).
 */
function detectPlatform(
  params: URLSearchParams,
  win: Window,
): EmbedPlatform | null {
  const explicit = params.get("platform");
  if (explicit === "telegram" || explicit === "discord") return explicit;
  if (telegramInitData(win)) return "telegram";
  if (params.get("code")?.trim()) return "discord";
  return null;
}

function readLaunchPayload(
  platform: EmbedPlatform,
  params: URLSearchParams,
  win: Window,
): string | null {
  if (platform === "telegram") {
    return telegramInitData(win);
  }
  // Discord Activity: the Embedded App SDK's `commands.authorize()` returns an
  // OAuth2 `code` the launch link carries through as a query param.
  const code = params.get("code")?.trim();
  return code ? code : null;
}

/**
 * Run the embed-launch handshake if the current location is the `/embed` route.
 * Returns `{ status: "not-embed" }` (a no-op) otherwise so callers can invoke it
 * unconditionally at boot.
 */
export async function runEmbedHandshake(
  deps: EmbedHandshakeDeps = {},
): Promise<EmbedAuthOutcome> {
  const win = deps.win ?? window;
  if (!isEmbedPath(win.location.pathname)) {
    return { status: "not-embed" };
  }

  const params = new URLSearchParams(win.location.search);
  const platform = detectPlatform(params, win);
  if (!platform) {
    return { status: "failed", reason: "unknown_platform" };
  }

  const signedLaunchPayload = readLaunchPayload(platform, params, win);
  if (!signedLaunchPayload) {
    return { status: "failed", reason: "missing_launch_payload" };
  }

  const embedClient = deps.client;
  if (!embedClient) {
    return { status: "failed", reason: "client_unavailable" };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const accountId = params.get("accountId") ?? undefined;
  const base = embedClient.getBaseUrl().replace(/\/+$/, "");

  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/embed/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, signedLaunchPayload, accountId }),
    });
  } catch {
    return { status: "failed", reason: "network_error" };
  }

  if (!response.ok) {
    return { status: "failed", reason: `http_${response.status}` };
  }

  let body: { token?: unknown; role?: unknown; adminMode?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { status: "failed", reason: "bad_response" };
  }

  if (typeof body.token !== "string" || body.token.length === 0) {
    return { status: "failed", reason: "no_token" };
  }

  embedClient.setToken(body.token);
  return {
    status: "authenticated",
    role: typeof body.role === "string" ? body.role : "ADMIN",
    adminMode: body.adminMode === true,
  };
}
