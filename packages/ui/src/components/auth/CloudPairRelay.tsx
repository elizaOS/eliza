/**
 * Exchanges one-time Cloud pairing links, persists the resulting agent
 * credential, and renders the browser/native recovery surfaces.
 */
import {
  CLOUD_PAIR_LEGACY_STORAGE_KEY,
  cloudPairTokenKeyForAgent,
} from "@elizaos/shared/contracts";
import { useEffect, useState } from "react";
import { getBootConfig, setBootConfig } from "../../config/boot-config";
import {
  dedicatedCloudAgentIdFromBase,
  isDedicatedCloudAgentBase,
} from "../../utils/cloud-agent-base";
import { setElizaApiToken } from "../../utils/eliza-globals";

export { cloudPairTokenKeyForAgent };

export const CLOUD_PAIR_SESSION_STORAGE_KEY = CLOUD_PAIR_LEGACY_STORAGE_KEY;
export const CLOUD_PAIR_LOCAL_STORAGE_KEY = CLOUD_PAIR_SESSION_STORAGE_KEY;

interface PairExchangeResponse {
  apiKey?: unknown;
  code?: unknown;
  error?: unknown;
}

export class CloudPairExchangeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
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
  const url = new URL(`${base}/api/auth/pair`);
  const apiHost = new Map([
    ["elizacloud.ai", "api.elizacloud.ai"],
    ["www.elizacloud.ai", "api.elizacloud.ai"],
    ["app.elizacloud.ai", "api.elizacloud.ai"],
    ["dev.elizacloud.ai", "api.elizacloud.ai"],
    ["staging.elizacloud.ai", "api-staging.elizacloud.ai"],
    ["app-staging.elizacloud.ai", "api-staging.elizacloud.ai"],
  ]).get(url.hostname.toLowerCase());
  if (apiHost) {
    url.hostname = apiHost;
  }
  return url.toString();
}

export function resolveNativeCloudPairExchangeUrl(
  cloudApiBase?: string,
): string {
  const url = new URL(resolveCloudPairExchangeUrl(cloudApiBase));
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/native`;
  return url.toString();
}

async function readCloudPairResponse(response: Response): Promise<string> {
  // error-policy:J3 malformed dependency responses are handled by the same
  // typed failure path as a successful response missing its required API key.
  const body = (await response
    .json()
    .catch(() => null)) as PairExchangeResponse | null;

  if (!response.ok) {
    const message =
      typeof body?.error === "string" && body.error.trim()
        ? body.error.trim()
        : "Cloud pairing failed.";
    const code =
      typeof body?.code === "string" && body.code.trim()
        ? body.code.trim()
        : undefined;
    throw new CloudPairExchangeError(message, response.status, code);
  }

  if (typeof body?.apiKey !== "string" || !body.apiKey.trim()) {
    throw new CloudPairExchangeError(
      "Cloud did not return an agent session.",
      502,
      "invalid_pairing_response",
    );
  }

  return body.apiKey.trim();
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

  return readCloudPairResponse(response);
}

/**
 * Exchange a native in-process pair token without relying on an Origin header.
 * The Cloud bearer and every binding copied from the authenticated mint
 * response are verified server-side in one atomic token claim.
 */
export async function exchangeAuthenticatedNativeCloudPairToken(
  token: string,
  options: {
    cloudToken: string;
    agentId: string;
    expectedOrigin: string;
    signal?: AbortSignal;
    fetchFn?: typeof fetch;
    cloudApiBase?: string;
  },
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(
    resolveNativeCloudPairExchangeUrl(options.cloudApiBase),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.cloudToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        token,
        agentId: options.agentId,
        expectedOrigin: options.expectedOrigin,
      }),
      signal: options.signal,
    },
  );

  return readCloudPairResponse(response);
}

function tryPersistBrowserStorage(
  storage: Storage | undefined,
  agentKey: string,
  apiToken: string,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(agentKey, apiToken);
    return true;
  } catch (_storageError) {
    // Browser storage can be disabled by hardened settings. Boot config still
    // carries the token for this page load when at least one channel fails.
    return false;
  }
}

/**
 * Install the exchanged cloud-pair bearer for the LIVE page session only:
 * boot config, the global API token, the boot-config global, and the
 * steward-token-sync broadcast. No storage is written, so nothing survives a
 * reload. This is the fallback for a pairing whose owning agent cannot be
 * resolved — the one-time pair token is already spent, so the bearer must not
 * be dropped, but an unowned credential must never be stamped durably.
 */
export function installCloudPairApiTokenForSession(apiToken: string): void {
  const token = apiToken.trim();
  if (!token) throw new Error("Missing cloud pair API token.");

  const nextConfig = { ...getBootConfig(), apiToken: token };
  setBootConfig(nextConfig);
  setElizaApiToken(token);
  (globalThis as Record<string, unknown>).__ELIZA_APP_BOOT_CONFIG__ =
    nextConfig;

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("steward-token-sync"));
  }
}

/**
 * Persist the durable cloud-pair API token scoped to its owning agent.
 *
 * The token is written under the per-agent key (`eliza:cloud-pair:api-token:
 * <agentId>`) in BOTH storages, so a later boot of a DIFFERENT agent never
 * reads it: the boot adopter only looks up the key for the agent it resolved
 * from the origin (#17579 — previously a single global key let a token
 * persisted for agent A be adopted and mirrored as agent B).
 *
 * The legacy global key is removed once the per-agent write succeeds, so an
 * older install that only ever wrote the global key is migrated forward
 * exactly once, and only while the pairing flow knows the true owner.
 */
export function persistCloudPairApiToken(
  apiToken: string,
  agentId: string,
): void {
  const token = apiToken.trim();
  if (!token) throw new Error("Missing cloud pair API token.");
  const owner = agentId.trim();
  if (!owner) throw new Error("Missing cloud pair token owner agent id.");

  const agentKey = cloudPairTokenKeyForAgent(owner);
  const persistedInSession = tryPersistBrowserStorage(
    typeof window === "undefined" ? undefined : window.sessionStorage,
    agentKey,
    token,
  );
  const persistedDurably = tryPersistBrowserStorage(
    typeof window === "undefined" ? undefined : window.localStorage,
    agentKey,
    token,
  );

  installCloudPairApiTokenForSession(token);

  if (persistedInSession || persistedDurably) {
    // Legacy single-key format is now superseded by the per-agent key. Only
    // remove it after the scoped write landed, so a failed storage channel
    // never destroys the only credential the user has.
    for (const storage of [
      typeof window === "undefined" ? undefined : window.localStorage,
      typeof window === "undefined" ? undefined : window.sessionStorage,
    ]) {
      try {
        storage?.removeItem(CLOUD_PAIR_LOCAL_STORAGE_KEY);
      } catch (_storageError) {
        // error-policy:J3 best-effort legacy cleanup; the per-agent key is the
        // authority now.
      }
    }
  }

  if (!(persistedInSession || persistedDurably)) {
    throw new Error(
      "Cloud pair API token could not be stored in this browser.",
    );
  }
}

export function resolveCloudHostedAgentUrl(
  locationLike: Pick<Location, "hostname"> | null = typeof window ===
  "undefined"
    ? null
    : window.location,
): string {
  const hostname = locationLike?.hostname.trim().toLowerCase() ?? "";
  const staging =
    hostname === "staging.elizacloud.ai" ||
    hostname === "app-staging.elizacloud.ai" ||
    hostname.endsWith(".staging.elizacloud.ai");
  const base = staging
    ? "https://staging.elizacloud.ai"
    : "https://elizacloud.ai";
  const agentId = hostname.endsWith(".staging.elizacloud.ai")
    ? hostname.slice(0, -".staging.elizacloud.ai".length)
    : hostname.endsWith(".elizacloud.ai")
      ? hostname.slice(0, -".elizacloud.ai".length)
      : "";
  const agentPath =
    agentId &&
    !["www", "app", "app-staging", "api", "api-staging", "staging"].includes(
      agentId,
    )
      ? `/${encodeURIComponent(agentId)}`
      : "";
  return `${base}/dashboard/agents${agentPath}`;
}

type CloudPairStatus =
  | { phase: "pairing" }
  | { phase: "session-only" }
  | { phase: "error"; title: string; message: string };

export type CloudPairExchangeFn = (
  token: string,
  options?: { signal?: AbortSignal },
) => Promise<string>;

export interface CloudPairRelayProps {
  token: string;
  exchangeFn?: CloudPairExchangeFn;
  persistFn?: (apiToken: string, agentId: string) => void;
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

export interface CloudHostedAgentAuthNoticeProps {
  /**
   * Native shells supply the canonical device-code login flow here. A plain
   * `_top` navigation can replace a Capacitor WebView and discard its bridge.
   */
  onNativeReauth?: () => Promise<void>;
  /** Retry the agent connection after returning from Cloud management. */
  onNativeRetry?: () => Promise<void>;
  /** Whether native should renew Cloud auth or retry the agent connection. */
  nativeRecoveryMode?: "reauth" | "retry" | "manage";
}

export function CloudHostedAgentAuthNotice({
  onNativeReauth,
  onNativeRetry,
  nativeRecoveryMode = "reauth",
}: CloudHostedAgentAuthNoticeProps = {}) {
  const reopenUrl = resolveCloudHostedAgentUrl();
  const [activeNativeAction, setActiveNativeAction] = useState<
    "primary" | "retry" | null
  >(null);
  const [reauthError, setReauthError] = useState<string | null>(null);
  const handleNativeAction = async (
    action: (() => Promise<void>) | undefined,
    actionName: "primary" | "retry",
  ) => {
    if (!action || activeNativeAction) return;
    setActiveNativeAction(actionName);
    setReauthError(null);
    try {
      await action();
    } catch (error) {
      // error-policy:J4 the sign-in surface remains usable and displays the
      // recoverable failure inline so the user can retry.
      setReauthError(
        error instanceof Error
          ? error.message
          : "Could not reopen Eliza Cloud. Please try again.",
      );
    } finally {
      setActiveNativeAction(null);
    }
  };

  const ctaClass =
    "mt-7 inline-flex min-h-11 items-center justify-center rounded-md bg-[#f3a51f] px-5 text-sm font-semibold text-[#101010] transition hover:bg-[#c97710] disabled:cursor-wait disabled:opacity-70";

  return (
    <main className="flex min-h-[100dvh] flex-col items-center overflow-y-auto bg-[#08090b] px-6 text-center font-body text-white">
      <div className="my-auto w-full max-w-[25rem]">
        <div className="mx-auto mb-6 h-2 w-2 rotate-45 bg-[#f3a51f]" />
        <p className="mb-4 text-sm font-semibold text-white/45">Eliza</p>
        <h1 className="text-2xl font-semibold text-white">
          {nativeRecoveryMode === "retry"
            ? "Reconnect to this Cloud agent"
            : nativeRecoveryMode === "manage"
              ? "Manage this Cloud agent"
              : "Open this agent from Eliza Cloud"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-white/60">
          {nativeRecoveryMode === "retry"
            ? "Your Cloud session is still available, but this agent could not reconnect. Try again without signing out."
            : nativeRecoveryMode === "manage"
              ? "This agent needs attention in Eliza Cloud before it can reconnect. Your current Cloud session will stay signed in."
              : "This Cloud agent uses your Eliza Cloud session. Open it from Eliza Cloud again to create a fresh secure sign-in link."}
        </p>
        {onNativeReauth ? (
          <button
            className={ctaClass}
            disabled={activeNativeAction !== null}
            onClick={() => void handleNativeAction(onNativeReauth, "primary")}
            type="button"
          >
            {activeNativeAction === "primary"
              ? nativeRecoveryMode === "retry"
                ? "Trying again…"
                : "Opening Eliza Cloud…"
              : nativeRecoveryMode === "retry"
                ? "Try again"
                : nativeRecoveryMode === "manage"
                  ? "Open Eliza Cloud"
                  : "Re-open from Eliza Cloud"}
          </button>
        ) : (
          <a className={ctaClass} href={reopenUrl} rel="noopener" target="_top">
            Re-open from Eliza Cloud
          </a>
        )}
        {nativeRecoveryMode === "manage" && onNativeRetry ? (
          <button
            className="mt-3 inline-flex min-h-11 items-center justify-center rounded-md border border-white/15 bg-white/5 px-5 text-sm font-semibold text-white/80 transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-70"
            disabled={activeNativeAction !== null}
            onClick={() => void handleNativeAction(onNativeRetry, "retry")}
            type="button"
          >
            {activeNativeAction === "retry"
              ? "Reconnecting…"
              : "I fixed it — reconnect"}
          </button>
        ) : null}
        {reauthError ? (
          <p className="mt-4 text-sm leading-6 text-[#f4b55a]" role="alert">
            {reauthError}
          </p>
        ) : null}
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
        // Resolve the owning agent the same way the boot adopter (main.tsx)
        // does: the app can be served from a non-dedicated origin while
        // targeting a dedicated agent via the boot apiBase. Mirror that
        // resolution so the persisted key is bound to the true owner and the
        // writer never hard-fails on a resolvable target (#17579).
        const origin =
          typeof window === "undefined" ? null : window.location.origin;
        const apiBase = isDedicatedCloudAgentBase(origin)
          ? origin
          : getBootConfig().apiBase?.trim();
        const owner = isDedicatedCloudAgentBase(apiBase)
          ? dedicatedCloudAgentIdFromBase(apiBase)
          : null;
        if (owner) {
          persistFn(apiToken, owner);
          onPaired();
          return;
        }
        // A pairing target that cannot be resolved to a dedicated cloud
        // agent is not one we may stamp or mirror the credential durably.
        // The one-time token is already spent, so the exchanged bearer is
        // installed for THIS page session only (no storage write) and the
        // user sees a visibly distinct session-only state — never a plain
        // success that silently dropped the credential.
        console.warn(
          "Cloud pair exchange succeeded but no owning agent could be " +
            "resolved from origin or boot base; credential installed for " +
            "this session only, not persisted.",
        );
        installCloudPairApiTokenForSession(apiToken);
        setStatus({ phase: "session-only" });
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

  const title =
    status.phase === "pairing"
      ? "Signing in to your agent"
      : status.phase === "session-only"
        ? "Signed in for this session only"
        : status.title;
  const message =
    status.phase === "pairing"
      ? "This tab will continue automatically."
      : status.phase === "session-only"
        ? "This device could not identify the agent that owns this sign-in, " +
          "so it was not saved. You are signed in for this tab only and will " +
          "need a fresh sign-in link from Eliza Cloud next time."
        : status.message;
  return (
    // Scroll instead of clipping on short viewports (Light Phone III, 1080×1240):
    // `overflow-y-auto` + the inner block's `my-auto` centers when it fits and
    // scrolls-from-top when the error copy pushes it past the fold.
    <main className="flex min-h-[100dvh] flex-col items-center overflow-y-auto bg-[#08090b] px-6 text-center font-body text-white">
      <div className="my-auto w-full max-w-[24rem]">
        <div className="mx-auto mb-6 h-2 w-2 rotate-45 bg-[#f3a51f]" />
        <p className="mb-4 text-sm font-semibold text-white/45">Eliza</p>
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
        <p
          className="mt-3 text-sm leading-6 text-white/60"
          role={status.phase === "session-only" ? "status" : undefined}
        >
          {message}
        </p>
        {status.phase === "session-only" ? (
          <button
            className="mt-7 inline-flex min-h-11 items-center justify-center rounded-md bg-[#f3a51f] px-5 text-sm font-semibold text-[#101010] transition hover:bg-[#c97710]"
            onClick={() => onPaired()}
            type="button"
          >
            Continue to your agent
          </button>
        ) : null}
      </div>
    </main>
  );
}
