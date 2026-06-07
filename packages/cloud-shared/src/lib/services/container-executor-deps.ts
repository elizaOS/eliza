/**
 * Container-executor deps composition (Apps / Product 2) — builds the
 * `{ provider, store }` backend that `setContainerExecutorDeps` injects, so the
 * daemon's `getContainerExecutorDeps()` resolves a REAL provider (SSH -> docker
 * on a worker node) + the REAL container store (over `containers`).
 *
 * Kept in cloud-shared (not the daemon file) so the daemon edit stays a one-line
 * `setContainerExecutorDeps(buildContainerExecutorDeps)` and the composition is
 * unit-testable / reusable. NODE-ONLY: it uses `DockerSSHClient` (ssh2) and is
 * wired only into the node daemon — never the Worker.
 *
 * FEATURE GATE: returns deps that throw a clear error if the apps-container
 * backend isn't configured (no docker nodes / no SSH key), so wiring it in is
 * safe even before infra env is present — provision only runs when a
 * CONTAINER_* job is claimed AND the env is set. Set `APPS_CONTAINERS_ENABLED=1`
 * (or rely on `CONTAINERS_DOCKER_NODES` being present) to arm it.
 */

import { Buffer } from "node:buffer";
import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";
import { AppContainerProvider, type AppContainerSsh } from "./app-container-provider";
import { appContainerStore } from "./app-container-store";
import type { ContainerExecutorDeps } from "./container-job-executors";
import { DockerSSHClient } from "./docker-ssh";

/** True when the apps-container provision backend has enough env to run. */
export function appsContainersEnabled(): boolean {
  if (process.env.APPS_CONTAINERS_ENABLED === "0") return false;
  const hasNodes = Boolean(selectNodeHostOrNull());
  const hasKey = Boolean(containersEnv.sshKey() || containersEnv.sshKeyPath());
  return hasNodes && hasKey;
}

/**
 * Pick a target docker node host. Reads the `CONTAINERS_DOCKER_NODES` seed list
 * (`nodeId:hostname:capacity,...`) and takes the first entry's hostname. This is
 * the seed-only fallback; the production daemon should prefer
 * `dockerNodeManager`'s registered-node selection (least-loaded / autoscaled) —
 * see the wiring note. Returns null when nothing is configured.
 */
function selectNodeHostOrNull(): string | null {
  const seed = containersEnv.seedNodes();
  if (!seed) return null;
  const first = seed.split(",")[0]?.trim();
  if (!first) return null;
  // Format: nodeId:hostname:capacity. Hostname is the 2nd colon field; fall back
  // to the whole token if it's a bare hostname.
  const parts = first.split(":");
  const host = parts.length >= 2 ? parts[1]?.trim() : parts[0]?.trim();
  return host || null;
}

function selectNodeHost(): string {
  const host = selectNodeHostOrNull();
  if (!host) {
    throw new Error(
      "No CONTAINERS_DOCKER_NODES configured — cannot provision app container (set the docker node host)",
    );
  }
  return host;
}

/** A pooled SSH connection to the chosen node, exposing the `AppContainerSsh` seam. */
function makeNodeSsh(): AppContainerSsh {
  const host = selectNodeHost();
  const keyB64 = containersEnv.sshKey();
  const privateKey = keyB64 ? Buffer.from(keyB64, "base64") : undefined;
  // DockerSSHClient.exec(command, timeoutMs?) IS the AppContainerSsh shape.
  const client = privateKey
    ? new DockerSSHClient({ hostname: host, username: containersEnv.sshUser(), privateKey })
    : new DockerSSHClient({
        hostname: host,
        username: containersEnv.sshUser(),
        privateKeyPath: containersEnv.sshKeyPath(),
      });
  return { exec: (command, timeoutMs) => client.exec(command, timeoutMs) };
}

/**
 * Allocate an external host port for the container's app port. Ephemeral-range
 * picker; the deploy density is low (one container per app) so a random pick
 * from the high range is collision-safe enough for now. A node-local registry /
 * `docker port` probe is the hardening follow-up.
 */
async function allocateHostPort(): Promise<number> {
  const MIN = 20000;
  const MAX = 39999;
  return MIN + Math.floor(Math.random() * (MAX - MIN + 1));
}

/**
 * Build the executor backend. Pass to `setContainerExecutorDeps(() => ...)`.
 * Throws (lazily, when a job actually runs) if the backend isn't configured —
 * so wiring it is always safe; nothing connects until a CONTAINER_* job lands.
 */
export function buildContainerExecutorDeps(): ContainerExecutorDeps {
  if (!appsContainersEnabled()) {
    throw new Error(
      "Apps container backend not configured (need CONTAINERS_DOCKER_NODES + CONTAINERS_SSH_KEY/_PATH). " +
        "A CONTAINER_* job was claimed but cannot be provisioned.",
    );
  }
  const ssh = makeNodeSsh();
  const egressProxyUrl = process.env.CONTAINERS_EGRESS_PROXY_URL || undefined;
  const provider = new AppContainerProvider({ ssh, allocateHostPort, egressProxyUrl });
  logger.info("[container-executor-deps] built apps container backend", {
    node: selectNodeHost(),
    egressProxy: Boolean(egressProxyUrl),
  });
  return { provider, store: appContainerStore };
}
