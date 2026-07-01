import { client } from "@elizaos/ui/api";

type EmbedPlatform = "telegram" | "discord";

interface TelegramWebAppLike {
  initData?: string;
  ready?: () => void;
}

interface EmbedWindow extends Window {
  Telegram?: {
    WebApp?: TelegramWebAppLike;
  };
}

export type EmbedBootstrapStatus =
  | "skipped"
  | "authenticated"
  | "missing-payload"
  | "auth-failed"
  | "no-token";

export interface EmbedBootstrapResult {
  status: EmbedBootstrapStatus;
  platform?: EmbedPlatform;
  statusCode?: number;
  error?: string;
}

interface EmbedBootstrapDeps {
  fetch: typeof fetch;
  location: Location;
  history?: Pick<History, "replaceState">;
  applyToken: (token: string) => void;
  markReady?: (platform: EmbedPlatform) => void;
}

interface EmbedAuthResponse {
  token?: unknown;
  expiresAt?: unknown;
}

const EMBED_AUTH_PATH = "/api/embed/auth";

function isEmbedPath(pathname: string): boolean {
  return pathname === "/embed" || pathname.startsWith("/embed/");
}

function normalizePlatform(value: string | null): EmbedPlatform | null {
  return value === "telegram" || value === "discord" ? value : null;
}

function telegramLaunchPayload(win: EmbedWindow): string | null {
  const initData = win.Telegram?.WebApp?.initData;
  return typeof initData === "string" && initData.trim()
    ? initData.trim()
    : null;
}

function resolveSignedLaunchPayload(
  platform: EmbedPlatform,
  params: URLSearchParams,
  win: EmbedWindow,
): string | null {
  const explicit = params.get("signedLaunchPayload");
  if (explicit?.trim()) return explicit.trim();
  if (platform === "telegram") return telegramLaunchPayload(win);
  const code = params.get("code");
  return code?.trim() || null;
}

function cleanupSensitiveParams(
  location: Location,
  history: Pick<History, "replaceState"> | undefined,
): void {
  if (!history) return;
  const url = new URL(location.href);
  let changed = false;
  for (const key of ["code", "signedLaunchPayload"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) {
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
}

export async function bootstrapEmbedLaunch(
  deps?: Partial<EmbedBootstrapDeps>,
): Promise<EmbedBootstrapResult> {
  if (typeof window === "undefined") return { status: "skipped" };
  const win = window as EmbedWindow;
  const location = deps?.location ?? window.location;
  if (!isEmbedPath(location.pathname)) return { status: "skipped" };

  const params = new URLSearchParams(location.search);
  const platform = normalizePlatform(params.get("platform"));
  if (!platform) {
    return { status: "missing-payload", error: "missing_embed_platform" };
  }

  const signedLaunchPayload = resolveSignedLaunchPayload(platform, params, win);
  if (!signedLaunchPayload) {
    return { status: "missing-payload", platform };
  }

  const fetchImpl = deps?.fetch ?? window.fetch.bind(window);
  const applyToken =
    deps?.applyToken ?? ((token: string) => client.setToken(token));
  let response: Response;
  try {
    response = await fetchImpl(EMBED_AUTH_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, signedLaunchPayload }),
    });
  } catch (err) {
    return {
      status: "auth-failed",
      platform,
      error: err instanceof Error ? err.message : "embed_auth_network_error",
    };
  }

  if (!response.ok) {
    return {
      status: "auth-failed",
      platform,
      statusCode: response.status,
    };
  }

  const body = (await response
    .json()
    .catch(() => null)) as EmbedAuthResponse | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) {
    return { status: "no-token", platform };
  }

  applyToken(token);
  cleanupSensitiveParams(location, deps?.history ?? window.history);
  deps?.markReady?.(platform);
  win.Telegram?.WebApp?.ready?.();
  return { status: "authenticated", platform };
}
