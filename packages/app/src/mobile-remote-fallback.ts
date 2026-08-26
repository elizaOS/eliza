/**
 * Compiles one HTTPS remote-agent origin into a dedicated Android fallback
 * build and installs that target before the first React render. The bootstrap
 * preserves a paired credential only when it belongs to the exact configured
 * origin; stale Cloud, local, or other-remote records are replaced fail-fast.
 */

import { setStorageValue } from "@elizaos/ui/bridge/storage-bridge";
import {
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  persistMobileRuntimeModeForServerTarget,
} from "@elizaos/ui/first-run/mobile-runtime-mode";
import {
  type AgentProfileRegistry,
  loadAgentProfileRegistry,
  saveAgentProfileRegistry,
  upsertAndActivateAgentProfile,
} from "@elizaos/ui/state/agent-profiles";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "@elizaos/ui/state/persistence";

const REMOTE_FALLBACK_API_BASE_ENV_KEY = "VITE_ELIZA_REMOTE_FALLBACK_API_BASE";
const REMOTE_FALLBACK_SERVER_ID = "remote:lp3-vps";
const REMOTE_FALLBACK_LABEL = "Eliza VPS";
const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";
const AGENT_PROFILES_STORAGE_KEY = "elizaos:agent-profiles";
const FIRST_RUN_COMPLETE_STORAGE_KEY = "eliza:first-run-complete";

interface RemoteFallbackClient {
  setBaseUrl(baseUrl: string): void;
  setToken(token: string | null): void;
}

type RuntimeEnv = Record<string, unknown>;

function runtimeEnv(): RuntimeEnv {
  if (
    typeof import.meta !== "undefined" &&
    (import.meta as { env?: RuntimeEnv }).env
  ) {
    return (import.meta as { env: RuntimeEnv }).env;
  }
  return {};
}

/** Resolve and strictly validate the optional root HTTPS fallback origin. */
export function resolveMobileRemoteFallbackApiBase(
  env: RuntimeEnv,
): string | null {
  const raw = env[REMOTE_FALLBACK_API_BASE_ENV_KEY];
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new Error(
      `[mobile-remote-fallback] ${REMOTE_FALLBACK_API_BASE_ENV_KEY} must be a string`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch (cause) {
    // error-policy:J2 preserve the parser cause while adding the build contract.
    throw new Error(
      `[mobile-remote-fallback] ${REMOTE_FALLBACK_API_BASE_ENV_KEY} must be a valid HTTPS origin`,
      { cause },
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.replace(/\/+$/, "") !== ""
  ) {
    throw new Error(
      `[mobile-remote-fallback] ${REMOTE_FALLBACK_API_BASE_ENV_KEY} must be a credential-free root HTTPS origin without a custom port`,
    );
  }
  return parsed.origin;
}

export function getMobileRemoteFallbackApiBase(
  env: RuntimeEnv = runtimeEnv(),
): string | null {
  return resolveMobileRemoteFallbackApiBase(env);
}

/**
 * Make the compiled remote target authoritative for this app installation.
 * Calling this after Capacitor storage hydration keeps a valid paired session
 * while repairing stale targets before startup-state readers run.
 */
export async function installMobileRemoteFallback(
  env: RuntimeEnv = runtimeEnv(),
  client?: RemoteFallbackClient,
): Promise<boolean> {
  const apiBase = getMobileRemoteFallbackApiBase(env);
  if (!apiBase) return false;

  const current = loadPersistedActiveServer();
  const profileCredential = loadAgentProfileRegistry().profiles.find(
    (profile) =>
      profile.kind === "remote" &&
      profile.apiBase?.replace(/\/+$/, "") === apiBase &&
      profile.accessToken,
  )?.accessToken;
  const currentCredential =
    current?.kind === "remote" &&
    current.apiBase?.replace(/\/+$/, "") === apiBase
      ? current.accessToken
      : undefined;
  const accessToken = currentCredential ?? profileCredential;
  const authoritativeServer = {
    ...(currentCredential ? current : {}),
    id: REMOTE_FALLBACK_SERVER_ID,
    kind: "remote",
    label: REMOTE_FALLBACK_LABEL,
    apiBase,
    ...(accessToken ? { accessToken } : {}),
  } as const;
  const saved = savePersistedActiveServer(authoritativeServer);
  if (!saved) {
    throw new Error(
      "[mobile-remote-fallback] failed to persist the authoritative remote target",
    );
  }

  const pinnedProfile = upsertAndActivateAgentProfile({
    kind: "remote",
    label: REMOTE_FALLBACK_LABEL,
    apiBase,
    ...(accessToken ? { accessToken } : {}),
  });
  const pinnedRegistry: AgentProfileRegistry = {
    version: 1,
    activeProfileId: pinnedProfile.id,
    profiles: [pinnedProfile],
  };
  if (!saveAgentProfileRegistry(pinnedRegistry)) {
    throw new Error(
      "[mobile-remote-fallback] failed to persist the authoritative remote profile",
    );
  }
  persistMobileRuntimeModeForServerTarget("remote");
  savePersistedFirstRunComplete(true);

  // Native storage is the cold-launch authority. Await the complete target,
  // profile, mode, and onboarding commit before rendering so a process kill
  // cannot rehydrate any stale Cloud selection on the next start.
  await Promise.all([
    setStorageValue(
      ACTIVE_SERVER_STORAGE_KEY,
      JSON.stringify(authoritativeServer),
    ),
    setStorageValue(AGENT_PROFILES_STORAGE_KEY, JSON.stringify(pinnedRegistry)),
    setStorageValue(MOBILE_RUNTIME_MODE_STORAGE_KEY, "remote-mac"),
    setStorageValue(FIRST_RUN_COMPLETE_STORAGE_KEY, "1"),
  ]);

  client?.setBaseUrl(apiBase);
  client?.setToken(accessToken ?? null);
  return true;
}
