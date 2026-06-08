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

import {
  ambassadorName,
  buildEnsureAmbassadorCmds,
  buildRemoveAmbassadorCmdForContainer,
  parseDsnEndpoint,
  rewriteDsnToAmbassador,
} from "./app-db-ambassador";
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
  /**
   * Network the DB ambassador uses to reach the tenant DB (its only egress).
   * Default `bridge`. The app container itself never joins this network.
   */
  dbEgressNetwork?: string;
  /** socat image for the DB ambassador. Defaults to the module default. */
  ambassadorImage?: string;
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

    // DB ambassador: the app is on an `--internal` net (no egress at all), so it
    // can't reach its tenant DB directly. Stand up a per-app socat forwarder on
    // the app net that reaches ONLY the tenant DB, and point the app's
    // DATABASE_URL at it. The app keeps zero general egress; REVOKE-CONNECT still
    // isolates the actual database. No DSN -> no ambassador (nothing to reach).
    let input = params.input;
    const dsn = input.environmentVars?.DATABASE_URL;
    const endpoint = dsn ? parseDsnEndpoint(dsn) : null;
    if (dsn && endpoint) {
      const cmds = buildEnsureAmbassadorCmds({
        appId: params.appId,
        network,
        db: endpoint,
        egressNetwork: this.deps.dbEgressNetwork,
        image: this.deps.ambassadorImage,
      });
      for (const cmd of cmds) {
        await this.deps.ssh.exec(cmd);
      }
      // Rewrite EVERY injected DSN var (DATABASE_URL + POSTGRES_URL) to the
      // ambassador host. They carry the same tenant DSN; an un-rewritten
      // POSTGRES_URL would point at the real cluster host, which is unreachable
      // from the app's --internal network.
      const ambHost = ambassadorName(params.appId);
      const rewritten: Record<string, string> = { ...input.environmentVars };
      for (const key of ["DATABASE_URL", "POSTGRES_URL"]) {
        const value = rewritten[key];
        if (value) rewritten[key] = rewriteDsnToAmbassador(value, ambHost);
      }
      input = { ...input, environmentVars: rewritten };
    }

    const hostPort = await this.deps.allocateHostPort();
    const createCmd = buildAppDockerCreateCmd({
      appId: params.appId,
      containerName: params.containerName,
      input,
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
    // Tear down the per-app DB ambassador too (best-effort; no-op if absent).
    await this.deps.ssh.exec(buildRemoveAmbassadorCmdForContainer(containerName));
  }

  async restart(containerName: string): Promise<void> {
    await this.deps.ssh.exec(`docker restart ${shellQuote(containerName)}`);
  }

  async logs(containerName: string, tail = 200): Promise<string> {
    return this.deps.ssh.exec(`docker logs --tail ${tail} ${shellQuote(containerName)}`);
  }
}
