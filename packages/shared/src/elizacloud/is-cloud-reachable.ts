/**
 * Boot-time Eliza Cloud reachability probe.
 *
 * A single fast HEAD request to the resolved cloud API base URL, memoized for
 * the lifetime of the process so concurrent boot-time consumers (cloud-auth
 * key validation, plugin-registry network fetch) share one probe instead of
 * each waiting out their own multi-second timeout against an unreachable host.
 *
 * Memoization is on the in-flight promise, not on a persisted boolean: a
 * transient failure resolves to `false` for the rest of this boot but is never
 * written anywhere durable, so a later process start re-probes from scratch.
 */

import { resolveCloudApiBaseUrl } from "./base-url.js";

const PROBE_TIMEOUT_MS = 1_000;

let inFlight: Promise<boolean> | null = null;

async function probeCloud(): Promise<boolean> {
  const baseUrl = resolveCloudApiBaseUrl(process.env.ELIZAOS_CLOUD_BASE_URL);
  try {
    const response = await fetch(baseUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Any HTTP response — including 4xx/5xx — proves the host is reachable.
    // Only a network/timeout error means "offline".
    void response;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves `true` when the Eliza Cloud API base URL answered a cheap probe
 * within ~1s, `false` when it did not. The probe runs at most once per process;
 * all callers await the same promise.
 */
export function isCloudReachable(): Promise<boolean> {
  if (!inFlight) {
    inFlight = probeCloud();
  }
  return inFlight;
}
