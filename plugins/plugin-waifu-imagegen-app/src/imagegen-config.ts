/**
 * Runtime configuration resolver for the waifu image-gen AppView.
 *
 * The image-gen invoke endpoint lives on the waifu.fun API (a different origin
 * from the ElizaOS agent server this view renders inside), keyed by the agent's
 * token address. This module resolves three things at view-mount time, in
 * priority order:
 *
 *   1. waifu API base   — where to POST the invoke
 *   2. agent token addr — which agent's image-gen app to invoke
 *   3. auth credential  — a Steward JWT bearer OR an agent-app invoke key
 *
 * Resolution sources (first non-empty wins):
 *   - a host-injected global `window.__WAIFU_IMAGEGEN__` (the ElizaOS shell can
 *     populate this per-agent when it mounts the view)
 *   - Vite-style `import.meta.env` (VITE_WAIFU_*) baked at bundle build
 *   - a sane production default for the API base
 *
 * Nothing here imports from the waifu monorepo; the contract is the injected
 * global / env shape only.
 */

export interface WaifuImageGenRuntimeConfig {
  /** Base URL of the waifu API, e.g. "https://waifu.fun". No trailing slash. */
  apiBase: string;
  /** The agent's token address whose image-gen app is invoked. */
  agentTokenAddress: string | null;
  /** Steward JWT bearer, when the viewer is signed in. */
  stewardJwt: string | null;
  /**
   * Agent-app invoke key (x-waifu-app-invoke-key). Server/runtime contexts only.
   * Present when the host injects it for a trusted same-process surface.
   */
  appInvokeKey: string | null;
  /** App metadata bag (markup pct, metered model) if the host supplies it. */
  metadata: unknown;
}

interface InjectedConfig {
  apiBase?: string;
  agentTokenAddress?: string;
  stewardJwt?: string;
  appInvokeKey?: string;
  metadata?: unknown;
}

const DEFAULT_WAIFU_API_BASE = "https://waifu.fun";

function readInjectedGlobal(): InjectedConfig | null {
  if (typeof window === "undefined") return null;
  const raw = (window as unknown as Record<string, unknown>).__WAIFU_IMAGEGEN__;
  if (!raw || typeof raw !== "object") return null;
  return raw as InjectedConfig;
}

function readEnv(key: string): string | null {
  // import.meta.env is baked at bundle build; guard for non-Vite hosts.
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const value = env?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Resolve the live image-gen runtime config. The optional `override` lets the
 * AppView's host props (token address, metadata) win over ambient sources when
 * the shell passes them explicitly.
 */
export function resolveWaifuImageGenConfig(
  override?: Partial<WaifuImageGenRuntimeConfig>,
): WaifuImageGenRuntimeConfig {
  const injected = readInjectedGlobal();

  const apiBase = stripTrailingSlash(
    firstNonEmpty(
      override?.apiBase,
      injected?.apiBase,
      readEnv("VITE_WAIFU_API_BASE"),
      DEFAULT_WAIFU_API_BASE,
    ) ?? DEFAULT_WAIFU_API_BASE,
  );

  const agentTokenAddress = firstNonEmpty(
    override?.agentTokenAddress,
    injected?.agentTokenAddress,
    readEnv("VITE_WAIFU_AGENT_TOKEN"),
  );

  const stewardJwt = firstNonEmpty(
    override?.stewardJwt,
    injected?.stewardJwt,
    readEnv("VITE_WAIFU_STEWARD_JWT"),
  );

  const appInvokeKey = firstNonEmpty(
    override?.appInvokeKey,
    injected?.appInvokeKey,
  );

  const metadata =
    override?.metadata !== undefined ? override.metadata : injected?.metadata;

  return {
    apiBase,
    agentTokenAddress,
    stewardJwt,
    appInvokeKey,
    metadata: metadata ?? null,
  };
}
