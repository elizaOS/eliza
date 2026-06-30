/**
 * Parent-runtime wiring for the sub-agent credential bridge (#10317).
 *
 * Instantiates one `CredentialTunnelService` per parent runtime, builds the
 * bridge adapter, and registers it under BOTH well-known service names so:
 *   - the orchestrator's bridge routes resolve `SubAgentCredentialBridgeAdapter`
 *     (no more `503 no_adapter`), and
 *   - the core DECLARE/TUNNEL actions resolve `SubAgentCredentialBridge`.
 * It also registers `subAgentCredentialsPlugin` (the DECLARE/TUNNEL/AWAIT/
 * RETRIEVE actions) on the parent.
 *
 * GATING: parent (non-sandboxed) runtimes only. The bridge is meaningful only
 * where the orchestrator can spawn coding sub-agents, which is exactly where
 * the ACP subprocess service is registered. A sandboxed child runtime has no
 * ACP service, resolves no adapter, and degrades to the existing
 * "service unavailable" path.
 *
 * SECURITY: the scoped bearer token and credential values never leave the
 * tunnel service. The dispatch seam here returns identifiers only.
 */

import {
  type AgentRuntime,
  type IAgentRuntime,
  logger,
  Service,
  subAgentCredentialsPlugin,
} from "@elizaos/core";
import {
  type CredentialBridgeDispatch,
  createCredentialTunnelService,
  createSubAgentCredentialBridgeAdapter,
} from "../services/credential-tunnel-service.js";

/** Orchestrator subprocess service — the parent-capability gate. */
const ACP_SUBPROCESS_SERVICE = "ACP_SUBPROCESS_SERVICE";
const BRIDGE_ADAPTER_SERVICE = "SubAgentCredentialBridgeAdapter";
const BRIDGE_SERVICE = "SubAgentCredentialBridge";

/**
 * Register a ready singleton object as a runtime service under `serviceTypeName`
 * and force-start it so the synchronous `getService(name)` resolves it
 * immediately. The instance's own methods are projected onto a thin `Service`
 * subclass so callers that expect `Service & T` get a real Service instance.
 */
async function registerSingletonRuntimeService(
  runtime: IAgentRuntime,
  serviceTypeName: string,
  instance: object,
  capabilityDescription: string,
): Promise<void> {
  const cap = capabilityDescription;
  class SingletonRuntimeService extends Service {
    static serviceType = serviceTypeName;
    capabilityDescription = cap;
    async stop(): Promise<void> {}
    static async start(rt: IAgentRuntime): Promise<Service> {
      return Object.assign(new SingletonRuntimeService(rt), instance);
    }
  }
  await runtime.registerService(SingletonRuntimeService);
  // registerService is lazy; force the start so a synchronous getService() in a
  // loopback route sees the instance without awaiting.
  await runtime.getServiceLoadPromise(serviceTypeName);
}

/**
 * Wire the credential bridge onto a parent runtime. No-op (and safe to call
 * repeatedly across hot-reloads) on child/sandboxed runtimes or when already
 * registered.
 */
export async function registerSubAgentCredentialBridge(
  runtime: AgentRuntime,
): Promise<void> {
  // Parent gate: only runtimes that can host coding sub-agents.
  if (!runtime.hasService(ACP_SUBPROCESS_SERVICE)) return;
  // Idempotent: a hot-restart must not double-register the adapter or the
  // plugin's actions.
  if (runtime.hasService(BRIDGE_ADAPTER_SERVICE)) return;

  const tunnel = createCredentialTunnelService();
  const dispatch: CredentialBridgeDispatch = {
    async dispatch(input) {
      // The owner-facing inline render is posted to the origin task thread by
      // the orchestrator route layer (emitCredentialPrompt), which holds the
      // per-request origin metadata (roomId/source). Here we only correlate the
      // opened request with its one-shot scope. Identifiers only — never the
      // scoped token or a value.
      return { sensitiveRequestIds: [`cred_${input.credentialScopeId}`] };
    },
  };
  const adapter = createSubAgentCredentialBridgeAdapter({
    tunnel,
    dispatch,
    runtime,
  });

  await registerSingletonRuntimeService(
    runtime,
    BRIDGE_ADAPTER_SERVICE,
    adapter,
    "Sub-agent credential bridge adapter: scoped one-shot credential tunneling for coding sub-agents.",
  );
  await registerSingletonRuntimeService(
    runtime,
    BRIDGE_SERVICE,
    adapter,
    "Sub-agent credential bridge: declare a one-shot scope and tunnel a credential to a child session.",
  );

  // DECLARE/TUNNEL/AWAIT/RETRIEVE actions — parent runtime only. (AWAIT/RETRIEVE
  // resolve the decision-bus / results-client services, which are not wired
  // here and degrade cleanly to "service unavailable".)
  await runtime.registerPlugin(subAgentCredentialsPlugin);

  logger.info(
    "[sub-agent-credentials] credential bridge + actions registered on parent runtime",
  );
}
