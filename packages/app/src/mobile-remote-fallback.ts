/**
 * Compiles one HTTPS remote-agent origin into a dedicated Android fallback
 * build and installs that target before the first React render. The bootstrap
 * preserves a paired credential only when it belongs to the exact configured
 * origin; stale Cloud, local, or other-remote records are replaced fail-fast.
 */
import { persistMobileRuntimeModeForServerTarget } from "@elizaos/ui/first-run/mobile-runtime-mode";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "@elizaos/ui/state/persistence";

const REMOTE_FALLBACK_API_BASE_ENV_KEY = "VITE_ELIZA_REMOTE_FALLBACK_API_BASE";
const REMOTE_FALLBACK_SERVER_ID = "remote:lp3-vps";
const REMOTE_FALLBACK_LABEL = "Eliza VPS";

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
export function installMobileRemoteFallback(
  env: RuntimeEnv = runtimeEnv(),
): boolean {
  const apiBase = getMobileRemoteFallbackApiBase(env);
  if (!apiBase) return false;

  const current = loadPersistedActiveServer();
  const keepCredential =
    current?.kind === "remote" &&
    current.apiBase?.replace(/\/+$/, "") === apiBase;
  const saved = savePersistedActiveServer({
    ...(keepCredential ? current : {}),
    id: REMOTE_FALLBACK_SERVER_ID,
    kind: "remote",
    label: REMOTE_FALLBACK_LABEL,
    apiBase,
    ...(keepCredential && current?.accessToken
      ? { accessToken: current.accessToken }
      : {}),
  });
  if (!saved) {
    throw new Error(
      "[mobile-remote-fallback] failed to persist the authoritative remote target",
    );
  }

  persistMobileRuntimeModeForServerTarget("remote");
  savePersistedFirstRunComplete(true);
  return true;
}
