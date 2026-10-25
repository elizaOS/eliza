/**
 * Pure `docker create` command assembly for a user app container (Apps /
 * Product 2). Mirrors the agent provider's flag-array style but composes the
 * apps-lane isolation posture: the per-app `--internal` network (U4), dropped
 * capabilities (U4), and an optional egress proxy — and deliberately OMITS the
 * agent-only bits (eliza volume mounts, `--add-host host.docker.internal`,
 * NET_ADMIN/tun). Reads no ambient env: any `DATABASE_URL` is the caller's
 * per-tenant DSN passed via `environmentVars`, never sourced here.
 *
 * Pure transport-plan assembly keeps the exact run posture unit-testable while
 * arbitrary environment bytes travel only on stdin; the impure provider owns
 * the corresponding `ssh.execStdin` call.
 */

import {
  appNetworkName,
  buildAppContainerSecurityFlags,
  buildAppEgressEnv,
} from "./app-network-utils";
import type { CreateContainerInput } from "./containers/hetzner-client/types";
import {
  buildDockerEnvFileStdinTransport,
  type DockerEnvFileStdinTransport,
  shellQuote,
  validateDockerEnvFileStdinEnvironment,
} from "./docker-sandbox-utils";

export interface BuildAppDockerCmdParams {
  appId: string;
  containerName: string;
  /** The provider input (image, port, memoryMb, env, healthCheckPath). */
  input: CreateContainerInput;
  /** Externally allocated host port mapped to the container's app port. */
  hostPort: number;
  /** When set, route container HTTP(S) egress through this proxy. */
  egressProxyUrl?: string;
  pidsLimit?: number;
}

function appHealthCmd(port: number, path: string): string {
  return `curl -fsS http://localhost:${port}${path} || exit 1`;
}

function buildAppDockerEnvironment(
  input: CreateContainerInput,
  egressProxyUrl?: string,
): Record<string, string> {
  const egress = egressProxyUrl ? buildAppEgressEnv(egressProxyUrl) : {};
  // Default PORT, then caller env (may override PORT), then infra egress (wins).
  return {
    PORT: String(input.port),
    ...input.environmentVars,
    ...egress,
  };
}

/** Validate the exact environment frame before the provider mutates remote state. */
export function validateAppDockerEnvironment(
  input: CreateContainerInput,
  egressProxyUrl?: string,
): void {
  validateDockerEnvFileStdinEnvironment(buildAppDockerEnvironment(input, egressProxyUrl));
}

/** Build the stdin-backed `docker create` plan for an isolated app container. */
export function buildAppDockerCreateCmd(
  params: BuildAppDockerCmdParams,
): DockerEnvFileStdinTransport {
  const { input } = params;
  const network = appNetworkName(params.appId);
  const security = buildAppContainerSecurityFlags({ pidsLimit: params.pidsLimit });
  const allEnv = buildAppDockerEnvironment(input, params.egressProxyUrl);

  return buildDockerEnvFileStdinTransport(allEnv, (envFilePath) =>
    [
      "docker create",
      `--name ${shellQuote(params.containerName)}`,
      "--restart unless-stopped",
      `--network ${shellQuote(network)}`,
      ...security,
      `--health-cmd ${shellQuote(appHealthCmd(input.port, input.healthCheckPath ?? "/health"))}`,
      "--health-interval 10s",
      "--health-timeout 5s",
      "--health-start-period 15s",
      "--health-retries 6",
      ...(input.memoryMb
        ? [
            `--memory ${shellQuote(`${Math.ceil(input.memoryMb)}m`)}`,
            // Pin swap to the memory limit (i.e. no swap) so an untrusted image
            // can't escape the --memory ceiling via swap on the shared node.
            `--memory-swap ${shellQuote(`${Math.ceil(input.memoryMb)}m`)}`,
          ]
        : []),
      // Hard CPU cap. `cpu` is ECS-style units (1024 = 1 vCPU), the same unit
      // docker's --cpus takes once divided. Without this an untrusted tenant image
      // can pin every core on the shared node and starve every co-tenant app (a
      // cross-tenant availability break) — the dedicated-vCPU node sizing alone
      // does NOT prevent in-node CPU theft.
      ...(input.cpu > 0 ? [`--cpus ${input.cpu / 1024}`] : []),
      // Publish to loopback only: the node-local Caddy reverse-proxies to
      // 127.0.0.1:hostPort, so the port must NOT be reachable across the shared
      // private network (binding 0.0.0.0 would let any other node/container hit
      // this tenant's app directly — a cross-tenant ingress bypass).
      `-p 127.0.0.1:${params.hostPort}:${input.port}`,
      `--env-file ${envFilePath}`,
      shellQuote(input.image),
    ]
      .filter((part) => part.length > 0)
      .join(" "),
  );
}
