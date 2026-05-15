import { readFileSync } from "fs";
import HashRing from "hashring";
import { logger } from "./logger";

const REFRESH_MS = 5_000;

interface RingState {
  ring: HashRing;
  podIPs: string[];
  lastRefresh: number;
}

const rings = new Map<string, RingState>();

let k8sToken: string | null = null;
let k8sCaCert: string | null = null;

function getK8sToken(): string {
  if (k8sToken !== null) return k8sToken;
  k8sToken = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf-8").trim();
  return k8sToken;
}

function getK8sCaCert(): string {
  if (k8sCaCert !== null) return k8sCaCert;
  k8sCaCert = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "utf-8");
  return k8sCaCert;
}

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
  return url.origin;
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

async function resolvePodIPs(serviceName: string, namespace: string): Promise<string[]> {
  const apiUrl = `https://kubernetes.default.svc/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices?labelSelector=kubernetes.io/service-name=${serviceName}`;

  try {
    const res = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${getK8sToken()}` },
      tls: { ca: getK8sCaCert() },
    } as RequestInit);

    if (!res.ok) return [];

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
    return ips;
  } catch (err) {
    logger.debug("EndpointSlice resolution failed", {
      serviceName,
      namespace,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
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
      logger.info("All pods gone, clearing ring", { serviceName });
      rings.delete(serviceName);
    }
    return undefined;
  }

  if (existing && sameIPs(existing.podIPs, podIPs)) {
    existing.lastRefresh = Date.now();
    return existing;
  }

  const added = podIPs.filter((ip) => !existing?.podIPs.includes(ip));
  const removed = existing?.podIPs.filter((ip) => !podIPs.includes(ip)) ?? [];
  if (added.length > 0 || removed.length > 0) {
    logger.info("Hash ring updated", {
      serviceName,
      pods: podIPs.length,
      added: added.length > 0 ? added : undefined,
      removed: removed.length > 0 ? removed : undefined,
    });
  }

  const state: RingState = {
    ring: new HashRing(podIPs, "md5", { "max cache size": 1000 }),
    podIPs,
    lastRefresh: Date.now(),
  };
  rings.set(serviceName, state);
  return state;
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

  if (!entry || now - entry.lastRefresh > REFRESH_MS) {
    const podIPs = await resolvePodIPs(serviceName, namespace);
    entry = updateRing(serviceName, podIPs, entry);
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
  const podIPs = await resolvePodIPs(serviceName, namespace);
  updateRing(serviceName, podIPs, rings.get(serviceName));
}
