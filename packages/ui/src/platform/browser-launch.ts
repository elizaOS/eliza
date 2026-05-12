import { client } from "../api";
import {
  createPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";

function getSearchParams(): URLSearchParams {
  if (typeof window === "undefined") {
    return new URLSearchParams();
  }

  return new URLSearchParams(
    window.location.search || window.location.hash.split("?")[1] || "",
  );
}

function isAllowedHttpHost(host: string): boolean {
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net") ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1"
  );
}

function normalizeLaunchApiBase(apiBase: string): string {
  const trimmed = apiBase.trim();
  if (!trimmed) {
    throw new Error("Missing launch API base");
  }

  const stripTrailingSlashes = (s: string): string => {
    let end = s.length;
    while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
    return s.slice(0, end);
  };
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && isAllowedHttpHost(parsed.hostname))
    ) {
      return stripTrailingSlashes(parsed.toString());
    }
    throw new Error(`Rejected launch apiBase protocol: ${parsed.protocol}`);
  } catch {
    if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
      return stripTrailingSlashes(trimmed) || "/";
    }
    throw new Error("Rejected invalid launch apiBase");
  }
}

function normalizeLaunchBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && !isAllowedHttpHost(parsed.hostname)) {
    throw new Error("Rejected invalid cloud launch base");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function stripLaunchParams(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const key of [
    "apiBase",
    "token",
    "cloudLaunchSession",
    "cloudLaunchBase",
  ]) {
    url.searchParams.delete(key);
  }
  window.history.replaceState({}, "", url.toString());
}

async function exchangeCloudLaunchSession(
  cloudBaseUrl: string,
  sessionId: string,
): Promise<{ apiBase: string; token: string }> {
  const sessionPath = encodeURIComponent(sessionId);
  const launchSessionUrls = [
    `${cloudBaseUrl}/api/v1/eliza/launch-sessions/${sessionPath}`,
    `${cloudBaseUrl}/api/v1/app/launch-sessions/${sessionPath}`,
  ];

  let lastError: Error | null = null;

  for (const url of launchSessionUrls) {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      lastError = new Error(
        payload.error ||
          `Launch session exchange failed (HTTP ${response.status})`,
      );

      if (response.status === 404) {
        continue;
      }
      throw lastError;
    }

    const payload = (await response.json()) as {
      success?: boolean;
      data?: {
        connection?: { apiBase?: string; token?: string };
      };
      error?: string;
    };

    if (!payload.success || !payload.data?.connection?.apiBase) {
      throw new Error(payload.error || "Launch session payload is invalid");
    }

    const token = payload.data.connection.token?.trim();
    if (!token) {
      throw new Error("Launch session did not include an access token");
    }

    return {
      apiBase: normalizeLaunchApiBase(payload.data.connection.apiBase),
      token,
    };
  }

  throw lastError ?? new Error("Launch session exchange failed");
}

export function applyLaunchConnection(args: {
  apiBase: string;
  token?: string | null;
  kind?: "cloud" | "remote";
}): { apiBase: string; token: string | null } {
  const normalizedApiBase = normalizeLaunchApiBase(args.apiBase);
  const token = args.token?.trim() || null;

  client.setBaseUrl(normalizedApiBase);
  client.setToken(token);
  savePersistedActiveServer(
    createPersistedActiveServer({
      kind: args.kind ?? "remote",
      apiBase: normalizedApiBase,
      ...(token ? { accessToken: token } : {}),
    }),
  );

  return { apiBase: normalizedApiBase, token };
}

export async function applyLaunchConnectionFromUrl(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  const params = getSearchParams();
  const launchSession = params.get("cloudLaunchSession")?.trim();
  const launchBase = params.get("cloudLaunchBase")?.trim();

  if (launchSession && launchBase) {
    const connection = await exchangeCloudLaunchSession(
      normalizeLaunchBaseUrl(launchBase),
      launchSession,
    );
    applyLaunchConnection({
      kind: "cloud",
      apiBase: connection.apiBase,
      token: connection.token,
    });
    stripLaunchParams();
    return true;
  }

  const apiBase = params.get("apiBase")?.trim();
  if (!apiBase) {
    return false;
  }

  applyLaunchConnection({
    kind: "remote",
    apiBase,
    token: params.get("token")?.trim() || null,
  });
  stripLaunchParams();
  return true;
}
