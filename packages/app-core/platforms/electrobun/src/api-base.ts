import { resolveDesktopApiPort } from "@elizaos/shared";
import { DEFAULT_API_PORT } from "./constants";
import { logger } from "./logger";

type ExternalApiBaseEnvKey =
  | "ELIZA_DESKTOP_TEST_API_BASE"
  | "ELIZA_DESKTOP_API_BASE"
  | "ELIZA_API_BASE_URL"
  | "ELIZA_API_BASE";

export type DesktopRuntimeMode = "local" | "external" | "disabled";

const EXTERNAL_API_BASE_ENV_KEYS: readonly ExternalApiBaseEnvKey[] = [
  "ELIZA_DESKTOP_TEST_API_BASE",
  "ELIZA_DESKTOP_API_BASE",
  "ELIZA_API_BASE_URL",
  "ELIZA_API_BASE",
];

export interface ExternalApiBaseResolution {
  base: string | null;
  source: ExternalApiBaseEnvKey | null;
  invalidSources: ExternalApiBaseEnvKey[];
}

export interface DesktopRuntimeModeResolution {
  mode: DesktopRuntimeMode;
  externalApi: ExternalApiBaseResolution;
}

export function normalizeApiBase(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function resolveExternalApiBase(
  env: Record<string, string | undefined>,
): ExternalApiBaseResolution {
  const invalidSources: ExternalApiBaseEnvKey[] = [];

  for (const key of EXTERNAL_API_BASE_ENV_KEYS) {
    const rawValue = env[key]?.trim();
    if (!rawValue) continue;

    const normalized = normalizeApiBase(rawValue);
    if (normalized) {
      return { base: normalized, source: key, invalidSources };
    }
    invalidSources.push(key);
  }

  return { base: null, source: null, invalidSources };
}

function isEnabledFlag(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

export function resolveDesktopRuntimeMode(
  env: Record<string, string | undefined>,
): DesktopRuntimeModeResolution {
  const externalApi = resolveExternalApiBase(env);
  if (externalApi.base) {
    return { mode: "external", externalApi };
  }

  if (isEnabledFlag(env.ELIZA_DESKTOP_SKIP_EMBEDDED_AGENT)) {
    return { mode: "disabled", externalApi };
  }

  return { mode: "local", externalApi };
}

/**
 * The persisted deployment runtime the desktop main process reads from
 * `eliza.json` (`deploymentTarget.runtime`). `"cloud"` is a cloud-hosted agent
 * (topology 3) and `"remote"` is an external agent the device connects to;
 * both skip the embedded agent when a reachable base is known. `"local"` keeps
 * the existing env-driven embedded-agent boot. `null` ⇒ no persisted target.
 */
export type PersistedDeploymentRuntime = "local" | "cloud" | "remote" | null;

/**
 * The persisted deployment the desktop main process reads from `eliza.json`'s
 * `deploymentTarget`. `runtime` drives the topology decision; `remoteApiBase`
 * is the cloud-hosted/external agent's reachable URL the renderer wrote when it
 * connected (`null` when none was persisted). `null` ⇒ no persisted target.
 */
export interface PersistedDeployment {
  runtime: NonNullable<PersistedDeploymentRuntime>;
  remoteApiBase: string | null;
}

/**
 * Resolve the cloud-hosted agent API base the renderer should call when the
 * persisted deployment is a real cloud-hosted agent (topology 3). This is a
 * renderer-ready base (origin that serves `/api/...` agent paths), NOT the
 * Eliza Cloud `/api/v1` URL — the cloud's agent/auth routes live at different
 * mount points, so it cannot be derived from the cloud site URL by
 * origin-concat. Resolution is an explicit base, in priority order:
 *   1. `ELIZA_DESKTOP_CLOUD_AGENT_BASE` — env override (tests / pinning).
 *   2. The persisted `deploymentTarget.remoteApiBase` the renderer wrote when
 *      it connected to the cloud-hosted/external agent — the auto-wire path, so
 *      a topology-3 user gets the embedded-agent skip on next boot with no env.
 * Both candidates go through {@link normalizeApiBase}, so a non-http(s) or
 * malformed value (e.g. the on-device `eliza-local-agent://ipc` shared-runtime
 * base) is rejected. Returns `null` when no renderer-ready cloud agent base is
 * available, so the caller falls back to running the local agent (topology-1/2).
 */
export function resolveCloudHostedAgentApiBase(
  env: Record<string, string | undefined>,
  persistedRemoteApiBase?: string | null,
): string | null {
  const fromEnv = normalizeApiBase(env.ELIZA_DESKTOP_CLOUD_AGENT_BASE?.trim());
  if (fromEnv) return fromEnv;
  return normalizeApiBase(persistedRemoteApiBase?.trim() ?? undefined);
}

/**
 * Topology-aware runtime-mode resolution. Layers the persisted deployment
 * target on top of the pure env resolver ({@link resolveDesktopRuntimeMode}):
 *
 * - If env already forces `external`/`disabled`, that wins (unchanged).
 * - Else, if the persisted deployment is a cloud-hosted (`runtime: "cloud"`) or
 *   external (`runtime: "remote"`) agent AND a renderer-ready agent API base is
 *   resolvable (env override or the persisted `remoteApiBase`), resolve to
 *   `external` with that base so the embedded agent is skipped and the renderer
 *   points at the cloud/external agent (topology 3).
 * - Otherwise fall through to the env result (`local`).
 *
 * Topology 1 (local agent → cloud inference; persisted runtime is `"local"`,
 * branded cloud via {@link resolveDesktopRuntimeModeSignal}) and topology 2
 * (all-local) keep `mode === "local"` and still boot the embedded agent.
 */
export function resolveDesktopRuntimeModeWithDeployment(
  env: Record<string, string | undefined>,
  deployment: PersistedDeployment | null,
): DesktopRuntimeModeResolution {
  const envResolution = resolveDesktopRuntimeMode(env);
  if (envResolution.mode !== "local") {
    return envResolution;
  }

  if (deployment?.runtime === "cloud" || deployment?.runtime === "remote") {
    const cloudBase = resolveCloudHostedAgentApiBase(
      env,
      deployment.remoteApiBase,
    );
    if (cloudBase) {
      return {
        mode: "external",
        externalApi: {
          base: cloudBase,
          source: null,
          invalidSources: envResolution.externalApi.invalidSources,
        },
      };
    }
  }

  return envResolution;
}

/**
 * Desktop cloud-only opt-in. Returns `"cloud"` when the desktop shell should run
 * cloud-only — cloud model providers only (no local model/embedding warmup) and a
 * cloud-only first-run UI. This is ORTHOGONAL to {@link resolveDesktopRuntimeMode}
 * (external/local/disabled, i.e. *where* the agent runs): in cloud-only mode the
 * loopback agent still runs and serves the cloud-login proxy + becomes cloud-backed
 * after sign-in; only its model sourcing and the renderer's first-run UI change.
 * Returns `null` (the default) when no cloud-only opt-in is present, so existing
 * desktop/mobile/web behavior is unchanged.
 */
export function resolveDesktopRuntimeModeSignal(
  env: Record<string, string | undefined>,
): "cloud" | null {
  const explicit = env.ELIZA_DESKTOP_RUNTIME_MODE?.trim().toLowerCase();
  if (explicit === "cloud" || explicit === "elizacloud") return "cloud";
  if (isEnabledFlag(env.ELIZA_DESKTOP_CLOUD_ONLY)) return "cloud";
  return null;
}

export function resolveInitialApiBase(
  env: Record<string, string | undefined>,
): string | null {
  const resolution = resolveDesktopRuntimeMode(env);
  if (resolution.mode === "external") {
    return resolution.externalApi.base;
  }

  const agentPort = resolveDesktopApiPort(env) || DEFAULT_API_PORT;
  return `http://127.0.0.1:${agentPort}`;
}

/** True when the hostname is a loopback we treat as same-trust as 127.0.0.1. */
function isLoopbackHttpHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/**
 * When the desktop loads the UI from a local http(s) dev server (Vite), the
 * renderer must call `/api` on **that origin** so requests stay same-origin and
 * the Vite proxy reaches the embedded agent. Pushing `http://127.0.0.1:<apiPort>`
 * instead breaks WKWebView (cross-origin + missing/weird `Origin`).
 *
 * Returns `null` when no dev URL is set or it is not a loopback http(s) origin.
 */
export function resolveHttpLoopbackRendererOriginForApiClient(
  env: Record<string, string | undefined>,
): string | null {
  const raw =
    env.ELIZA_RENDERER_URL?.trim() || env.VITE_DEV_SERVER_URL?.trim() || "";
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!isLoopbackHttpHostname(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Base URL the **renderer** should use for `the appClient` (REST + relative `/api`).
 * Prefer the Vite/dev-server origin when `ELIZA_RENDERER_URL` points at loopback;
 * otherwise the real API listen port on 127.0.0.1.
 */
export function resolveRendererFacingApiBase(
  env: Record<string, string | undefined>,
  apiListenPort: number,
): string {
  const fromDevServer = resolveHttpLoopbackRendererOriginForApiClient(env);
  if (fromDevServer) return fromDevServer;
  return `http://127.0.0.1:${apiListenPort}`;
}

/**
 * Push the API base URL (and optional token) to the renderer via typed
 * RPC message (CSP-safe). The renderer bridge handles `apiBaseUpdate`.
 */
type ApiBaseUpdateRpc = {
  send?: {
    apiBaseUpdate?: (payload: { base: string; token?: string }) => void;
  };
};

export function pushApiBaseToRenderer(
  win: { webview: { rpc?: unknown } },
  base: string,
  apiToken?: string,
): void {
  const trimmedToken = apiToken?.trim();
  const payload = { base, token: trimmedToken || undefined };
  try {
    const rpcSend = (win.webview.rpc as ApiBaseUpdateRpc | undefined)?.send;
    rpcSend?.apiBaseUpdate?.(payload);
  } catch (err) {
    logger.warn(
      `[ApiBase] Push failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
