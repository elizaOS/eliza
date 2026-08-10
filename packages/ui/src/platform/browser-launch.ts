/**
 * Applies a browser/deep-link launch: creates or activates the target agent
 * profile and persists the active-server record so the app opens pointed at it.
 */

import { isCloudPairAgentId } from "@elizaos/shared/contracts";
import { client } from "../api";
import { getBootConfig } from "../config/boot-config-store";
import { upsertAndActivateAgentProfile } from "../state/agent-profiles";
import {
  createPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import {
  isTrustedCloudApiBaseUrl,
  isTrustedRestoreApiBaseUrl,
} from "../state/runtime-url-trust";
import { isDedicatedCloudAgentBase } from "../utils/cloud-agent-base";

const TRUSTED_CLOUD_LAUNCH_HOSTS = new Set([
  "elizacloud.ai",
  "www.elizacloud.ai",
  "app.elizacloud.ai",
  "api.elizacloud.ai",
]);

function getSearchParams(): URLSearchParams {
  if (typeof window === "undefined") {
    return new URLSearchParams();
  }

  return new URLSearchParams(
    window.location.search || window.location.hash.split("?")[1] || "",
  );
}

function isConfiguredCloudHost(host: string): boolean {
  const configured = getBootConfig().cloudApiBase?.trim();
  if (!configured) return false;
  try {
    return host === new URL(configured).hostname;
  } catch {
    // error-policy:J3 unparseable configured cloud base cannot vouch for the
    // host — untrusted (fail-closed).
    return false;
  }
}

function isTrustedCloudLaunchHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    TRUSTED_CLOUD_LAUNCH_HOSTS.has(normalized) ||
    isConfiguredCloudHost(normalized)
  );
}

function normalizeLaunchApiBase(
  apiBase: string,
  options: { kind?: "cloud" | "remote" } = {},
): string {
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
      isTrustedRestoreApiBaseUrl(parsed.toString()) ||
      (options.kind === "cloud" &&
        parsed.protocol === "https:" &&
        (isConfiguredCloudHost(parsed.hostname) ||
          isDedicatedCloudAgentBase(parsed.toString())))
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
  if (
    isTrustedRestoreApiBaseUrl(parsed.toString()) ||
    (parsed.protocol === "https:" && isTrustedCloudLaunchHost(parsed.hostname))
  ) {
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  }

  throw new Error("Rejected invalid cloud launch base");
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
): Promise<{ agentId: string; apiBase: string; token: string }> {
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
        agentId?: string;
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
    const agentId = payload.data.agentId?.trim();
    if (!isCloudPairAgentId(agentId)) {
      throw new Error("Launch session did not include a valid agent id");
    }

    const apiBase = normalizeLaunchApiBase(payload.data.connection.apiBase, {
      kind: "cloud",
    });
    if (!isTrustedCloudApiBaseUrl(apiBase, agentId)) {
      throw new Error("Launch session agent owner does not match its API base");
    }

    return {
      agentId,
      apiBase,
      token,
    };
  }

  throw lastError ?? new Error("Launch session exchange failed");
}

export function applyLaunchConnection(args: {
  apiBase: string;
  token?: string | null;
  kind?: "cloud" | "remote";
  cloudAgentId?: string | null;
}): { apiBase: string; token: string | null } {
  const kind = args.kind ?? "remote";
  const normalizedApiBase = normalizeLaunchApiBase(args.apiBase, {
    kind,
  });
  const token = args.token?.trim() || null;
  const cloudAgentId =
    kind === "cloud" ? args.cloudAgentId?.trim() || null : null;
  if (
    kind === "cloud" &&
    (!isCloudPairAgentId(cloudAgentId) ||
      !isTrustedCloudApiBaseUrl(normalizedApiBase, cloudAgentId))
  ) {
    throw new Error("Cloud launch owner does not match its API base");
  }

  client.setToken(null);
  client.setBaseUrl(normalizedApiBase);
  if (token) client.setToken(token);
  const persisted = createPersistedActiveServer({
    kind,
    ...(cloudAgentId ? { id: `cloud:${cloudAgentId}` } : {}),
    apiBase: normalizedApiBase,
    ...(token ? { accessToken: token } : {}),
  });
  savePersistedActiveServer(persisted);
  // Keep the agent-profile registry (the "My Runtimes" source of truth) in sync
  // with the active server — otherwise a connection made here is invisible to
  // the runtime switcher and leaves its Active badge stale. Idempotent: a
  // repeat connect to the same host re-activates rather than duplicating.
  upsertAndActivateAgentProfile({
    kind,
    label: persisted.label,
    ...(cloudAgentId ? { cloudAgentId } : {}),
    ...(persisted.apiBase !== undefined ? { apiBase: persisted.apiBase } : {}),
    ...(token ? { accessToken: token } : {}),
  });

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
      cloudAgentId: connection.agentId,
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
  if (params.get("token")?.trim()) {
    // Raw token URL parameter is not accepted; cloudLaunchSession must be used.
    stripLaunchParams();
    return false;
  }

  applyLaunchConnection({
    kind: "remote",
    apiBase,
    token: null,
  });
  stripLaunchParams();
  return true;
}
