export interface SandboxProvider {
  create(config: SandboxCreateConfig): Promise<SandboxHandle>;
  stop(sandboxId: string): Promise<void>;
  checkHealth(handle: SandboxHandle): Promise<boolean>;
  runCommand?(sandboxId: string, cmd: string, args?: string[]): Promise<string>;
  /** Tail container logs from the sandbox runtime (e.g. `docker logs --tail N`). */
  fetchLogs?(sandboxId: string, tail: number): Promise<string>;
}

export interface SandboxHandle {
  sandboxId: string;
  bridgeUrl: string;
  healthUrl: string;
  metadata?: Record<string, unknown>;
}

export interface SandboxCreateConfig {
  agentId: string;
  agentName: string;
  organizationId: string;
  environmentVars: Record<string, string>;
  snapshotId?: string;
  resources?: { vcpus?: number; memoryMb?: number };
  timeout?: number;
  dockerImage?: string;
  /**
   * Skip this node when selecting where to place the new container.
   * Used by the fleet-upgrade handler to force a blue/green swap onto a
   * *different* node than the one the agent is currently on.
   */
  excludeNodeId?: string;
}
