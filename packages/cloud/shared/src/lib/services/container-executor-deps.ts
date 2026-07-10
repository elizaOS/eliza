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
import { ElizaError } from "@elizaos/core";
import { dbRead, dbWrite } from "../../db/helpers";
import { containersRepository } from "../../db/repositories/containers";
import { containersEnv } from "../config/containers-env";
import { logger } from "../utils/logger";
import { isValidUUID } from "../utils/validation";
import { decideBuilderArming, selectBuilderHost } from "./app-builder-host";
import { AppContainerProvider, type AppContainerSsh } from "./app-container-provider";
import { ContainerRepoAppContainerStore } from "./app-container-store";
import type { BuildExec } from "./app-image-builder";
import { waitForUrlReachable } from "./app-reachability";
import { appsService } from "./apps";
import { addAppRoute, removeAppRoute } from "./apps-ingress-provisioner";
import type { ContainerExecutorDeps } from "./container-job-executors";
import { allocateAppContainerHostPort } from "./docker-port-allocation";
import { DockerSSHClient } from "./docker-ssh";
import { listVerifiedAppOrigins } from "./managed-domains";

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

/**
 * Resolve the host that runs UNTRUSTED app builds — a DEDICATED builder host
 * distinct from any node hosting tenant containers, if one is configured.
 * Thin binder over the pure {@link selectBuilderHost} (the runtime-node selector
 * is this module's seed/registered-node pick). See `app-builder-host.ts`.
 */
export function selectBuilderHostOrNull(): string | null {
  return selectBuilderHost(selectNodeHostOrNull);
}

/**
 * Expose a builder host's SSH connection as a {@link BuildExec} so the deploy
 * backend can build user images FROM THEIR REPO (`docker buildx build --push
 * <git-url>`) and push to the registry — the "Vercel-like" path where the
 * platform does the build, not the user. `AppContainerSsh.exec(cmd, timeoutMs)`
 * is structurally identical to `BuildExec.exec`.
 *
 * SECURITY GATE (see {@link decideBuilderArming}): returns null (→ prebuilt-image
 * fallback, build-from-repo stays OFF) unless ALL of:
 *   1. the container backend is configured (`appsContainersEnabled()`),
 *   2. build-from-repo is explicitly armed (`APPS_BUILD_FROM_REPO_ENABLED=1`),
 *   3. an isolated builder host resolves (a dedicated `APPS_BUILDS_HOST`, or the
 *      runtime node only if `APPS_BUILD_ON_RUNTIME_NODE` is opted in).
 * So an unconfigured/un-armed canary never builds an untrusted Dockerfile, and
 * it never builds on a tenant-hosting node by accident.
 *
 * INFRA NOTE: the builder host must be `docker login`'d to the registry (push
 * for build) and run a dockerd that supports the `docker-container` buildx
 * driver. Provisioning a dedicated builder node (no tenant containers) is the
 * infra complement — see the PR's infra-follow-up.
 */
export function makeNodeBuilderExec(): BuildExec | null {
  const decision = decideBuilderArming({
    backendEnabled: appsContainersEnabled(),
    selectRuntimeNode: selectNodeHostOrNull,
  });
  if (!decision.armed || !decision.host) {
    if (decision.reason === "no-isolated-host") {
      logger.warn(
        "[container-executor-deps] build-from-repo armed but no isolated builder host — set APPS_BUILDS_HOST (dedicated) or APPS_BUILD_ON_RUNTIME_NODE=1 to opt into the runtime node; staying on prebuilt-image path",
      );
    } else if (decision.reason === "not-armed") {
      logger.info(
        "[container-executor-deps] build-from-repo not armed (APPS_BUILD_FROM_REPO_ENABLED unset) — using prebuilt-image path",
      );
    }
    return null;
  }
  logger.info("[container-executor-deps] build-from-repo armed", {
    builderHost: decision.host,
    dedicated: decision.dedicated,
  });
  return makeBuilderSsh(decision.host);
}

/** A pooled SSH connection to the chosen node, exposing the `AppContainerSsh` seam. */
function makeNodeSsh(): AppContainerSsh {
  return makeBuilderSsh(selectNodeHost());
}

/** A pooled SSH connection to an explicit host, exposing the `AppContainerSsh` seam. */
function makeBuilderSsh(host: string): AppContainerSsh {
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

/** Parse the docker node id from the first `CONTAINERS_DOCKER_NODES` seed entry. */
function parseSeedNodeIdOrNull(): string | null {
  const seed = containersEnv.seedNodes();
  if (!seed) return null;
  const first = seed.split(",")[0]?.trim();
  if (!first) return null;
  const parts = first.split(":");
  const nodeId = parts[0]?.trim();
  return nodeId || first;
}

/**
 * Allocate a collision-safe external host port for the container's app port.
 * Queries sandbox + app-container metadata on the target node before picking.
 */
async function allocateHostPort(): Promise<number> {
  const nodeId = parseSeedNodeIdOrNull() ?? "seed-node";
  return allocateAppContainerHostPort(nodeId);
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
  const nodeHost = selectNodeHost();
  const nodeId = parseSeedNodeIdOrNull();
  if (!nodeId) {
    throw new ElizaError("CONTAINERS_DOCKER_NODES has no durable node id", {
      code: "APP_CONTAINER_NODE_ID_MISSING",
      context: { seedNodesConfigured: Boolean(containersEnv.seedNodes()) },
      severity: "fatal",
    });
  }
  const egressProxyUrl = process.env.CONTAINERS_EGRESS_PROXY_URL || undefined;
  // The DB ambassador's egress network (it reaches the tenant DB) + socat image.
  const dbEgressNetwork = process.env.APPS_DB_EGRESS_NETWORK || undefined;
  const ambassadorImage = process.env.APPS_DB_AMBASSADOR_IMAGE || undefined;
  const provider = new AppContainerProvider({
    ssh,
    nodeId,
    allocateHostPort,
    egressProxyUrl,
    dbEgressNetwork,
    ambassadorImage,
    nodeHost,
  });
  const store = new ContainerRepoAppContainerStore({
    readDatabase: dbRead,
    writeDatabase: dbWrite,
    repository: containersRepository,
    errorFactory: (message, options) => new ElizaError(message, options),
  });

  // Ingress route hooks — wired only when a Caddy admin URL is configured.
  // Otherwise routes are no-ops (the deploy still succeeds; the app just has no
  // public URL until ingress is set up). The reachability gate (#9853) is wired
  // alongside the route hooks: a public URL only exists to probe once there's an
  // ingress route to serve it, so an un-wired ingress skips the gate (no route =>
  // nothing to verify) rather than failing every deploy on an unroutable URL.
  const caddyAdminUrl = containersEnv.caddyAdminUrl();
  const ingress: Pick<
    ContainerExecutorDeps,
    "onRouteAdded" | "onRouteRemoved" | "probeAppReachable"
  > = caddyAdminUrl
    ? {
        onRouteAdded: (route) => addAppRoute({ ...route, adminBase: caddyAdminUrl }),
        onRouteRemoved: (route) => removeAppRoute({ ...route, adminBase: caddyAdminUrl }),
        probeAppReachable: (url) => waitForUrlReachable(url),
      }
    : {};

  logger.info("[container-executor-deps] built apps container backend", {
    nodeId,
    nodeHost,
    egressProxy: Boolean(egressProxyUrl),
    dbEgressNetwork: dbEgressNetwork ?? "bridge",
    ingress: Boolean(caddyAdminUrl),
  });
  return {
    provider,
    store,
    // Verified custom domains for the app -> bare hostnames, folded into the
    // ingress route's host-match. Reuses the existing CORS verified-origin query
    // (status='active' AND verified=true); only invoked when ingress is wired.
    listVerifiedAppHostnames: (appId) =>
      listVerifiedAppOrigins(appId).then((origins) =>
        origins.map((origin) => origin.replace(/^https?:\/\//, "").replace(/\/+$/, "")),
      ),
    markAppDeployed: async (appId, productionUrl) => {
      // App ids are UUIDs; a non-UUID project_name (a plain /v1/containers row,
      // which is not an app) is skipped so this never mis-updates or UUID-casts.
      if (!isValidUUID(appId)) return;
      await appsService.update(appId, {
        deployment_status: "deployed",
        production_url: productionUrl,
        last_deployed_at: new Date(),
      });
    },
    ...ingress,
  };
}
