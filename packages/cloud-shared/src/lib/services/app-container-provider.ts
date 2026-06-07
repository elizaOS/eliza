/**
 * App container provider (Apps / Product 2) — the thin, app-only orchestrator
 * that runs an isolated user container on a node. It composes the pure builders
 * (network ensure + docker-create + isolation flags) and drives them over an
 * injected SSH seam, so the orchestration is unit-testable with a fake SSH and
 * the real `ssh.exec` is the only IO.
 *
 * Deliberately NOT a subclass of DockerSandboxProvider and NOT coupled to the
 * `containers` table here — recording the row is the job executor's concern
 * (kept out so this stays decoupled from 2AM's container schema/repo). No eliza
 * scaffolding, no shared network, no NET_ADMIN.
 */

import { buildAppDockerCreateCmd } from "./app-docker-cmd";
import { appNetworkName, buildEnsureAppNetworkCmd } from "./app-network-utils";
import type { CreateContainerInput } from "./containers/hetzner-client/types";
import { shellQuote } from "./docker-sandbox-utils";

/** Minimal SSH seam — runs a command on the target node and returns stdout. */
export interface AppContainerSsh {
  exec(command: string, timeoutMs?: number): Promise<string>;
}

export interface AppContainerProviderDeps {
  ssh: AppContainerSsh;
  /** Allocate an external host port to map to the container's app port. */
  allocateHostPort: () => Promise<number>;
  /** Optional egress proxy URL routed into the container. */
  egressProxyUrl?: string;
  pidsLimit?: number;
  /** Parse the container id from `docker create` stdout. */
  extractContainerId?: (dockerCreateStdout: string) => string;
}

export interface ProvisionAppContainerParams {
  appId: string;
  containerName: string;
  input: CreateContainerInput;
}

export interface ProvisionedAppContainer {
  containerId: string;
  hostPort: number;
  network: string;
}

function defaultExtractContainerId(stdout: string): string {
  const last = stdout.trim().split("\n").pop()?.trim() ?? "";
  return last;
}

export class AppContainerProvider {
  private readonly deps: AppContainerProviderDeps;

  constructor(deps: AppContainerProviderDeps) {
    this.deps = deps;
  }

  /** Ensure the per-app `--internal` network, create the container, start it. */
  async provision(params: ProvisionAppContainerParams): Promise<ProvisionedAppContainer> {
    const network = appNetworkName(params.appId);
    await this.deps.ssh.exec(buildEnsureAppNetworkCmd(network));

    const hostPort = await this.deps.allocateHostPort();
    const createCmd = buildAppDockerCreateCmd({
      appId: params.appId,
      containerName: params.containerName,
      input: params.input,
      hostPort,
      egressProxyUrl: this.deps.egressProxyUrl,
      pidsLimit: this.deps.pidsLimit,
    });

    const stdout = await this.deps.ssh.exec(createCmd);
    const containerId = (this.deps.extractContainerId ?? defaultExtractContainerId)(stdout);
    await this.deps.ssh.exec(`docker start ${shellQuote(params.containerName)}`);

    return { containerId, hostPort, network };
  }

  async delete(containerName: string): Promise<void> {
    await this.deps.ssh.exec(`docker rm -f ${shellQuote(containerName)}`);
  }

  async restart(containerName: string): Promise<void> {
    await this.deps.ssh.exec(`docker restart ${shellQuote(containerName)}`);
  }

  async logs(containerName: string, tail = 200): Promise<string> {
    return this.deps.ssh.exec(`docker logs --tail ${tail} ${shellQuote(containerName)}`);
  }
}
