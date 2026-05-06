/**
 * probe-local-agent.ts
 *
 * Liveness probe for an on-device Eliza agent listening on loopback.
 *
 * Phase E of the local-agent-on-Android effort gates the "Local Agent" tile
 * in `RuntimeGate` behind a real check that the agent's `/api/health`
 * endpoint is reachable and reports `{ ok: true }`. Without this, a user on
 * Android with no native agent installed would see a tile that does nothing.
 *
 * Result is cached for `PROBE_CACHE_TTL_MS` so repeated renders during the
 * onboarding flow do not hammer loopback. The cache is keyed by URL.
 *
 * `clearLocalAgentProbeCache()` resets the cache between tests.
 */

import { Capacitor } from "@capacitor/core";
import { isAndroidLocalAgentUrl } from "./local-agent-token";

export const DEFAULT_LOCAL_AGENT_HEALTH_URL =
  "http://127.0.0.1:31337/api/health";

// Positive results are cached longer so re-renders during onboarding don't
// hammer loopback. Negative results are short-lived because the agent may
// finish booting moments after the first probe — without a short negative
// TTL the user sees "no local agent" for 30 s after a reboot even though
// the agent is up. 3 s lets `RuntimeGate`'s render cycle re-poll naturally.
const PROBE_POSITIVE_CACHE_TTL_MS = 30_000;
const PROBE_NEGATIVE_CACHE_TTL_MS = 3_000;

interface CacheEntry {
  result: boolean;
  expiresAt: number;
}

const resultCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<boolean>>();

type NativeAgentProbePlugin = {
  request?: (options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }) => Promise<{
    status: number;
    body?: string | null;
  }>;
};

const agentPluginId = "@elizaos/capacitor-agent";
const agentPluginName = "Agent";

function toNativeAgentProbePlugin(
  plugin: NativeAgentProbePlugin | null | undefined,
): NativeAgentProbePlugin | null {
  if (typeof plugin?.request !== "function") return null;
  const request = plugin.request.bind(plugin);
  return {
    request: (options) => request(options),
  };
}

function isNativeAndroid(): boolean {
  try {
    return (
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"
    );
  } catch {
    return false;
  }
}

async function resolveNativeAgentPlugin(): Promise<NativeAgentProbePlugin | null> {
  try {
    const capacitorWithPlugins = Capacitor as typeof Capacitor & {
      Plugins?: Record<string, NativeAgentProbePlugin | undefined>;
    };
    const registeredAgent =
      capacitorWithPlugins.Plugins?.[agentPluginName] ??
      Capacitor.registerPlugin<NativeAgentProbePlugin>(agentPluginName);
    const agent = toNativeAgentProbePlugin(registeredAgent);
    if (agent) return agent;
  } catch {
    // Fall through to the package import for browser/package-mode test builds.
  }

  try {
    const mod = (await import(/* @vite-ignore */ agentPluginId)) as {
      Agent?: NativeAgentProbePlugin;
    };
    return toNativeAgentProbePlugin(mod.Agent);
  } catch {
    return null;
  }
}

/** Reset the probe cache. Test-only. */
export function clearLocalAgentProbeCache(): void {
  resultCache.clear();
  inflight.clear();
}

export interface LocalOptionGate {
  isDesktop: boolean;
  isDev: boolean;
  isAndroid: boolean;
}

/**
 * Liveness probe for the on-device local agent, framed as "should the local
 * option be visible / actionable yet?".
 *
 * - Desktop and dev builds: always `true` synchronously — they manage the
 *   runtime themselves.
 * - Android: unconditionally the only runtime mode (the picker is bypassed
 *   in the APK by `preSeedAndroidLocalRuntimeIfFresh` + the `RuntimeGate`
 *   Android branch). The probe here is purely a *readiness* signal —
 *   "is the agent's `/api/health` reachable yet?" — used by the splash to
 *   know when to call `finishAsLocal()`. It is **not** a gate on whether
 *   the local mode is offered at all; on Android it always is.
 * - Other platforms (iOS, plain web): `false`. They do not host a local
 *   agent.
 */
export async function shouldShowLocalOption(
  gate: LocalOptionGate,
): Promise<boolean> {
  if (gate.isDesktop || gate.isDev) return true;
  if (!gate.isAndroid) return false;
  return probeLocalAgent();
}

function isHealthyBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as {
    ok?: unknown;
    ready?: unknown;
    agentState?: unknown;
  };
  if (b.ok === true) return true;
  if (b.ready === true) return true;
  if (b.agentState === "running") return true;
  return false;
}

async function runNativeAndroidProbe(
  url: string,
  timeoutMs: number,
): Promise<boolean | null> {
  if (!isAndroidLocalAgentUrl(url) || !isNativeAndroid()) return null;

  const agent = await resolveNativeAgentPlugin();
  if (!agent?.request) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  let result: Awaited<
    ReturnType<NonNullable<NativeAgentProbePlugin["request"]>>
  >;
  try {
    result = await agent.request({
      method: "GET",
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        Accept: "application/json",
        "X-ElizaOS-Client-Id": "local-agent-probe",
      },
      timeoutMs,
    });
  } catch {
    return false;
  }

  if (result.status < 200 || result.status >= 300) return false;

  let body: unknown;
  try {
    body = JSON.parse(result.body ?? "");
  } catch {
    return false;
  }

  return isHealthyBody(body);
}

async function runProbe(url: string, timeoutMs: number): Promise<boolean> {
  const nativeResult = await runNativeAndroidProbe(url, timeoutMs);
  if (nativeResult !== null) return nativeResult;

  if (typeof fetch !== "function") return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) return false;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return false;
  }

  // The agent's /api/health responds with one of two shapes depending on
  // version:
  //   { ok: true, agent, bun, uptime }                 ← spike stub
  //   { ready: true, runtime: "ok", database: "ok",
  //     agentState: "running", uptime, ...}            ← real @elizaos/agent
  // Treat either as healthy. `ok === true` covers the stub; `ready === true`
  // and `agentState === "running"` cover the real runtime. Without this, the
  // RuntimeGate tile stays hidden even when the agent is plainly up.
  return isHealthyBody(body);
}

/**
 * Probes a local agent's `/api/health` endpoint with a timeout.
 *
 * Returns `true` only when the response is HTTP 200 and the JSON body
 * contains `{ ok: true }`. Any other outcome (timeout, network error,
 * non-200, non-JSON, missing field) returns `false`.
 *
 * Results are memoized per URL for 30 seconds.
 */
export async function probeLocalAgent(
  timeoutMs = 1500,
  url: string = DEFAULT_LOCAL_AGENT_HEALTH_URL,
): Promise<boolean> {
  const now = Date.now();
  const cached = resultCache.get(url);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = runProbe(url, timeoutMs)
    .then((result) => {
      resultCache.set(url, {
        result,
        expiresAt:
          Date.now() +
          (result ? PROBE_POSITIVE_CACHE_TTL_MS : PROBE_NEGATIVE_CACHE_TTL_MS),
      });
      return result;
    })
    .finally(() => {
      inflight.delete(url);
    });

  inflight.set(url, promise);
  return promise;
}
