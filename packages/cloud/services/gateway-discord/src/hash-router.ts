// Coordinates Discord gateway hash router behavior for multi-tenant bot pods.
import {
  readServiceAccountCaCert,
  readServiceAccountToken,
} from "@elizaos/cloud-services-common";
import HashRing from "hashring";
import { logger } from "./logger";

const REFRESH_MS = 5_000;
const ENDPOINT_SLICE_FETCH_TIMEOUT_MS = 10_000;
const MAX_STALE_RING_MS = 30_000;

interface RingState {
  ring: HashRing;
  podIPs: string[];
  lastRefresh: number;
  lastAttempt: number;
}

const rings = new Map<string, RingState>();
const refreshes = new Map<string, Promise<RingState | undefined>>();

function parseServerUrl(serverUrl: string): {
  serviceName: string;
  namespace: string;
  port: string;
} {
  const url = new URL(serverUrl);
  const parts = url.hostname.split(".");
  return {
    serviceName: parts[0],
    namespace: parts[1] || "eliza-agents",
    port: url.port || "3000",
  };
}

function getDirectTarget(serverUrl: string): string | null {
  const url = new URL(serverUrl);
  if (url.hostname.endsWith(".svc") || url.hostname.includes(".svc.")) {
    return null;
  }
  const basePath = url.pathname.replace(/\/$/, "");
  return basePath && basePath !== "/" ? `${url.origin}${basePath}` : url.origin;
}

interface EndpointSliceList {
  items: Array<{
    endpoints: Array<{
      addresses: string[];
      conditions?: {
        ready?: boolean;
        terminating?: boolean;
      };
    }>;
  }>;
}

type PodIPResolution = { ok: true; podIPs: string[] } | { ok: false };

async function resolvePodIPs(
  serviceName: string,
  namespace: string,
): Promise<PodIPResolution> {
  const apiUrl = `https://kubernetes.default.svc/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices?labelSelector=kubernetes.io/service-name=${serviceName}`;

  try {
    const token = readServiceAccountToken();
    if (!token) return { ok: false };
    const res = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}` },
      tls: { ca: readServiceAccountCaCert() ?? undefined },
      signal: AbortSignal.timeout(ENDPOINT_SLICE_FETCH_TIMEOUT_MS),
    } as RequestInit);

    if (!res.ok) return { ok: false };

    const data = (await res.json()) as EndpointSliceList;
    const ips: string[] = [];
    for (const slice of data.items) {
      if (!slice.endpoints) continue;
      for (const ep of slice.endpoints) {
        if (ep.conditions?.ready !== false && !ep.conditions?.terminating) {
          ips.push(...ep.addresses);
        }
      }
    }
    return { ok: true, podIPs: ips };
  } catch (err) {
    // error-policy:J3 Kubernetes discovery failures remain distinct from an
    // authoritative empty EndpointSlice response so callers can retain cache.
    logger.error("[hash-router] EndpointSlice resolution failed", {
      serviceName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

function sameIPs(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted1 = [...a].sort();
  const sorted2 = [...b].sort();
  return sorted1.every((ip, i) => ip === sorted2[i]);
}

function updateRing(
  serviceName: string,
  podIPs: string[],
  existing?: RingState,
): RingState | undefined {
  if (podIPs.length === 0) {
    if (existing) {
      logger.info("[hash-router] All pods gone, clearing ring", {
        serviceName,
      });
      rings.delete(serviceName);
    }
    return undefined;
  }

  if (existing && sameIPs(existing.podIPs, podIPs)) {
    const now = Date.now();
    existing.lastRefresh = now;
    existing.lastAttempt = now;
    return existing;
  }

  const added = podIPs.filter((ip) => !existing?.podIPs.includes(ip));
  const removed = existing?.podIPs.filter((ip) => !podIPs.includes(ip)) ?? [];
  if (added.length > 0 || removed.length > 0) {
    logger.info("[hash-router] Ring updated", {
      serviceName,
      pods: podIPs.length,
      added: added.length > 0 ? added : undefined,
      removed: removed.length > 0 ? removed : undefined,
    });
  }

  const now = Date.now();
  const state: RingState = {
    ring: new HashRing(podIPs, "md5", { "max cache size": 1000 }),
    podIPs,
    lastRefresh: now,
    lastAttempt: now,
  };
  rings.set(serviceName, state);
  return state;
}

function retainUsableStaleRing(
  serviceName: string,
  existing: RingState | undefined,
): RingState | undefined {
  if (!existing) return undefined;
  const staleForMs = Date.now() - existing.lastRefresh;
  if (staleForMs <= MAX_STALE_RING_MS) {
    return existing;
  }
  logger.warn("[hash-router] Discovery failed, dropping stale ring", {
    serviceName,
    staleForMs,
  });
  rings.delete(serviceName);
  return undefined;
}

function refreshRing(
  serviceName: string,
  namespace: string,
): Promise<RingState | undefined> {
  const refreshKey = `${namespace}/${serviceName}`;
  const inFlight = refreshes.get(refreshKey);
  if (inFlight) return inFlight;

  const current = rings.get(serviceName);
  if (current) current.lastAttempt = Date.now();

  let refresh!: Promise<RingState | undefined>;
  refresh = (async () => {
    try {
      const resolution = await resolvePodIPs(serviceName, namespace);
      return resolution.ok
        ? updateRing(serviceName, resolution.podIPs, rings.get(serviceName))
        : retainUsableStaleRing(serviceName, rings.get(serviceName));
    } finally {
      if (refreshes.get(refreshKey) === refresh) {
        refreshes.delete(refreshKey);
      }
    }
  })();
  refreshes.set(refreshKey, refresh);
  return refresh;
}

function observeRefresh(
  promise: Promise<RingState | undefined>,
  serviceName: string,
): void {
  // error-policy:J5 The background stale-ring refresh is observed here.
  void promise.catch((err) => {
    logger.error("[hash-router] Background refresh failed", {
      serviceName,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export async function getHashTargets(
  serverUrl: string,
  userId: string,
  count: number,
): Promise<string[]> {
  const directTarget = getDirectTarget(serverUrl);
  if (directTarget) {
    return [directTarget];
  }

  const { serviceName, namespace, port } = parseServerUrl(serverUrl);

  let entry = rings.get(serviceName);
  const now = Date.now();

  if (!entry || now - entry.lastRefresh > MAX_STALE_RING_MS) {
    entry = await refreshRing(serviceName, namespace);
  } else if (now - entry.lastAttempt > REFRESH_MS) {
    observeRefresh(refreshRing(serviceName, namespace), serviceName);
  }

  if (!entry) return [];

  const targets = entry.ring.range(userId, count);
  return targets.map((ip: string) => `${ip}:${port}`);
}

export async function refreshHashRing(serverUrl: string): Promise<void> {
  if (getDirectTarget(serverUrl)) {
    return;
  }

  const { serviceName, namespace } = parseServerUrl(serverUrl);
  await refreshRing(serviceName, namespace);
}
