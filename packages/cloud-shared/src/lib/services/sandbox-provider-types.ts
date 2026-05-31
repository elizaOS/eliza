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
  /**
   * Full character config for this agent (the `agent_sandboxes.agent_config`
   * row). When present, the provider injects it as ELIZA_AGENT_CHARACTER_JSON
   * so the container boots AS this character instead of the bundled default
   * preset. See packages/agent/src/runtime/sandbox-character.ts.
   */
  agentConfig?: Record<string, unknown> | null;
  /**
   * The platform character_id used by the gateways to route inbound messages
   * (`agent:<id>:server` / `/agents/<id>/message`). Injected as
   * SANDBOX_ROUTE_AGENT_ID so the container registers under, and answers as,
   * this id (NOT the sandbox id). When absent the runtime keeps its prior
   * name-derived agent id and the sandbox falls back to keying the registry
   * by SANDBOX_AGENT_ID.
   */
  routeAgentId?: string | null;
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
