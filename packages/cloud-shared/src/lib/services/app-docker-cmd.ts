/**
 * Pure `docker create` command assembly for a user app container (Apps /
 * Product 2). Mirrors the agent provider's flag-array style but composes the
 * apps-lane isolation posture: the per-app `--internal` network (U4), dropped
 * capabilities (U4), and an optional egress proxy — and deliberately OMITS the
 * agent-only bits (eliza volume mounts, `--add-host host.docker.internal`,
 * NET_ADMIN/tun). Reads no ambient env: any `DATABASE_URL` is the caller's
 * per-tenant DSN passed via `environmentVars`, never sourced here.
 *
 * Pure string assembly so the exact run posture is a unit-testable contract;
 * the real `ssh.exec` of this command lives in the (impure) provider.
 */

import {
  appNetworkName,
  buildAppContainerSecurityFlags,
  buildAppEgressEnv,
} from "./app-network-utils";
import type { CreateContainerInput } from "./containers/hetzner-client/types";
import { shellQuote } from "./docker-sandbox-utils";

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

/** Build the `docker create` command for an isolated app container. */
export function buildAppDockerCreateCmd(params: BuildAppDockerCmdParams): string {
  const { input } = params;
  const network = appNetworkName(params.appId);
  const security = buildAppContainerSecurityFlags({ pidsLimit: params.pidsLimit });
  const egress = params.egressProxyUrl ? buildAppEgressEnv(params.egressProxyUrl) : {};

  // Default PORT, then caller env (may override PORT), then infra egress (wins).
  const allEnv: Record<string, string> = {
    PORT: String(input.port),
    ...input.environmentVars,
    ...egress,
  };
  const envFlags = Object.entries(allEnv)
    .map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`)
    .join(" ");

  return [
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
    ...(input.memoryMb ? [`--memory ${shellQuote(`${Math.ceil(input.memoryMb)}m`)}`] : []),
    `-p ${params.hostPort}:${input.port}`,
    envFlags,
    shellQuote(input.image),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}
