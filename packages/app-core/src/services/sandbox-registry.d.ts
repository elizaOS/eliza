/**
 * SandboxRegistry — self-registers the sandbox container in the shared
 * Upstash Redis so the multi-tenant gateways (`gateway-discord`,
 * `gateway-webhook`) can resolve `agent_id → server URL` and forward inbound
 * platform messages here.
 *
 * Two Redis keys are written with a short TTL; a periodic heartbeat refreshes
 * the TTL while the sandbox is alive, and `unregister()` deletes them on
 * graceful shutdown if they still point at this sandbox. If the container
 * crashes, the keys expire naturally and the gateways stop routing to a dead
 * address.
 *
 *   server:<serverName>:url = <serverUrl>   (resolver address)
 *   agent:<agentId>:server  = <serverName>  (agent → server pointer)
 *
 * The write pattern mirrors `packages/cloud-services/agent-server/src/agent-manager.ts:refreshRedisState`
 * but is stripped to a single-tenant sandbox: one agent, one server, no
 * capacity bookkeeping.
 */
export interface SandboxRegistryConfig {
  redisUrl: string;
  redisToken: string;
  agentId: string;
  serverName: string;
  serverUrl: string;
  /** TTL for both Redis keys in seconds. Keep this at least 3x the heartbeat interval so one missed tick does not expire a healthy sandbox. */
  ttlSeconds: number;
}
export declare class SandboxRegistry {
  private readonly config;
  private readonly redis;
  private heartbeatTimer;
  constructor(config: SandboxRegistryConfig);
  register(): Promise<void>;
  refresh(): Promise<void>;
  unregister(): Promise<void>;
  startHeartbeat(intervalMs: number): void;
  stopHeartbeat(): void;
  /**
   * Atomic two-key write via Upstash pipeline. Both keys must succeed
   * together — partial state would let gateways resolve `agent:X:server` to
   * a stale `server:Y:url` value or miss a routing entry whose other half
   * was just renewed.
   */
  private writeKeys;
}
/**
 * Reads the SANDBOX_REGISTRY_* and SANDBOX_* env vars and returns a fully
 * wired `SandboxRegistry`, or `null` if the sandbox context is not
 * configured (e.g. local dev, non-Hetzner deployment). Caller must call
 * `register()` and `startHeartbeat(...)` after a successful boot.
 */
export declare function buildSandboxRegistryFromEnv(
  env?: NodeJS.ProcessEnv,
  ttlSeconds?: number,
): SandboxRegistry | null;
//# sourceMappingURL=sandbox-registry.d.ts.map
