const STEWARD_TOKEN_KEY = "steward_session_token";

const ELIZA_API_HOSTS: Record<string, string> = {
  "elizacloud.ai": "https://api.elizacloud.ai",
  "www.elizacloud.ai": "https://api.elizacloud.ai",
  "staging.elizacloud.ai": "https://api-staging.elizacloud.ai",
};

function viteEnv(name: string): string | undefined {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.[name];
}

function isLocalApiBase(value: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i.test(
    value,
  );
}

function configuredApiBase(): string | null {
  const raw =
    viteEnv("VITE_API_URL") ||
    viteEnv("NEXT_PUBLIC_API_URL") ||
    (typeof process !== "undefined"
      ? process.env?.NEXT_PUBLIC_API_URL
      : undefined);
  if (!raw) return null;
  const trimmed = raw.replace(/\/+$/, "");
  if (!trimmed || isLocalApiBase(trimmed)) return null;
  return trimmed;
}

function browserApiBase(): string | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname.toLowerCase();
  if (host.endsWith(".pages.dev")) return "https://api-staging.elizacloud.ai";
  return configuredApiBase() ?? ELIZA_API_HOSTS[host] ?? null;
}

function isApiPath(path: string): boolean {
  return path.startsWith("/api/") || path.startsWith("/steward/");
}

function readStewardToken(): string | null {
  try {
    return window.localStorage.getItem(STEWARD_TOKEN_KEY);
  } catch {
    return null;
  }
}

function withAuthHeaders(headers: HeadersInit | undefined): Headers {
  const nextHeaders = new Headers(headers);
  const token = readStewardToken();
  if (token && !nextHeaders.has("Authorization")) {
    nextHeaders.set("Authorization", `Bearer ${token}`);
  }
  return nextHeaders;
}

function rewriteStringInput(input: string): string {
  if (!isApiPath(input)) return input;
  const base = browserApiBase();
  return base ? `${base}${input}` : input;
}

function rewriteUrlInput(input: URL): URL | string {
  if (input.origin !== window.location.origin || !isApiPath(input.pathname)) {
    return input;
  }
  const base = browserApiBase();
  return base ? `${base}${input.pathname}${input.search}${input.hash}` : input;
}

export function installApiFetchBridge(): void {
  if (typeof window === "undefined") return;
  const globalWindow = window as Window & {
    __elizaApiFetchBridgeInstalled?: boolean;
  };
  if (globalWindow.__elizaApiFetchBridgeInstalled) return;
  globalWindow.__elizaApiFetchBridgeInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && isApiPath(input)) {
      return nativeFetch(rewriteStringInput(input), {
        ...init,
        credentials: init?.credentials ?? "include",
        headers: withAuthHeaders(init?.headers),
      });
    }

    if (input instanceof URL && isApiPath(input.pathname)) {
      return nativeFetch(rewriteUrlInput(input), {
        ...init,
        credentials: init?.credentials ?? "include",
        headers: withAuthHeaders(init?.headers),
      });
    }

    if (input instanceof Request) {
      const url = new URL(input.url, window.location.origin);
      if (url.origin === window.location.origin && isApiPath(url.pathname)) {
        const request = new Request(input, init);
        const rewritten = browserApiBase()
          ? `${browserApiBase()}${url.pathname}${url.search}${url.hash}`
          : request.url;
        return nativeFetch(new Request(rewritten, request), {
          headers: withAuthHeaders(request.headers),
          credentials: request.credentials ?? "include",
        });
      }
    }

    return nativeFetch(input, init);
  };
}
