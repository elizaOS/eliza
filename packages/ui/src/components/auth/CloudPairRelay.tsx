import { useEffect, useState } from "react";
import { getBootConfig, setBootConfig } from "../../config/boot-config";
import { setElizaApiToken } from "../../utils/eliza-globals";

export const CLOUD_PAIR_SESSION_STORAGE_KEY = "eliza:cloud-pair:api-token";

interface PairExchangeResponse {
  apiKey?: unknown;
  error?: unknown;
}

export class CloudPairExchangeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudPairExchangeError";
  }
}

export function getCloudPairTokenFromLocation(
  locationLike: Pick<Location, "pathname" | "search"> | null = typeof window ===
  "undefined"
    ? null
    : window.location,
): string | null {
  if (!locationLike) return null;
  if (locationLike.pathname.replace(/\/+$/, "") !== "/pair") return null;
  const token = new URLSearchParams(locationLike.search).get("token")?.trim();
  return token || null;
}

export function isElizaCloudHostedLocation(
  locationLike: Pick<
    Location,
    "hostname" | "protocol"
  > | null = typeof window === "undefined" ? null : window.location,
): boolean {
  if (!locationLike) return false;
  if (locationLike.protocol !== "https:" && locationLike.protocol !== "http:") {
    return false;
  }
  const hostname = locationLike.hostname.trim().toLowerCase();
  return hostname === "elizacloud.ai" || hostname.endsWith(".elizacloud.ai");
}

export function resolveCloudPairExchangeUrl(cloudApiBase?: string): string {
  const configured = cloudApiBase?.trim() || getBootConfig().cloudApiBase;
  const base = (configured || "https://elizacloud.ai")
    .replace(/\/+$/, "")
    .replace(/\/api\/v1\/?$/, "");
  return `${base}/api/auth/pair`;
}

export async function exchangeCloudPairToken(
  token: string,
  options: {
    signal?: AbortSignal;
    fetchFn?: typeof fetch;
    cloudApiBase?: string;
  } = {},
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(
    resolveCloudPairExchangeUrl(options.cloudApiBase),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: options.signal,
    },
  );

  const body = (await response
    .json()
    .catch(() => null)) as PairExchangeResponse | null;

  if (!response.ok) {
    const message =
      typeof body?.error === "string" && body.error.trim()
        ? body.error.trim()
        : "Cloud pairing failed.";
    throw new CloudPairExchangeError(message, response.status);
  }

  if (typeof body?.apiKey !== "string" || !body.apiKey.trim()) {
    throw new CloudPairExchangeError(
      "Cloud did not return an agent session.",
      502,
    );
  }

  return body.apiKey.trim();
}

function tryPersistCloudPairSessionToken(apiToken: string): boolean {
  try {
    window.sessionStorage.setItem(CLOUD_PAIR_SESSION_STORAGE_KEY, apiToken);
    return true;
  } catch (_storageError) {
    // Session storage can be disabled by hardened browsers. Boot config still
    // carries the token for this page load, so the redirect can continue.
    return false;
  }
}

export function persistCloudPairApiToken(apiToken: string): void {
  const token = apiToken.trim();
  if (!token) throw new Error("Missing cloud pair API token.");

  tryPersistCloudPairSessionToken(token);

  const nextConfig = { ...getBootConfig(), apiToken: token };
  setBootConfig(nextConfig);
  setElizaApiToken(token);
  (globalThis as Record<string, unknown>).__ELIZA_APP_BOOT_CONFIG__ =
    nextConfig;

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("steward-token-sync"));
  }
}

type CloudPairStatus =
  | { phase: "pairing" }
  | { phase: "error"; title: string; message: string };

export type CloudPairExchangeFn = (
  token: string,
  options?: { signal?: AbortSignal },
) => Promise<string>;

export interface CloudPairRelayProps {
  token: string;
  exchangeFn?: CloudPairExchangeFn;
  persistFn?: (apiToken: string) => void;
  onPaired?: () => void;
}

function describePairFailure(error: unknown): Exclude<
  CloudPairStatus,
  {
    phase: "pairing";
  }
> {
  if (error instanceof CloudPairExchangeError) {
    if ([401, 403, 410].includes(error.status)) {
      return {
        phase: "error",
        title: "Sign-in link expired",
        message: "Open this agent from Eliza Cloud again to continue.",
      };
    }
    if (error.status === 429) {
      return {
        phase: "error",
        title: "Too many sign-in attempts",
        message: "Wait a minute, then open this agent from Eliza Cloud again.",
      };
    }
  }

  return {
    phase: "error",
    title: "Could not sign in",
    message: "Open this agent from Eliza Cloud again to continue.",
  };
}

export function CloudHostedAgentAuthNotice() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[#08090b] px-6 text-center font-body text-white">
      <div className="w-full max-w-[25rem]">
        <div className="mx-auto mb-6 h-2 w-2 rotate-45 bg-[#f3a51f]" />
        <p className="mb-4 text-sm font-semibold text-white/45">Eliza</p>
        <h1 className="text-2xl font-semibold text-white">
          Open this agent from Eliza Cloud
        </h1>
        <p className="mt-3 text-sm leading-6 text-white/60">
          This Cloud agent uses your Eliza Cloud session. Open it from Eliza
          Cloud again to create a fresh secure sign-in link.
        </p>
      </div>
    </main>
  );
}

function redirectToAgentRoot(): void {
  window.location.replace("/");
}

export function CloudPairRelay({
  token,
  exchangeFn = exchangeCloudPairToken,
  persistFn = persistCloudPairApiToken,
  onPaired = redirectToAgentRoot,
}: CloudPairRelayProps) {
  const [status, setStatus] = useState<CloudPairStatus>({ phase: "pairing" });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    exchangeFn(token, { signal: controller.signal })
      .then((apiToken) => {
        if (!active) return;
        persistFn(apiToken);
        onPaired();
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        setStatus(describePairFailure(error));
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [exchangeFn, onPaired, persistFn, token]);

  const isPairing = status.phase === "pairing";
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[#08090b] px-6 text-center font-body text-white">
      <div className="w-full max-w-[24rem]">
        <div className="mx-auto mb-6 h-2 w-2 rotate-45 bg-[#f3a51f]" />
        <p className="mb-4 text-sm font-semibold text-white/45">Eliza</p>
        <h1 className="text-2xl font-semibold text-white">
          {isPairing ? "Signing in to your agent" : status.title}
        </h1>
        <p className="mt-3 text-sm leading-6 text-white/60">
          {isPairing ? "This tab will continue automatically." : status.message}
        </p>
      </div>
    </main>
  );
}
