/**
 * Provides the canonical Kubernetes EndpointSlice-backed consistent-hash router
 * used by Cloud gateway services while leaving the hash implementation injectable.
 */

import type { ServiceLogger } from "./logger";

const DEFAULT_REFRESH_MS = 5_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STALE_MS = 30_000;

export interface ConsistentHashRing {
  range(key: string, count: number): string[];
}

export interface HashRouterOptions {
  createRing(podIPs: string[]): ConsistentHashRing;
  readServiceAccountToken(): string | null;
  readServiceAccountCaCert(): string | null;
  logger: Pick<ServiceLogger, "debug" | "info" | "warn" | "error">;
  refreshMs?: number;
  fetchTimeoutMs?: number;
  maxStaleMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export interface HashRouter {
  getTargets(
    serverUrl: string,
    hashKey: string,
    count: number,
  ): Promise<string[]>;
  refresh(serverUrl: string): Promise<void>;
}

interface RingState {
  ring: ConsistentHashRing;
  podIPs: string[];
  lastRefresh: number;
  lastAttempt: number;
}

interface EndpointSliceList {
  items: Array<{
    endpoints?: Array<{
      addresses: string[];
      conditions?: { ready?: boolean; terminating?: boolean };
    }>;
  }>;
}

type PodIPResolution = { ok: true; podIPs: string[] } | { ok: false };

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

function sameIPs(first: string[], second: string[]): boolean {
  if (first.length !== second.length) return false;
  const sortedFirst = [...first].sort();
  const sortedSecond = [...second].sort();
  return sortedFirst.every((ip, index) => ip === sortedSecond[index]);
}

export function createHashRouter(options: HashRouterOptions): HashRouter {
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  const now = options.now ?? (() => Date.now());
  const rings = new Map<string, RingState>();
  const refreshes = new Map<string, Promise<RingState | undefined>>();

  async function resolvePodIPs(
    serviceName: string,
    namespace: string,
  ): Promise<PodIPResolution> {
    const apiUrl = `https://kubernetes.default.svc/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices?labelSelector=kubernetes.io/service-name=${serviceName}`;
    try {
      const token = options.readServiceAccountToken();
      if (!token) return { ok: false };
      const response = await (options.fetch ?? globalThis.fetch)(apiUrl, {
        headers: { Authorization: `Bearer ${token}` },
        tls: { ca: options.readServiceAccountCaCert() ?? undefined },
        signal: AbortSignal.timeout(fetchTimeoutMs),
      } as RequestInit);
      if (!response.ok) return { ok: false };

      const data = (await response.json()) as EndpointSliceList;
      const podIPs: string[] = [];
      for (const slice of data.items) {
        for (const endpoint of slice.endpoints ?? []) {
          if (
            endpoint.conditions?.ready !== false &&
            !endpoint.conditions?.terminating
          ) {
            podIPs.push(...endpoint.addresses);
          }
        }
      }
      return { ok: true, podIPs };
    } catch (error) {
      // error-policy:J3 Discovery failure stays distinct from an authoritative
      // empty response so a recently verified ring can remain available.
      options.logger.debug("[hash-router] EndpointSlice resolution failed", {
        serviceName,
        namespace,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    }
  }

  function updateRing(
    ringKey: string,
    serviceName: string,
    podIPs: string[],
    existing?: RingState,
  ): RingState | undefined {
    if (podIPs.length === 0) {
      if (existing) {
        options.logger.info("[hash-router] All pods gone, clearing ring", {
          serviceName,
        });
        rings.delete(ringKey);
      }
      return undefined;
    }

    if (existing && sameIPs(existing.podIPs, podIPs)) {
      const timestamp = now();
      existing.lastRefresh = timestamp;
      existing.lastAttempt = timestamp;
      return existing;
    }

    const added = podIPs.filter((ip) => !existing?.podIPs.includes(ip));
    const removed = existing?.podIPs.filter((ip) => !podIPs.includes(ip)) ?? [];
    options.logger.info("[hash-router] Ring updated", {
      serviceName,
      pods: podIPs.length,
      added: added.length > 0 ? added : undefined,
      removed: removed.length > 0 ? removed : undefined,
    });
    const timestamp = now();
    const state = {
      ring: options.createRing(podIPs),
      podIPs,
      lastRefresh: timestamp,
      lastAttempt: timestamp,
    };
    rings.set(ringKey, state);
    return state;
  }

  function retainUsableStaleRing(
    ringKey: string,
    serviceName: string,
    existing: RingState | undefined,
  ): RingState | undefined {
    if (!existing) return undefined;
    const staleForMs = now() - existing.lastRefresh;
    if (staleForMs <= maxStaleMs) return existing;
    options.logger.warn("[hash-router] Discovery failed, dropping stale ring", {
      serviceName,
      staleForMs,
    });
    rings.delete(ringKey);
    return undefined;
  }

  function refreshRing(
    serviceName: string,
    namespace: string,
  ): Promise<RingState | undefined> {
    const ringKey = `${namespace}/${serviceName}`;
    const inFlight = refreshes.get(ringKey);
    if (inFlight) return inFlight;
    const current = rings.get(ringKey);
    if (current) current.lastAttempt = now();

    let refresh!: Promise<RingState | undefined>;
    refresh = (async () => {
      try {
        const resolution = await resolvePodIPs(serviceName, namespace);
        return resolution.ok
          ? updateRing(
              ringKey,
              serviceName,
              resolution.podIPs,
              rings.get(ringKey),
            )
          : retainUsableStaleRing(ringKey, serviceName, rings.get(ringKey));
      } finally {
        if (refreshes.get(ringKey) === refresh) refreshes.delete(ringKey);
      }
    })();
    refreshes.set(ringKey, refresh);
    return refresh;
  }

  function observeRefresh(
    promise: Promise<RingState | undefined>,
    serviceName: string,
  ): void {
    // error-policy:J5 The background refresh rejection is observed here.
    void promise.catch((error) => {
      options.logger.error("[hash-router] Background refresh failed", {
        serviceName,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return {
    async getTargets(serverUrl, hashKey, count) {
      const directTarget = getDirectTarget(serverUrl);
      if (directTarget) return [directTarget];

      const { serviceName, namespace, port } = parseServerUrl(serverUrl);
      const ringKey = `${namespace}/${serviceName}`;
      let entry = rings.get(ringKey);
      const timestamp = now();
      if (!entry || timestamp - entry.lastRefresh > maxStaleMs) {
        entry = await refreshRing(serviceName, namespace);
      } else if (timestamp - entry.lastAttempt > refreshMs) {
        observeRefresh(refreshRing(serviceName, namespace), serviceName);
      }
      if (!entry) return [];
      return entry.ring.range(hashKey, count).map((ip) => `${ip}:${port}`);
    },

    async refresh(serverUrl) {
      if (getDirectTarget(serverUrl)) return;
      const { serviceName, namespace } = parseServerUrl(serverUrl);
      await refreshRing(serviceName, namespace);
    },
  };
}
